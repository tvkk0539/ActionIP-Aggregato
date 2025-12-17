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
      storage.getRecordsForIpToday.mockResolvedValue([]);

      const res = await request(app)
        .post('/gate')
        .set(validHeaders)
        .send({ ip: '1.2.3.4', ts: new Date().toISOString() });

      expect(res.body.should_run).toBe(true);
      expect(res.body.uses_today).toBe(0);
    });

    it('should allow 2nd run if gap > 7h', async () => {
      const now = new Date();
      const eightHoursAgo = new Date(now - 8 * 60 * 60 * 1000).toISOString();

      storage.getRecordsForIpToday.mockResolvedValue([
        { ip: '1.2.3.4', ts: eightHoursAgo }
      ]);

      const res = await request(app)
        .post('/gate')
        .set(validHeaders)
        .send({ ip: '1.2.3.4', ts: now.toISOString() });

      expect(res.body.should_run).toBe(true);
      expect(res.body.uses_today).toBe(1);
    });

    it('should DENY 2nd run if gap < 7h', async () => {
      const now = new Date();
      const oneHourAgo = new Date(now - 1 * 60 * 60 * 1000).toISOString();

      // Simulate that Ingest ALREADY happened, so DB has Current + Old record
      storage.getRecordsForIpToday.mockResolvedValue([
        { ip: '1.2.3.4', ts: now.toISOString() },    // Current Run
        { ip: '1.2.3.4', ts: oneHourAgo }            // Previous Run
      ]);

      const res = await request(app)
        .post('/gate')
        .set(validHeaders)
        .send({ ip: '1.2.3.4', ts: now.toISOString() });

      expect(res.body.should_run).toBe(false);
      expect(res.body.reason).toBe('gap_not_satisfied');
    });

    it('should DENY 4th run (Max Runs Reached)', async () => {
      // Setup 4 existing runs (so this is the 5th attempt, or simply > 3)
      storage.getRecordsForIpToday.mockResolvedValue([
        { ts: '2023-01-01T10:00:00Z' },
        { ts: '2023-01-01T08:00:00Z' },
        { ts: '2023-01-01T06:00:00Z' },
        { ts: '2023-01-01T04:00:00Z' }
      ]);

      const res = await request(app)
        .post('/gate')
        .set(validHeaders)
        .send({ ip: '1.2.3.4', ts: new Date().toISOString() });

      expect(res.body.should_run).toBe(false);
      expect(res.body.reason).toBe('max_runs_reached');
    });
  });
});
