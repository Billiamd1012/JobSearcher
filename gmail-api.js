/**
 * Gmail API manager — class for accessing Gmail from other modules.
 *
 * Auth options:
 * 1. OAuth2 (recommended for personal Gmail): GmailManager.fromClientSecret(path)
 *    Uses config/.env GMAIL_CLIENT_SECRET path; stores token in config/token.json.
 * 2. Pass an existing auth client: new GmailManager(auth)
 * 3. Service account: GmailManager.fromKeyFile(path) (Workspace domain-wide delegation only)
 *
 * In config/.env set: GMAIL_CLIENT_SECRET=./config/client_secret_xxx.json
 * Add http://localhost:3000 to Authorized redirect URIs in Google Cloud Console.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { URL } = require('url');
require('dotenv').config({ path: path.join(__dirname, 'config', '.env') });
const { google } = require('googleapis');

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
];
const REDIRECT_URI = 'http://localhost:3000';
const TOKEN_PATH = path.join(__dirname, 'config', 'token.json');
const OAUTH_PORT = 3000;
const VERIFICATION_CODE_REGEX = /\b(\d{6})\b/g;
const SEEK_VERIFICATION_QUERY = 'from:seek.com.au newer_than:1d';

function killProcessOnPort(port) {
  const { execSync } = require('child_process');
  try {
    if (process.platform === 'win32') {
      execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port}') do taskkill /F /PID %a`, {
        stdio: 'ignore',
        shell: true,
      });
    } else {
      execSync(`lsof -ti:${port} | xargs kill -9`, { stdio: 'ignore' });
    }
  } catch {
    // No process on port or already free
  }
}

function getAuthorizationCode(oauth2Client) {
  return new Promise((resolve, reject) => {
    killProcessOnPort(OAUTH_PORT);
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: GMAIL_SCOPES,
      prompt: 'consent',
    });
    const server = http
      .createServer((req, res) => {
        const parsed = new URL(req.url || '', REDIRECT_URI);
        const code = parsed.searchParams.get('code');
        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('Signed in. You can close this tab.');
          server.close();
          resolve(code);
        } else {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing code in URL');
          server.close();
          reject(new Error('Authorization callback missing code'));
        }
      })
      .listen(OAUTH_PORT, () => {
        const { execSync } = require('child_process');
        try {
          if (process.platform === 'darwin') execSync('open ' + JSON.stringify(authUrl), { stdio: 'ignore' });
          else if (process.platform === 'win32') execSync('start ' + JSON.stringify(authUrl), { stdio: 'ignore' });
          else execSync('xdg-open ' + JSON.stringify(authUrl), { stdio: 'ignore' });
        } catch {
          console.log('Open this URL in your browser:', authUrl);
        }
      });
    server.on('error', reject);
  });
}

class GmailManager {
  constructor(auth) {
    this.auth = auth;
    this.gmail = google.gmail({ version: 'v1', auth });
  }

  /**
   * Create a GmailManager using OAuth2 client secret (for personal Gmail).
   * On first run, opens browser for sign-in and saves token to config/token.json.
   * @param {string} [clientSecretPath] - Path to client secret JSON. Defaults to process.env.GMAIL_CLIENT_SECRET.
   * @returns {Promise<GmailManager>}
   */
  static async fromClientSecret(clientSecretPath) {
    let secretPath = clientSecretPath || process.env.GMAIL_CLIENT_SECRET;
    if (!secretPath) {
      const configDir = path.join(__dirname, 'config');
      const files = fs.existsSync(configDir) ? fs.readdirSync(configDir) : [];
      const match = files.find(f => f.startsWith('client_secret') && f.endsWith('.json'));
      if (match) secretPath = path.join(configDir, match);
    }
    if (!secretPath) {
      throw new Error(
        'Client secret path required. Set GMAIL_CLIENT_SECRET in config/.env or add config/client_secret_xxx.json.'
      );
    }
    if (!path.isAbsolute(secretPath)) {
      secretPath = path.resolve(__dirname, secretPath.replace(/^\.\//, ''));
    }
    const raw = fs.readFileSync(secretPath, 'utf-8');
    const credentials = JSON.parse(raw);
    const keys = credentials.installed || credentials.web;
    if (!keys) {
      throw new Error('Client secret JSON must have "installed" or "web" with client_id and client_secret.');
    }
    const { client_id, client_secret, redirect_uris } = keys;

    if (fs.existsSync(TOKEN_PATH)) {
      const redirectUri = redirect_uris && redirect_uris[0] ? redirect_uris[0] : REDIRECT_URI;
      const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);
      const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
      oauth2Client.setCredentials(token);
      return new GmailManager(oauth2Client);
    }

    const oauth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);
    const code = await getAuthorizationCode(oauth2Client);
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf-8');
    return new GmailManager(oauth2Client);
  }

  /**
   * Create a GmailManager using a service account key (Workspace domain-wide delegation only).
   * @param {string} [keyFilePath] - Path to service account JSON. Defaults to process.env.GOOGLE_APPLICATION_CREDENTIALS.
   * @returns {Promise<GmailManager>}
   */
  static async fromKeyFile(keyFilePath) {
    let keyPath = keyFilePath || process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!keyPath) {
      throw new Error(
        'Key file path required. Set GOOGLE_APPLICATION_CREDENTIALS in config/.env or pass fromKeyFile(path).'
      );
    }
    if (!path.isAbsolute(keyPath)) {
      keyPath = path.resolve(__dirname, keyPath.replace(/^\.\//, ''));
    }
    const auth = new google.auth.GoogleAuth({
      keyFile: keyPath,
      scopes: GMAIL_SCOPES,
    });
    const client = await auth.getClient();
    return new GmailManager(client);
  }

  /**
   * Fetch the most recent email in the mailbox (inbox, newest first).
   * Used to verify the manager can read mail.
   * @returns {Promise<{ id: string, snippet?: string, date?: string, from?: string, subject?: string } | null>}
   *   The latest message summary, or null if the mailbox is empty.
   */
  async getMostRecentEmail() {
    const listRes = await this.gmail.users.messages.list({
      userId: 'me',
      maxResults: 1,
    });
    const messages = listRes.data.messages || [];
    if (messages.length === 0) return null;

    const msgRes = await this.gmail.users.messages.get({
      userId: 'me',
      id: messages[0].id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date'],
    });
    const msg = msgRes.data;
    const headers = (msg.payload && msg.payload.headers) || [];
    const getHeader = (name) =>
      headers.find(h => (h.name || '').toLowerCase() === name.toLowerCase())?.value;

    return {
      id: msg.id,
      snippet: msg.snippet,
      date: getHeader('date'),
      from: getHeader('from'),
      subject: getHeader('subject'),
    };
  }

  /**
   * Look for Seek verification codes in recent Gmail messages.
   * Use receivedAfter (ms since epoch) to only consider emails received after that time (e.g. after clicking "Email me a sign in code").
   * @param {object} [options]
   * @param {number} [options.maxMessages=10]
   * @param {string} [options.query]
   * @param {number} [options.receivedAfter] - Only include messages with internalDate >= this (ms since epoch).
   * @returns {Promise<Array<{ messageId: string, code: string, snippet?: string, date?: string, internalDate?: number }>>}
   */
  async findSeekVerificationCodes(options = {}) {
    if (options != null && (typeof options !== 'object' || Array.isArray(options))) {
      throw new Error('findSeekVerificationCodes: options must be an object');
    }
    const opts = options || {};
    const maxMessages = Math.min(Math.max(0, Number(opts.maxMessages) || 10), 50);
    const query = typeof opts.query === 'string' ? opts.query : SEEK_VERIFICATION_QUERY;
    const receivedAfter = typeof opts.receivedAfter === 'number' ? opts.receivedAfter : null;

    const listRes = await this.gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: maxMessages,
    });

    const messages = listRes.data.messages || [];
    const messageDetails = [];

    for (const ref of messages) {
      const msgRes = await this.gmail.users.messages.get({
        userId: 'me',
        id: ref.id,
        format: 'full',
      });
      const msg = msgRes.data;
      const internalDate = typeof msg.internalDate === 'string' ? parseInt(msg.internalDate, 10) : msg.internalDate;
      if (receivedAfter != null && (internalDate == null || internalDate < receivedAfter)) {
        continue;
      }

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
        messageDetails.push({
          messageId: msg.id,
          code,
          snippet: snippet.length ? snippet : undefined,
          date,
          internalDate: internalDate || undefined,
        });
      }
    }

    messageDetails.sort((a, b) => (b.internalDate || 0) - (a.internalDate || 0));
    return messageDetails;
  }
}

module.exports = { GmailManager };