require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 8080,
  // Security
  COLLECTOR_TOKEN: process.env.COLLECTOR_TOKEN, // Required Bearer token
  HMAC_SECRET: process.env.HMAC_SECRET, // Optional HMAC secret

  // Storage
  STORAGE_TYPE: process.env.STORAGE_TYPE || 'gcs', // 'gcs' or 'local'
  LOCAL_DATA_DIR: process.env.LOCAL_DATA_DIR || './data', // For local storage
  BUCKET_NAME: process.env.BUCKET_NAME,
  PROJECT_ID: process.env.PROJECT_ID, // Useful for BigQuery
  DATASET_ID: process.env.DATASET_ID || 'ip_data', // Default BQ Dataset
  TABLE_ID: process.env.TABLE_ID || 'ip_observations', // Default BQ Table

  // Policies
  MAX_RUNS_PER_IP_PER_DAY: parseInt(process.env.MAX_RUNS_PER_IP_PER_DAY || '3', 10),
  MIN_GAP_HOURS_PER_IP: parseInt(process.env.MIN_GAP_HOURS_PER_IP || '7', 10),

  // Retention
  RETENTION_HOURS: parseInt(process.env.RETENTION_HOURS || '24', 10),
  RETENTION_WINDOW_MINUTES: parseInt(process.env.RETENTION_WINDOW_MINUTES || '5', 10),

  // External Sink (Optional)
  EXTERNAL_SINK_URL: process.env.EXTERNAL_SINK_URL,
  EXTERNAL_SINK_TOKEN: process.env.EXTERNAL_SINK_TOKEN,
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,

  // Misc
  TIMEZONE_UTC: true, // Always enforce UTC for consistency
};
