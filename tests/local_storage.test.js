const request = require('supertest');
const app = require('../src/app');
const config = require('../src/config');
const fs = require('fs');
const path = require('path');

// Mock GCS/BigQuery to avoid them being called in local tests
jest.mock('@google-cloud/storage');
jest.mock('@google-cloud/bigquery');

describe('Local Storage Tests', () => {
  const token = 'test-token-local';
  const validHeaders = { 'Authorization': `Bearer ${token}` };
  const testDataDir = path.join(__dirname, 'test-data');

  beforeAll(() => {
    config.COLLECTOR_TOKEN = token;
    config.STORAGE_TYPE = 'local';
    config.LOCAL_DATA_DIR = testDataDir;

    // Clean start
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    // Cleanup
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  it('should write file to local disk on /ingest', async () => {
    const res = await request(app)
      .post('/ingest')
      .set(validHeaders)
      .send({ ip: '192.168.1.1', run_id: 'local-1', ts: new Date().toISOString() });

    expect(res.status).toBe(200);

    // Verify file existence
    const today = new Date().toISOString().split('T')[0];
    const safeIp = '192.168.1.1'; // dots are allowed in our regex
    const dir = path.join(testDataDir, 'ips', today, safeIp);

    expect(fs.existsSync(dir)).toBe(true);
    const files = fs.readdirSync(dir);
    expect(files.length).toBe(1);
  });

  it('should read from local disk on /gate', async () => {
    // In local mode, we must send the SAME run_id we just wrote,
    // or else the logic thinks we are a "new" run (which is missing from disk? no, we assume ingest first).
    // The previous test wrote 'local-1'.

    const res = await request(app)
      .post('/gate')
      .set(validHeaders)
      .send({ ip: '192.168.1.1', ts: new Date().toISOString(), run_id: 'local-1' });

    expect(res.body.should_run).toBe(true);
  });
});
