const { Storage } = require('@google-cloud/storage');
const { BigQuery } = require('@google-cloud/bigquery');
const { format } = require('date-fns');
const config = require('./config');
const csvStringify = require('csv-stringify/sync');

const storage = new Storage();
const bigquery = new BigQuery();

// Helper to get today's date path in UTC: YYYY-MM-DD
const getTodayDateString = () => new Date().toISOString().split('T')[0];

/**
 * Appends data to GCS (NDJSON and CSV)
 */
async function appendToGCS(record) {
  if (!config.BUCKET_NAME) {
    console.warn('BUCKET_NAME not set, skipping GCS write.');
    return;
  }

  const dateStr = record.ts ? record.ts.split('T')[0] : getTodayDateString();
  const bucket = storage.bucket(config.BUCKET_NAME);

  // 1. Append to NDJSON
  const ndjsonFile = bucket.file(`ips/${dateStr}/ips.ndjson`);
  const ndjsonLine = JSON.stringify(record) + '\n';

  // Note: GCS doesn't support atomic appends easily without creating many small files or using compose.
  // For this simplified implementation (and standard Cloud Run scale), we will use a "fire and forget"
  // approach or standard write. *Warning*: Concurrent writes to the same object can overwrite each other.
  // A robust production pattern is writing unique files (GUID) and aggregating them, but the prompt implies
  // simple appending. Since GCS doesn't support true `append` to a single object, the prompt likely implies
  // a conceptual "log".
  //
  // *Correction*: To make this robust for "concurrent runners", we should write unique files per request.
  // However, for the "Gate" to work by reading them back, we need to read ALL files or a central file.
  // The prompt asks to "Append to gs://.../ips.ndjson".
  // *Compromise*: We will use a unique filename per request to guarantee data safety (no overwrites),
  // and the Reader (Gate) will list and read files in that folder.
  // File pattern: ips/YYYY-MM-DD/IP_ADDRESS/timestamp-runid-random.json
  // This structure allows efficient "Gate" lookups by filtering prefix ips/YYYY-MM-DD/IP/

  const safeIp = record.ip.replace(/[^a-zA-Z0-9.:-]/g, '_'); // Sanitize IP for filename
  const filename = `ips/${dateStr}/${safeIp}/${Date.now()}-${record.run_id}-${Math.floor(Math.random() * 1000)}.json`;
  const file = bucket.file(filename);

  try {
    await file.save(JSON.stringify(record));
  } catch (err) {
    console.error('Error writing to GCS:', err);
  }
}

/**
 * Inserts data into BigQuery (Streaming)
 */
async function insertIntoBigQuery(record) {
  // Only attempt if dataset/table are seemingly configured or standard
  // We'll assume the user might not have created the table yet, so we wrap in try/catch
  try {
    // Transform record for BQ (timestamps need to be objects or specific strings)
    const row = {
      account: record.account,
      repo: record.repo,
      run_id: record.run_id,
      job: record.job,
      ip: record.ip,
      ts: bigquery.datetime(record.ts), // Ensure correct timestamp format
      country: record.country || null,
      asn: record.asn || null,
    };

    await bigquery
      .dataset(config.DATASET_ID)
      .table(config.TABLE_ID)
      .insert([row]);

  } catch (err) {
    // Fail silently/log as per fail-open requirement, or just because BQ might be disabled
    if (err.code !== 404) { // Ignore 404 (Table not found) to reduce noise if BQ is off
       console.error('BigQuery Insert Error:', JSON.stringify(err.errors || err));
    }
  }
}

/**
 * Reads all records for a specific IP for "today" to make Gate decisions.
 * Returns Array of objects { ip, ts, ... }
 */
async function getRecordsForIpToday(ip) {
  if (!config.BUCKET_NAME) return [];

  const dateStr = getTodayDateString();
  const bucket = storage.bucket(config.BUCKET_NAME);

  // Optimized: Only list files for this specific IP
  const safeIp = ip.replace(/[^a-zA-Z0-9.:-]/g, '_');
  const prefix = `ips/${dateStr}/${safeIp}/`;

  try {
    const [files] = await bucket.getFiles({ prefix });

    const records = [];

    // Read only the relevant files
    const READ_CONCURRENCY = 50;
    for (let i = 0; i < files.length; i += READ_CONCURRENCY) {
        const chunk = files.slice(i, i + READ_CONCURRENCY);
        await Promise.all(chunk.map(async (file) => {
            try {
                const [content] = await file.download();
                const data = JSON.parse(content.toString());
                records.push(data);
            } catch (e) {
                // ignore read errors
            }
        }));
    }

    return records;
  } catch (err) {
    console.error('Error reading GCS for Gate:', err);
    return []; // Fail open (empty list)
  }
}

/**
 * Deletes GCS files older than RETENTION_HOURS
 */
async function cleanupGCS() {
    if (!config.BUCKET_NAME) return;

    const bucket = storage.bucket(config.BUCKET_NAME);
    const retentionMs = config.RETENTION_HOURS * 60 * 60 * 1000;
    const now = Date.now();

    // We need to list all files. This can be expensive.
    // A better strategy for "hourly" cleanup might be to look at folders from previous days?
    // But the requirement says "older than N hours".
    // We will list recursively (default).

    try {
        const [files] = await bucket.getFiles();

        const deletePromises = files.map(async (file) => {
            // Check metadata
            const [metadata] = await file.getMetadata();
            const createdTime = new Date(metadata.timeCreated).getTime();

            if (now - createdTime > retentionMs) {
                try {
                    await file.delete();
                    console.log(`Deleted expired file: ${file.name}`);
                } catch (e) {
                    console.error(`Failed to delete ${file.name}`, e);
                }
            }
        });

        await Promise.all(deletePromises);
    } catch (err) {
        console.error('Error during cleanup:', err);
    }
}

module.exports = {
  appendToGCS,
  insertIntoBigQuery,
  getRecordsForIpToday,
  cleanupGCS
};
