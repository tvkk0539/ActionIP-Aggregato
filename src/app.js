const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios'); // For external sink
const config = require('./config');
const storage = require('./storage');
const { differenceInHours, differenceInMinutes, parseISO } = require('date-fns');

const app = express();

// Middleware: Raw body for HMAC signature verification
app.use(bodyParser.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Middleware: Auth & Security
const verifyAuth = (req, res, next) => {
  // 1. Bearer Token Verification
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = authHeader.split(' ')[1];
  if (token !== config.COLLECTOR_TOKEN) {
    return res.status(403).json({ error: 'Invalid Token' });
  }

  // 2. Optional HMAC Verification
  if (config.HMAC_SECRET && req.headers['x-signature']) {
    const signature = req.headers['x-signature'];
    const hmac = crypto.createHmac('sha256', config.HMAC_SECRET);
    hmac.update(req.rawBody);
    const expectedSignature = hmac.digest('base64');

    if (signature !== expectedSignature) {
      return res.status(401).json({ error: 'Invalid HMAC Signature' });
    }
  }

  next();
};

app.use(verifyAuth);

/**
 * POST /ingest
 * Receives IP data, stores in GCS/BQ, forwards to external sink.
 */
app.post('/ingest', async (req, res) => {
  try {
    const record = req.body;

    // Basic validation
    if (!record.ip || !record.run_id) {
        return res.status(400).json({ error: 'Missing required fields: ip, run_id' });
    }

    // 1. Store in GCS
    // We don't await this to keep response fast?
    // Actually, for safety, let's await. Cloud Run scales well.
    await storage.appendToGCS(record);

    // 2. Store in BigQuery (Optional)
    // We execute this concurrently without waiting (fire-and-forget style) or await if critical.
    // The prompt implies we should just do it.
    storage.insertIntoBigQuery(record).catch(err => console.error('BQ Background Error', err));

    // 3. External Sink (Optional)
    if (config.EXTERNAL_SINK_URL) {
       axios.post(config.EXTERNAL_SINK_URL, record, {
           headers: {
               'Authorization': `Bearer ${config.EXTERNAL_SINK_TOKEN || ''}`,
               'Content-Type': 'application/json'
           }
       }).catch(err => console.error('External Sink Error:', err.message));
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * POST /gate
 * Decides if a run should proceed based on IP usage policies.
 */
app.post('/gate', async (req, res) => {
  const { ip, ts } = req.body;

  // Default response (Fail Open)
  const result = {
      should_run: true,
      duplicates: 0,
      reason: '',
      uses_today: 0,
      last_use_utc: null
  };

  try {
      if (!ip) throw new Error('No IP provided');

      // 1. Get all records for this IP today
      const records = await storage.getRecordsForIpToday(ip);

      // Sort by timestamp descending (newest first).
      // If timestamps are identical, sort by run_id to ensure deterministic order (Tie-breaker).
      // This ensures that in a concurrent batch, one is always "first".
      records.sort((a, b) => {
          const timeDiff = new Date(b.ts) - new Date(a.ts);
          if (timeDiff !== 0) return timeDiff;
          return a.run_id.localeCompare(b.run_id);
      });

      result.uses_today = records.length;
      result.last_use_utc = records.length > 0 ? records[0].ts : null;

      const currentRequestTime = ts ? parseISO(ts) : new Date();

      // --- ROBUST FILTERING LOGIC ---
      // We must determine the list of "Valid Runs" based on the gap policy *chronologically*.
      // 1. Sort records Oldest -> Newest (ascending) to simulate history replay.
      // 2. Walk through and accept a run ONLY if it is >= 7h after the last accepted run.
      // 3. This filters out duplicates and gap violators naturally.

      // Copy and sort ascending
      const chronRecords = [...records].sort((a, b) => {
          const timeDiff = new Date(a.ts) - new Date(b.ts);
          if (timeDiff !== 0) return timeDiff;
          return a.run_id.localeCompare(b.run_id); // Stable tie-break
      });

      const validRuns = [];
      let lastValidTs = null;

      for (const rec of chronRecords) {
          if (!lastValidTs) {
              validRuns.push(rec);
              lastValidTs = parseISO(rec.ts);
          } else {
              const thisTs = parseISO(rec.ts);
              const gap = differenceInHours(thisTs, lastValidTs);
              // Note: differenceInHours rounds down. We might want exact diff?
              // Assuming standard integer hours policy.
              // If gap >= 7, accept.
              if (gap >= config.MIN_GAP_HOURS_PER_IP) {
                   validRuns.push(rec);
                   lastValidTs = thisTs;
              }
              // Else: It's skipped (Duplicate or too soon)
          }
      }

      // Now we have the list of runs that "should" have passed.
      // Check if *this* request (run_id) is in that list.
      const myRunId = req.body.run_id;
      const isValid = validRuns.some(r => r.run_id === myRunId);


      // 1. Check if I was filtered out by Gap Logic
      if (!isValid) {
          result.should_run = false;
          result.reason = 'gap_not_satisfied';
          // (It could be a concurrent duplicate or a <7h retry)
          return res.json(result);
      }

      // 2. Check if I exceed Max Runs (based on my position in the VALID list)
      // I am valid, but am I the 4th valid run?
      // Find my index in validRuns
      const myValidIndex = validRuns.findIndex(r => r.run_id === myRunId);

      if (myValidIndex >= config.MAX_RUNS_PER_IP_PER_DAY) {
          result.should_run = false;
          result.reason = 'max_runs_reached';
          return res.json(result);
      }

      // If I passed both checks
      result.should_run = true;
      // Special case: If records.length is 1, it's the first run today (or the one we just added).
      // No gap check needed against "nothing".

      // Additional Check: "Concurrent Duplicates" from the FIRST prompt (optional but good to have?)
      // The second prompt emphasizes 3x/7h. We stick to that.

      // 1. Send answer to GitHub IMMEDIATELY (Zero Latency)
      res.json(result);

      // 2. Fire-and-Forget Notification to Discord (Background)
      if (config.DISCORD_WEBHOOK_URL) {
          sendDiscordNotification(result, ip);
      }

  } catch (err) {
      console.error('Gate Error:', err);
      // Fail Open
      res.json({ ...result, should_run: true, reason: 'error_fail_open' });
  }
});

/**
 * Helper: Send Discord Notification (Async)
 */
function sendDiscordNotification(result, ip, uniqueIpCount) {
    const isAllowed = result.should_run;
    const color = isAllowed ? 5763719 : 15548997; // Green (5763719) or Red (15548997)
    const title = isAllowed ? "🚀 Job Allowed" : "🛑 Job Blocked";

    const fields = [
        { name: "IP Address", value: ip, inline: true },
        { name: "Reason", value: result.reason || "Policy Check Passed", inline: true },
        { name: "Runs for this IP", value: `${result.uses_today}`, inline: true }
    ];

    if (uniqueIpCount !== null) {
        fields.push({ name: "Total Unique IPs Today", value: `${uniqueIpCount}`, inline: true });
    }

    // Don't await this. Let it run in background.
    axios.post(config.DISCORD_WEBHOOK_URL, {
        embeds: [{
            title: title,
            color: color,
            fields: fields,
            footer: { text: "ActionIP Aggregator" },
            timestamp: new Date().toISOString()
        }]
    }).catch(err => {
        // Silently fail or log lightweight error so we don't spam logs
        // console.error('Discord Notification Failed:', err.message);
    });
}

/**
 * POST /cleanup
 * Triggered by Cloud Scheduler
 */
app.post('/cleanup', async (req, res) => {
    try {
        await storage.cleanupGCS();
        // BQ cleanup could go here if using SQL deletion
        res.status(200).json({ status: 'cleanup initiated' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'cleanup failed' });
    }
});

/**
 * GET /summary
 * Simple stats for today
 */
app.get('/summary', async (req, res) => {
    // This would require listing ALL files for today, which might be heavy.
    // For now, return a placeholder or simple bucket stats if easy.
    // Given the "read all files" architecture in storage.js, implementing a full summary
    // over all IPs is expensive (O(N) files).
    // We will return a simple message or implement if strictly needed.
    res.json({ message: 'Summary requires listing all daily files. Not fully implemented for performance reasons.' });
});

module.exports = app;
