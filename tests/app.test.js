const request = require('supertest');
const app = require('../src/app');
const storage = require('../src/storage');
const config = require('../src/config');

// Mock storage
jest.mock('../src/storage');

describe('ActionIP Aggregator Tests', () => {
  const token = 'test-token';
  const validHeaders = { 'Authorization': `Bearer ${token}` };

  beforeAll(() => {
    config.COLLECTOR_TOKEN = token;
    config.MAX_RUNS_PER_IP_PER_DAY = 3;
    config.MIN_GAP_HOURS_PER_IP = 7;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    storage.appendToGCS.mockResolvedValue();
    storage.insertIntoBigQuery.mockResolvedValue();
  });

  describe('POST /ingest', () => {
    it('should accept valid data', async () => {
      const res = await request(app)
        .post('/ingest')
        .set(validHeaders)
        .send({ ip: '1.2.3.4', run_id: '123' });

      expect(res.status).toBe(200);
      expect(storage.appendToGCS).toHaveBeenCalled();
    });

    it('should reject without token', async () => {
      const res = await request(app).post('/ingest').send({});
      expect(res.status).toBe(401);
    });
  });

  describe('POST /gate Logic', () => {

    it('should allow first run (no history)', async () => {
      // Simulate that Ingest ALREADY happened, so DB has Current Run
      storage.getRecordsForIpToday.mockResolvedValue([
          { ip: '1.2.3.4', ts: new Date().toISOString(), run_id: 'run1' }
      ]);

      const res = await request(app)
        .post('/gate')
        .set(validHeaders)
        .send({ ip: '1.2.3.4', ts: new Date().toISOString(), run_id: 'run1' });

      expect(res.body.should_run).toBe(true);
    });

    it('should allow 2nd run if gap > 7h', async () => {
      const now = new Date();
      const eightHoursAgo = new Date(now - 8 * 60 * 60 * 1000).toISOString();

      // Mock: Current Run + Old Run
      storage.getRecordsForIpToday.mockResolvedValue([
        { ip: '1.2.3.4', ts: now.toISOString(), run_id: 'run2' },
        { ip: '1.2.3.4', ts: eightHoursAgo, run_id: 'run1' }
      ]);

      const res = await request(app)
        .post('/gate')
        .set(validHeaders)
        .send({ ip: '1.2.3.4', ts: now.toISOString(), run_id: 'run2' });

      expect(res.body.should_run).toBe(true);
    });

    it('should DENY 2nd run if gap < 7h', async () => {
      const now = new Date();
      const oneHourAgo = new Date(now - 1 * 60 * 60 * 1000).toISOString();

      // Simulate that Ingest ALREADY happened, so DB has Current + Old record
      storage.getRecordsForIpToday.mockResolvedValue([
        { ip: '1.2.3.4', ts: now.toISOString(), run_id: 'run2' },    // Current Run
        { ip: '1.2.3.4', ts: oneHourAgo, run_id: 'run1' }            // Previous Run
      ]);

      const res = await request(app)
        .post('/gate')
        .set(validHeaders)
        .send({ ip: '1.2.3.4', ts: now.toISOString(), run_id: 'run2' });

      expect(res.body.should_run).toBe(false);
      expect(res.body.reason).toBe('gap_not_satisfied');
    });

    it('should DENY 4th run (Max Runs Reached)', async () => {
      // Setup 3 existing runs + 1 new run (Total 4)
      // Must ensure timestamps have > 7h gaps so they are all valid!
      // Run 1: 00:00
      // Run 2: 08:00 (Gap 8h)
      // Run 3: 16:00 (Gap 8h)
      // Run 4: 23:59 (Gap 7.9h)
      const now = '2023-01-01T23:59:00Z';

      storage.getRecordsForIpToday.mockResolvedValue([
        { run_id: 'new', ts: now },
        { run_id: '3', ts: '2023-01-01T16:00:00Z' },
        { run_id: '2', ts: '2023-01-01T08:00:00Z' },
        { run_id: '1', ts: '2023-01-01T00:00:00Z' }
      ]);

      const res = await request(app)
        .post('/gate')
        .set(validHeaders)
        .send({ ip: '1.2.3.4', ts: now, run_id: 'new' });

      // Logic: All 3 previous runs are valid. 'new' is the 4th valid run.
      // Max runs = 3. So 'new' should be blocked.

      expect(res.body.should_run).toBe(false);
      expect(res.body.reason).toBe('max_runs_reached');
    });
  });
});
