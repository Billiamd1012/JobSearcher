/**
 * Tests for GmailManager (gmail-api.js).
 * Run: npm test
 *
 * Requires config/.env with GMAIL_CLIENT_SECRET and config/token.json (with
 * gmail.readonly scope). Unit tests use dummy options; integration tests call the real API.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { GmailManager } = require('../gmail-api');

describe('GmailManager', () => {
  describe('fromClientSecret', () => {
    it('returns a GmailManager instance with gmail client and methods', async () => {
      const manager = await GmailManager.fromClientSecret();
      assert.ok(manager instanceof GmailManager);
      assert.ok(manager.gmail);
      assert.strictEqual(typeof manager.getMostRecentEmail, 'function');
      assert.strictEqual(typeof manager.findSeekVerificationCodes, 'function');
    });
  });

  describe('getMostRecentEmail', () => {
    it('returns null or an object with id, snippet, date, from, subject', async () => {
      const manager = await GmailManager.fromClientSecret();
      const email = await manager.getMostRecentEmail();
      assert.ok(email === null || (typeof email === 'object' && 'id' in email));
      if (email) {
        assert.strictEqual(typeof email.id, 'string');
        assert.ok('snippet' in email);
        assert.ok('date' in email);
        assert.ok('from' in email);
        assert.ok('subject' in email);
      }
    });
  });

  describe('findSeekVerificationCodes', () => {
    it('throws when options is not an object (string)', async () => {
      const manager = await GmailManager.fromClientSecret();
      await assert.rejects(
        async () => manager.findSeekVerificationCodes('invalid'),
        /options must be an object/
      );
    });

    it('throws when options is not an object (number)', async () => {
      const manager = await GmailManager.fromClientSecret();
      await assert.rejects(
        async () => manager.findSeekVerificationCodes(42),
        /options must be an object/
      );
    });

    it('throws when options is an array', async () => {
      const manager = await GmailManager.fromClientSecret();
      await assert.rejects(
        async () => manager.findSeekVerificationCodes([]),
        /options must be an object/
      );
    });

    it('accepts null options and returns an array (defaults)', async () => {
      const manager = await GmailManager.fromClientSecret();
      const codes = await manager.findSeekVerificationCodes(null);
      assert.ok(Array.isArray(codes));
    });

    it('normal use case 1: default options (empty object)', async () => {
      const manager = await GmailManager.fromClientSecret();
      const codes = await manager.findSeekVerificationCodes({});
      assert.ok(Array.isArray(codes));
      codes.forEach((item) => {
        assert.ok('messageId' in item && 'code' in item);
        assert.strictEqual(typeof item.code, 'string');
        assert.ok(item.code.length === 6);
      });
    });

    it('normal use case 2: custom maxMessages', async () => {
      const manager = await GmailManager.fromClientSecret();
      const codes = await manager.findSeekVerificationCodes({ maxMessages: 5 });
      assert.ok(Array.isArray(codes));
      // API may return up to requested; allow for pagination/API behavior
      assert.ok(codes.length <= 50);
      codes.forEach((item) => {
        assert.ok('messageId' in item && 'code' in item);
        assert.strictEqual(typeof item.code, 'string');
      });
    });

    it('normal use case 3: custom query and maxMessages', async () => {
      const manager = await GmailManager.fromClientSecret();
      const codes = await manager.findSeekVerificationCodes({
        maxMessages: 1,
        query: 'from:seek.com.au newer_than:1d',
      });
      assert.ok(Array.isArray(codes));
    });
  });
});
