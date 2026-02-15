/**
 * Gmail API manager — class for accessing Gmail from other modules.
 *
 * Auth options:
 * 1. Pass an existing auth client: new GmailManager(auth)
 * 2. Create from a key file: GmailManager.fromKeyFile(path) or GmailManager.fromKeyFile()
 *    (path defaults to process.env.GOOGLE_APPLICATION_CREDENTIALS)
 *
 * In .env add: GOOGLE_APPLICATION_CREDENTIALS=./path/to/your-private-key.json
 * Keep the JSON file outside git (*-key.json and *-credentials.json are in .gitignore).
 */

require('dotenv').config();
const { google } = require('googleapis');

const VERIFICATION_CODE_REGEX = /\b(\d{6})\b/g;
const SEEK_VERIFICATION_QUERY = 'from:seek.com.au newer_than:1d';

class GmailManager {
  constructor(auth) {
    this.auth = auth;
    this.gmail = google.gmail({ version: 'v1', auth });
  }

  /**
   * Create a GmailManager using a JSON key file (service account or path to credentials).
   * @param {string} [keyFilePath] - Path to JSON key file. Defaults to process.env.GOOGLE_APPLICATION_CREDENTIALS.
   * @returns {Promise<GmailManager>}
   */
  static async fromKeyFile(keyFilePath) {
    const path = keyFilePath || process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!path) {
      throw new Error(
        'Key file path required. Set GOOGLE_APPLICATION_CREDENTIALS in .env or pass fromKeyFile(path).'
      );
    }
    const auth = new google.auth.GoogleAuth({
      keyFile: path,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    });
    const client = await auth.getClient();
    return new GmailManager(client);
  }

  /**
   * Look for Seek verification codes in recent Gmail messages.
   * @param {object} [options]
   * @param {number} [options.maxMessages=10]
   * @param {string} [options.query]
   * @returns {Promise<Array<{ messageId: string, code: string, snippet?: string, date?: string }>>}
   */
  async findSeekVerificationCodes(options = {}) {
    const { maxMessages = 10, query = SEEK_VERIFICATION_QUERY } = options;

    const listRes = await this.gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: Math.min(maxMessages, 50),
    });

    const messages = listRes.data.messages || [];
    const results = [];

    for (const ref of messages) {
      const msgRes = await this.gmail.users.messages.get({
        userId: 'me',
        id: ref.id,
        format: 'full',
      });
      const msg = msgRes.data;
      const payload = msg.payload || {};
      const headers = payload.headers || [];
      const dateHeader = headers.find(h => (h.name || '').toLowerCase() === 'date');
      const date = dateHeader ? dateHeader.value : undefined;

      let text = '';
      if (payload.body && payload.body.data) {
        text += Buffer.from(payload.body.data, 'base64').toString('utf-8');
      }
      if (payload.parts) {
        for (const part of payload.parts) {
          if (part.mimeType === 'text/plain' && part.body && part.body.data) {
            text += Buffer.from(part.body.data, 'base64').toString('utf-8');
          }
          if (part.mimeType === 'text/html' && part.body && part.body.data) {
            const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
            text += html.replace(/<[^>]+>/g, ' ');
          }
        }
      }

      const codes = [...text.matchAll(VERIFICATION_CODE_REGEX)].map(m => m[1]);
      const snippet = msg.snippet || text.slice(0, 120);

      for (const code of codes) {
        results.push({ messageId: msg.id, code, snippet: snippet.length ? snippet : undefined, date });
      }
    }

    return results;
  }
}

module.exports = { GmailManager };