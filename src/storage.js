const { Storage } = require('@google-cloud/storage');
const { BigQuery } = require('@google-cloud/bigquery');
const { format } = require('date-fns');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// Initialize Cloud Clients (only if needed/configured to avoid errors in VM without creds)
let storage, bigquery;
if (config.STORAGE_TYPE === 'gcs') {
    try {
        storage = new Storage();
        bigquery = new BigQuery();
    } catch (e) {
        console.warn('Could not initialize Google Cloud clients. Ensure credentials are set if using GCS.');
    }
}

// Helper to get today's date path in UTC: YYYY-MM-DD
const getTodayDateString = () => new Date().toISOString().split('T')[0];

/**
 * Appends data to Storage (GCS or Local)
 */
async function appendToGCS(record) {
    const dateStr = record.ts ? record.ts.split('T')[0] : getTodayDateString();
    const safeIp = record.ip.replace(/[^a-zA-Z0-9.:-]/g, '_');
    const filename = `${Date.now()}-${record.run_id}-${Math.floor(Math.random() * 1000)}.json`;

    if (config.STORAGE_TYPE === 'local') {
        // LOCAL STORAGE IMPLEMENTATION
        const dir = path.join(config.LOCAL_DATA_DIR, 'ips', dateStr, safeIp);
        const filePath = path.join(dir, filename);

        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filePath, JSON.stringify(record));
        } catch (err) {
            console.error('Error writing to Local Storage:', err);
        }

    } else {
        // GCS STORAGE IMPLEMENTATION
        if (!config.BUCKET_NAME || !storage) {
            console.warn('BUCKET_NAME not set or Storage not init, skipping GCS write.');
            return;
        }

        const bucket = storage.bucket(config.BUCKET_NAME);
        const gcsPath = `ips/${dateStr}/${safeIp}/${filename}`;
        const file = bucket.file(gcsPath);

        try {
            await file.save(JSON.stringify(record));
        } catch (err) {
            console.error('Error writing to GCS:', err);
        }
    }
}

/**
 * Inserts data into BigQuery (Streaming)
 * (Only works if Cloud creds are available, even in VM mode if configured)
 */
async function insertIntoBigQuery(record) {
  if (!bigquery) return; // Skip if BQ not init

  try {
    const row = {
      account: record.account,
      repo: record.repo,
      run_id: record.run_id,
      job: record.job,
      ip: record.ip,
      ts: bigquery.datetime(record.ts),
      country: record.country || null,
      asn: record.asn || null,
    };

    await bigquery
      .dataset(config.DATASET_ID)
      .table(config.TABLE_ID)
      .insert([row]);

  } catch (err) {
    if (err.code !== 404) {
       console.error('BigQuery Insert Error:', JSON.stringify(err.errors || err));
    }
  }
}

/**
 * Reads all records for a specific IP for "today".
 */
async function getRecordsForIpToday(ip) {
  const dateStr = getTodayDateString();
  const safeIp = ip.replace(/[^a-zA-Z0-9.:-]/g, '_');

  const records = [];

  if (config.STORAGE_TYPE === 'local') {
      // LOCAL READ
      const dir = path.join(config.LOCAL_DATA_DIR, 'ips', dateStr, safeIp);
      if (!fs.existsSync(dir)) return [];

      try {
          const files = fs.readdirSync(dir);
          for (const file of files) {
              if (file.endsWith('.json')) {
                  const content = fs.readFileSync(path.join(dir, file));
                  records.push(JSON.parse(content));
              }
          }
      } catch (err) {
          console.error('Error reading Local Storage:', err);
      }

  } else {
      // GCS READ
      if (!config.BUCKET_NAME || !storage) return [];
      const bucket = storage.bucket(config.BUCKET_NAME);
      const prefix = `ips/${dateStr}/${safeIp}/`;

      try {
        const [files] = await bucket.getFiles({ prefix });
        const READ_CONCURRENCY = 50;
        for (let i = 0; i < files.length; i += READ_CONCURRENCY) {
            const chunk = files.slice(i, i + READ_CONCURRENCY);
            await Promise.all(chunk.map(async (file) => {
                try {
                    const [content] = await file.download();
                    records.push(JSON.parse(content.toString()));
                } catch (e) {}
            }));
        }
      } catch (err) {
        console.error('Error reading GCS for Gate:', err);
      }
  }

  return records;
}

/**
 * Deletes files older than RETENTION_HOURS
 */
async function cleanupGCS() {
    const retentionMs = config.RETENTION_HOURS * 60 * 60 * 1000;
    const now = Date.now();

    if (config.STORAGE_TYPE === 'local') {
        // LOCAL CLEANUP (Recursive walk)
        // Simplified: Walk ips/ dir.
        // Optimization: In real prod, checking every file is slow.
        // We will just check the 'ips/' folder.

        async function walk(dir) {
            const list = fs.readdirSync(dir);
            list.forEach(file => {
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);
                if (stat && stat.isDirectory()) {
                    walk(filePath);
                    // Remove empty directories
                    if (fs.readdirSync(filePath).length === 0) {
                        fs.rmdirSync(filePath);
                    }
                } else {
                    // It's a file
                    if (now - stat.birthtimeMs > retentionMs) {
                        fs.unlinkSync(filePath);
                        console.log(`Deleted expired local file: ${filePath}`);
                    }
                }
            });
        }

        try {
            if (fs.existsSync(path.join(config.LOCAL_DATA_DIR, 'ips'))) {
                 walk(path.join(config.LOCAL_DATA_DIR, 'ips'));
            }
        } catch (e) {
            console.error('Local cleanup error:', e);
        }

    } else {
        // GCS CLEANUP
        if (!config.BUCKET_NAME || !storage) return;
        const bucket = storage.bucket(config.BUCKET_NAME);
        try {
            const [files] = await bucket.getFiles();
            const deletePromises = files.map(async (file) => {
                const [metadata] = await file.getMetadata();
                const createdTime = new Date(metadata.timeCreated).getTime();
                if (now - createdTime > retentionMs) {
                    await file.delete();
                }
            });
            await Promise.all(deletePromises);
        } catch (err) {
            console.error('Error during GCS cleanup:', err);
        }
    }
}

module.exports = {
  appendToGCS, // Rename suggestion: saveRecord (but keeping name for diff consistency)
  insertIntoBigQuery,
  getRecordsForIpToday,
  cleanupGCS
};
