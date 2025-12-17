const request = require('supertest');
const app = require('../src/app');
const config = require('../src/config');
const fs = require('fs');
const path = require('path');

// Mock storage clients for speed, but use Real Local Storage logic for this test
jest.mock('@google-cloud/storage');
jest.mock('@google-cloud/bigquery');

describe('Concurrency Tests', () => {
  const token = 'test-token-concurrency';
  const validHeaders = { 'Authorization': `Bearer ${token}` };
  const testDataDir = path.join(__dirname, 'test-data-concurrency');
  const TEST_IP = '10.0.0.99';

  beforeAll(() => {
    config.COLLECTOR_TOKEN = token;
    config.STORAGE_TYPE = 'local';
    config.LOCAL_DATA_DIR = testDataDir;
    config.MAX_RUNS_PER_IP_PER_DAY = 3;
    config.MIN_GAP_HOURS_PER_IP = 7;

    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  it('should handle simultaneous ingestion and gating correctly', async () => {
    // Scenario: 5 runners start AT THE SAME TIME with the same IP.
    // They all Ingest. Then they all Gate.
    // We want the logic to ensure NOT ALL of them pass if they violate policy.

    // 1. Simulate 5 concurrent INGEST requests
    const runnerIds = ['run1', 'run2', 'run3', 'run4', 'run5'];
    const now = new Date().toISOString();

    // Ingest all 5 "simultaneously"
    await Promise.all(runnerIds.map(id =>
        request(app)
            .post('/ingest')
            .set(validHeaders)
            .send({ ip: TEST_IP, run_id: id, ts: now })
    ));

    // Verify 5 files exist
    const safeIp = TEST_IP.replace(/[^a-zA-Z0-9.:-]/g, '_'); // Regex allows dots, so just '10.0.0.99'
    const today = now.split('T')[0];
    const dir = path.join(testDataDir, 'ips', today, safeIp);
    const files = fs.readdirSync(dir);
    expect(files.length).toBe(5);

    // 2. Simulate 5 concurrent GATE requests
    // All 5 runners ask "Can I run?".
    // They all have the exact same timestamp (gap = 0).

    const responses = await Promise.all(runnerIds.map(id =>
        request(app)
            .post('/gate')
            .set(validHeaders)
            .send({ ip: TEST_IP, ts: now, run_id: id })
    ));

    // Logic Check:
    // We have 5 records with identical timestamps.
    // When sorted, one is "first" (or all equal).
    // The gap between Record 1 and Record 2 is 0 hours.
    // 0 < 7 hours. So Record 2 should be blocked.
    // Record 3 vs Record 2 gap is 0. Blocked.
    // So ONLY ONE should succeed.

    const allowed = responses.filter(r => r.body.should_run === true);
    const denied = responses.filter(r => r.body.should_run === false);

    console.log(`Allowed: ${allowed.length}, Denied: ${denied.length}`);

    // We expect 1 allowed, 4 denied (reason: gap_not_satisfied or max_runs)
    expect(allowed.length).toBe(1);
    expect(denied.length).toBe(4);

    // Verify reason
    expect(denied[0].body.reason).toMatch(/gap_not_satisfied|max_runs_reached/);
  });
});
