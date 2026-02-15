/**
 * Google Sheets API manager — uses the same OAuth2 credentials as Gmail
 * (config/.env GMAIL_CLIENT_SECRET and config/token.json).
 *
 * Token must include https://www.googleapis.com/auth/spreadsheets (write).
 * If you get "insufficient authentication scopes", run: node scripts/refresh-oauth-token.js
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, 'config', '.env') });
const { google } = require('googleapis');

const TOKEN_PATH = path.join(__dirname, 'config', 'token.json');
const JOBS_SHEET_ID = '1pHP6WloSO0j7AddRdOd5Urunf-ZUcKS3Gas3O916mbg';

/**
 * Build a row array for the Jobs sheet from a job object. Validates input.
 * @param {object} job - { positionName, company?, posted?, type?, location?, link? }
 * @returns {[string, string, string, string, string, string, string, string, string]} - Row for A:I
 * @throws {Error} if job is null, undefined, or not a plain object
 */
function buildJobRow(job) {
  if (job == null) {
    throw new Error('appendJobRow: job is required (null/undefined)');
  }
  if (typeof job !== 'object' || Array.isArray(job)) {
    throw new Error('appendJobRow: job must be an object');
  }
  const positionName = String(job.positionName ?? '');
  const company = String(job.company ?? '');
  const posted = String(job.posted ?? '');
  const type = String(job.type ?? '');
  const location = String(job.location ?? '');
  const link = String(job.link ?? '');
  return [positionName, company, '', posted, '', '', type, location, link];
}

class SheetsManager {
  constructor(auth) {
    this.auth = auth;
    this.sheets = google.sheets({ version: 'v4', auth });
  }

  /**
   * Create a SheetsManager using the same OAuth2 client secret as Gmail.
   * Uses config/token.json (shared with Gmail). Token must include spreadsheets scope (write).
   * @param {string} [clientSecretPath] - Path to client secret JSON. Defaults to process.env.GMAIL_CLIENT_SECRET or config/client_secret*.json.
   * @returns {Promise<SheetsManager>}
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
    const REDIRECT_URI = redirect_uris && redirect_uris[0] ? redirect_uris[0] : 'http://localhost:3000';

    const oauth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);

    if (!fs.existsSync(TOKEN_PATH)) {
      throw new Error(
        'No token found. Run: node scripts/refresh-oauth-token.js to sign in and create config/token.json with Gmail + Sheets scopes.'
      );
    }
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    oauth2Client.setCredentials(token);
    return new SheetsManager(oauth2Client);
  }

  /**
   * Check that the Jobs sheet is accessible (retrieve its metadata or first range).
   * Sheet ID: 1pHP6WloSO0j7AddRdOd5Urunf-ZUcKS3Gas3O916mbg
   * @param {string} [spreadsheetId] - Defaults to the Jobs sheet ID.
   * @returns {Promise<{ title: string, sheetId: number, rowCount?: number, colCount?: number }>} - Basic sheet info if accessible.
   */
  async retrieveJobsSheet(spreadsheetId = JOBS_SHEET_ID) {
    const res = await this.sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'properties.title,sheets(properties.sheetId,properties.title,properties.gridProperties)',
    });
    const props = res.data.properties || {};
    const sheets = res.data.sheets || [];
    const firstSheet = sheets[0];
    const grid = firstSheet?.properties?.gridProperties || {};
    return {
      title: props.title || '',
      sheetId: firstSheet?.properties?.sheetId,
      sheetTitle: firstSheet?.properties?.title,
      rowCount: grid.rowCount,
      colCount: grid.columnCount,
    };
  }

  /**
   * Append one job row to the Jobs sheet. Columns: A=Position name, B=Company, C=Want, D=Posted, E=Expiry, F=Genre, G=Type, H=Location, I=Link.
   * @param {object} job - { positionName, company, posted, type, location, link }
   * @param {string} [spreadsheetId]
   * @param {string} [range] - e.g. 'Sheet1' or 'Jobs'
   */
  async appendJobRow(job, spreadsheetId = JOBS_SHEET_ID, range = 'Sheet1') {
    const row = buildJobRow(job);
    const values = [row];
    try {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${range}!A:I`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
      });
    } catch (err) {
      const msg = err.message || '';
      const cause = err.cause || err;
      const causeMsg = (cause && cause.message) || '';
      if (
        err.code === 403 ||
        msg.includes('insufficient authentication scopes') ||
        causeMsg.includes('insufficient authentication scopes')
      ) {
        throw new Error(
          'Sheets write failed: token is missing the spreadsheets scope. Run: node scripts/refresh-oauth-token.js then try again.'
        );
      }
      throw err;
    }
  }
}

module.exports = { SheetsManager, JOBS_SHEET_ID, buildJobRow };
