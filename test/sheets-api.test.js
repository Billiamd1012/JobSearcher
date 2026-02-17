/**
 * Tests for SheetsManager (sheets-api.js).
 * Run: npm test
 *
 * Uses the same credentials as Gmail (config/token.json). Token must include
 * spreadsheets scope. Unit tests use buildJobRow with dummy data; integration
 * tests call the real API.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { SheetsManager, JOBS_SHEET_ID, buildJobRow } = require('../sheets-api');

const NORMAL_JOBS = [
  {
    positionName: 'Graduate DevOps/QA Engineer',
    company: 'PROFOUND',
    posted: '22/01/2026',
    type: 'Full time',
    location: 'Adelaide',
    link: 'https://www.seek.com.au/job/89851615?ref=recom-homepage&pos=2&origin=showNewTab',
  },
  {
    positionName: 'Software Engineer',
    company: 'Consunet',
    posted: '22/1/26',
    type: 'Full time',
    location: 'Adelaide',
    link: 'https://www.seek.com.au/job/89293819/apply?sol=2f0b398aee8a3d0112af9f889566d7e42a045e62',
  },
  {
    positionName: 'Web Developer',
    company: 'Refuel Creative',
    posted: '16/1/26',
    type: 'Full time',
    location: 'Port Adelaide',
    link: 'https://2p9qv.share.hsforms.com/2NX0xPUiRS3-B9xkPxhRjbg',
  },
];

describe('SheetsManager', () => {
  describe('fromClientSecret', () => {
    it('returns a SheetsManager instance with sheets client', async () => {
      const manager = await SheetsManager.fromClientSecret();
      assert.ok(manager instanceof SheetsManager);
      assert.ok(manager.sheets);
    });
  });

  describe('retrieveJobsSheet', () => {
    it('returns sheet info for default Jobs sheet', async () => {
      const manager = await SheetsManager.fromClientSecret();
      const info = await manager.retrieveJobsSheet();
      assert.ok(info && typeof info === 'object');
      assert.ok('title' in info);
      assert.ok(info.sheetId !== undefined || info.sheetTitle !== undefined);
    });

    it('returns same title when called with explicit JOBS_SHEET_ID', async () => {
      const manager = await SheetsManager.fromClientSecret();
      const a = await manager.retrieveJobsSheet();
      const b = await manager.retrieveJobsSheet(JOBS_SHEET_ID);
      assert.strictEqual(b.title, a.title);
    });
  });

  describe('buildJobRow (job row builder)', () => {
    it('throws when job is null', () => {
      assert.throws(() => buildJobRow(null), /job is required \(null\/undefined\)/);
    });

    it('throws when job is undefined', () => {
      assert.throws(() => buildJobRow(undefined), /job is required \(null\/undefined\)/);
    });

    it('throws when job is not an object (string)', () => {
      assert.throws(() => buildJobRow('Software Engineer'), /job must be an object/);
    });

    it('throws when job is not an object (number)', () => {
      assert.throws(() => buildJobRow(42), /job must be an object/);
    });

    it('throws when job is an array', () => {
      assert.throws(() => buildJobRow(['A', 'B']), /job must be an object/);
    });

    it('normal use case 1: full job (Graduate DevOps/QA Engineer)', () => {
      const row = buildJobRow(NORMAL_JOBS[0]);
      assert.strictEqual(row.length, 16);
      assert.strictEqual(row[0], ''); // A: ID
      assert.strictEqual(row[1], 'Graduate DevOps/QA Engineer'); // B: Position name
      assert.strictEqual(row[2], 'PROFOUND'); // C: Company
      assert.strictEqual(row[4], '22/01/2026'); // E: Posted
      assert.strictEqual(row[7], 'Full time'); // H: Type
      assert.strictEqual(row[8], 'Adelaide'); // I: Location
      assert.ok(row[9].includes('seek.com.au/job/89851615')); // J: Link
    });

    it('normal use case 2: full job (Software Engineer)', () => {
      const row = buildJobRow(NORMAL_JOBS[1]);
      assert.strictEqual(row.length, 16);
      assert.strictEqual(row[1], 'Software Engineer');
      assert.strictEqual(row[2], 'Consunet');
      assert.strictEqual(row[4], '22/1/26');
      assert.strictEqual(row[7], 'Full time');
      assert.strictEqual(row[8], 'Adelaide');
      assert.ok(row[9].includes('seek.com.au/job/89293819'));
    });

    it('normal use case 3: full job (Web Developer)', () => {
      const row = buildJobRow(NORMAL_JOBS[2]);
      assert.strictEqual(row.length, 16);
      assert.strictEqual(row[1], 'Web Developer');
      assert.strictEqual(row[2], 'Refuel Creative');
      assert.strictEqual(row[8], 'Port Adelaide');
    });

    it('coerces missing optional fields to empty string', () => {
      const row = buildJobRow({ positionName: 'Test', company: 'Co' });
      assert.strictEqual(row.length, 16);
      assert.strictEqual(row[0], '');
      assert.strictEqual(row[1], 'Test');
      assert.strictEqual(row[2], 'Co');
      for (let i = 3; i < 16; i++) assert.strictEqual(row[i], '');
    });
  });

  describe('appendJobRow', () => {
    it('throws when job is null', async () => {
      const manager = await SheetsManager.fromClientSecret();
      await assert.rejects(async () => manager.appendJobRow(null), /job is required/);
    });

    it('throws when job is incorrectly formatted (string)', async () => {
      const manager = await SheetsManager.fromClientSecret();
      await assert.rejects(async () => manager.appendJobRow('not an object'), /job must be an object/);
    });

    it('appends a row with valid job data when token has write scope', async () => {
      const manager = await SheetsManager.fromClientSecret();
      const job = {
        positionName: '[Test] Seek scrape job',
        company: 'Test Co',
        posted: new Date().toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' }),
        type: 'Full time',
        location: 'Adelaide',
        link: 'https://www.seek.com.au/job/00000000',
      };
      try {
        await manager.appendJobRow(job);
      } catch (err) {
        if (err.message && err.message.includes('insufficient authentication scopes')) {
          // Token may be read-only; skip assertion so CI/local without write scope still pass
          return;
        }
        throw err;
      }
    });
  });
});
