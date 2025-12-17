const request = require('supertest');
const app = require('../src/app');
const config = require('../src/config');
const fs = require('fs');
const path = require('path');

jest.mock('@google-cloud/storage');
jest.mock('@google-cloud/bigquery');

describe('Out-of-Order Tests', () => {
  const token = 'test-token-ooo';
  const validHeaders = { 'Authorization': `Bearer ${token}` };
  const testDataDir = path.join(__dirname, 'test-data-ooo');
  const TEST_IP = '1.2.3.4';

  beforeAll(() => {
    config.COLLECTOR_TOKEN = token;
    config.STORAGE_TYPE = 'local';
    config.LOCAL_DATA_DIR = testDataDir;

    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  it('should handle out-of-order ingestion correctly', async () => {
    // Scenario:
    // Run A: 10:00. (The real first run).
    // Run B: 12:00. (The real second run, gap < 7h).

    // But Run B arrives at server FIRST.
    // Then Run A arrives.

    // We must use "Today" dates because Gate looks at Today's folder.
    const todayStr = new Date().toISOString().split('T')[0];
    const tsA = `${todayStr}T10:00:00Z`;
    const tsB = `${todayStr}T12:00:00Z`;

    // 1. Ingest Run B (12:00)
    await request(app).post('/ingest').set(validHeaders).send({ ip: TEST_IP, run_id: 'runB', ts: tsB });

    // 2. Gate Run B
    // At this moment, B is the ONLY record. So it thinks it is fresh. It allows itself.
    // NOTE: This is an inevitable distributed system race. If A hasn't arrived, B is valid.
    let resB = await request(app).post('/gate').set(validHeaders).send({ ip: TEST_IP, ts: tsB, run_id: 'runB' });
    expect(resB.body.should_run).toBe(true);

    // 3. Ingest Run A (10:00) - Arrives LATE
    await request(app).post('/ingest').set(validHeaders).send({ ip: TEST_IP, run_id: 'runA', ts: tsA });

    // 4. Gate Run A
    // Now records are [B, A].
    // Sorted chronological: [A, B].
    // Filter Valid:
    //  - A (First). Accepted.
    //  - B (Gap 2h). Rejected.
    // So 'validRuns' is [A].

    // Run A checks itself. "Am I in validRuns?" Yes.
    // "Am I allowed?" Yes.
    let resA = await request(app).post('/gate').set(validHeaders).send({ ip: TEST_IP, ts: tsA, run_id: 'runA' });
    expect(resA.body.should_run).toBe(true);

    // 5. Re-Gate Run B (Optional Check)
    // If Run B asks *again* (maybe it retries?), it should now be DENIED because A has arrived and A is older.
    // But realistically, B already got "True" in step 2 and started running.
    // This implies that "Late Arrival" of an earlier run DOES NOT stop a later run that *already started*.
    // But it DOES ensure that A is *also* allowed (because A is valid).

    // Wait, if B already started. And A starts.
    // B (12:00) running. A (10:00) running.
    // Gap is 2h.
    // Ideally we want only 1.
    // But we can't travel back in time to stop B.
    // So A *should* be allowed (because it really IS the first run).
    // The system correctly identifies A as valid.

    // Let's verify B would be blocked *if it asked now*.
    resB = await request(app).post('/gate').set(validHeaders).send({ ip: TEST_IP, ts: tsB, run_id: 'runB' });
    expect(resB.body.should_run).toBe(false);
    expect(resB.body.reason).toBe('gap_not_satisfied');

  });
});
