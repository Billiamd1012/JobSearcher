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
/** Jobs spreadsheet ID (set JOBS_SHEET_ID in config/.env). Used as default when no spreadsheetId is passed. */
const JOBS_SHEET_ID = process.env.JOBS_SHEET_ID || '';

/**
 * Jobs sheet columns (A:Q): ID, Position name, Company, Want, Posted, Expiry Date,
 * Genre, Type, Location, Link, Applied, Application date, Rejected, Rejected Date, Expired, Expired date, Notes.
 */
const JOBS_SHEET_COLUMNS = [
  'ID', 'Position name', 'Company', 'Want', 'Posted', 'Expiry Date',
  'Genre', 'Type', 'Location', 'Link', 'Applied', 'Application date',
  'Rejected', 'Rejected Date', 'Expired', 'Expired date', 'Notes',
];

/**
 * Build a row array for the Jobs sheet from a job object. All 17 columns (A:Q) are present;
 * columns we do not set are empty strings.
 * @param {object} job - { positionName, company?, posted?, expiry?, genre?, type?, location?, link? }
 * @returns {string[]} - Row for A:Q
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
  const expiry = String(job.expiry ?? '');
  const genre = String(job.genre ?? '');
  const type = String(job.type ?? '');
  const location = String(job.location ?? '');
  const link = String(job.link ?? '');
  return [
    '',             // A: ID
    positionName,   // B: Position name
    company,        // C: Company
    '',             // D: Want
    posted,         // E: Posted
    expiry,         // F: Expiry Date
    genre,          // G: Genre
    type,           // H: Type
    location,       // I: Location
    link,           // J: Link
    '',             // K: Applied
    '',             // L: Application date
    '',             // M: Rejected
    '',             // N: Rejected Date
    '',             // O: Expired
    '',             // P: Expired date
    '',             // Q: Notes
  ];
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
   * @param {string} [spreadsheetId] - Defaults to JOBS_SHEET_ID from config/.env.
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
   * Get values from a range. Row 0 is the first row (may be headers).
   * @param {string} range - e.g. 'Sheet1!A:J'
   * @param {string} [spreadsheetId]
   * @returns {Promise<string[][]>} Rows of cell values
   */
  async getValues(range, spreadsheetId = JOBS_SHEET_ID) {
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });
    return (res.data.values || []).map((row) => [...row]);
  }

  /**
   * Get job rows that are not marked as applied and have a Seek job ID in the link.
   * Columns: A=ID, B=Position name, C=Company, … J=Link, K=Applied. Skips rows with no /job/NNN/ in Link.
   * @param {string} [spreadsheetId]
   * @param {string} [sheetName] - e.g. 'Sheet1'
   * @returns {Promise<Array<{ rowIndex: number, jobId: string, link: string, positionName: string, company: string }>>}
   */
  async getUnappliedJobs(spreadsheetId = JOBS_SHEET_ID, sheetName = 'Sheet1') {
    const rows = await this.getValues(`${sheetName}!A:K`, spreadsheetId);
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const link = (row[9] && String(row[9]).trim()) || '';
      const applied = (row[10] && String(row[10]).trim()) || '';
      if (/^(\s*y(es)?|\s*1|\s*true)\s*$/i.test(applied)) continue;
      const idMatch = link.match(/\/job\/(\d+)/);
      if (!idMatch) continue;
      const jobId = idMatch[1];
      out.push({
        rowIndex: i + 1,
        jobId,
        link: link.startsWith('http') ? link : `https://www.seek.com.au${link.startsWith('/') ? link : '/' + link}`,
        positionName: (row[1] && String(row[1]).trim()) || '',
        company: (row[2] && String(row[2]).trim()) || '',
      });
    }
    return out;
  }

  /**
   * Append one job row to the Jobs sheet. Writes all columns A:Q; unfilled columns are empty.
   * @param {object} job - { positionName, company, posted?, expiry?, genre?, type, location, link }
   * @param {string} [spreadsheetId]
   * @param {string} [range] - e.g. 'Sheet1' or 'Jobs'
   */
  async appendJobRow(job, spreadsheetId = JOBS_SHEET_ID, range = 'Sheet1') {
    const row = buildJobRow(job);
    const values = [row];
    try {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${range}!A:Q`,
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

  /**
   * Update the Notes column (Q) for a job row.
   * @param {number} rowIndex - 1-based row number
   * @param {string} notes - Text to write (e.g. "application failed because employer question 2 not answered")
   * @param {string} [spreadsheetId]
   * @param {string} [sheetName] - e.g. 'Sheet1'
   */
  async updateJobNotes(rowIndex, notes, spreadsheetId = JOBS_SHEET_ID, sheetName = 'Sheet1') {
    const range = `${sheetName}!Q${rowIndex}`;
    try {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[notes]] },
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

  /**
   * Check whether a job is already marked as applied in the sheet (column K).
   * @param {string} jobId - e.g. '90276720'
   * @param {string} [spreadsheetId]
   * @param {string} [sheetName] - e.g. 'Sheet1'
   * @returns {Promise<boolean>} - true if the job exists in the sheet and Applied (K) is Yes/1/true
   */
  async isJobApplied(jobId, spreadsheetId = JOBS_SHEET_ID, sheetName = 'Sheet1') {
    if (!jobId || !spreadsheetId) return false;
    const rowIndex = await this.findRowIndexByJobId(jobId, spreadsheetId, sheetName);
    if (rowIndex == null) return false;
    const rows = await this.getValues(`${sheetName}!K${rowIndex}:K${rowIndex}`, spreadsheetId);
    const applied = (rows[0] && rows[0][0] && String(rows[0][0]).trim()) || '';
    return /^(\s*y(es)?|\s*1|\s*true)\s*$/i.test(applied);
  }

  /**
   * Find the 1-based row index of a job by Seek job ID (match column A = jobId or Link column J contains /job/{jobId}).
   * @param {string} jobId - e.g. '90276720'
   * @param {string} [spreadsheetId]
   * @param {string} [sheetName] - e.g. 'Sheet1'
   * @returns {Promise<number|null>} - 1-based row index or null if not found
   */
  async findRowIndexByJobId(jobId, spreadsheetId = JOBS_SHEET_ID, sheetName = 'Sheet1') {
    if (!jobId || !spreadsheetId) return null;
    const rows = await this.getValues(`${sheetName}!A:J`, spreadsheetId);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const colA = (row[0] && String(row[0]).trim()) || '';
      const link = (row[9] && String(row[9]).trim()) || '';
      if (colA === String(jobId)) return i + 1;
      const idMatch = link.match(/\/job\/(\d+)/);
      if (idMatch && idMatch[1] === String(jobId)) return i + 1;
    }
    return null;
  }

  /**
   * Mark a job as applied: find row by jobId; if found update Applied (K) and Application date (L); if not found append a new row with job data and Applied=Yes.
   * @param {string} jobId - e.g. '90276720'
   * @param {object} job - { positionName, company, link?, posted?, type?, location?, ... } for building a new row when appending
   * @param {string} [spreadsheetId]
   * @param {string} [sheetName] - e.g. 'Sheet1'
   */
  async markJobAsAppliedByIdOrAppend(jobId, job, spreadsheetId = JOBS_SHEET_ID, sheetName = 'Sheet1') {
    if (!jobId || !spreadsheetId) return;
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    const applicationDate = `${day}/${month}/${year}`;

    const rowIndex = await this.findRowIndexByJobId(jobId, spreadsheetId, sheetName);
    if (rowIndex != null) {
      await this.markJobAsApplied(rowIndex, spreadsheetId, sheetName);
      return;
    }
    const row = buildJobRow(job);
    row[0] = String(jobId);
    row[10] = true;   // Applied: TRUE = checked tickbox (format column K as Checkbox in Sheets)
    row[11] = applicationDate;
    try {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A:Q`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
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

  /**
   * Add a job to the sheet without marking as applied (e.g. when automation failed so user can manually apply later).
   * If the job already exists (by jobId), no change. Otherwise appends a new row with job data and Applied (K) left empty.
   * @param {string} jobId - e.g. '90276720'
   * @param {object} job - { positionName, company, link?, posted?, type?, location?, ... }
   * @param {string} [spreadsheetId]
   * @param {string} [sheetName] - e.g. 'Sheet1'
   */
  async addJobForManualApply(jobId, job, spreadsheetId = JOBS_SHEET_ID, sheetName = 'Sheet1') {
    if (!jobId || !spreadsheetId) return;
    const rowIndex = await this.findRowIndexByJobId(jobId, spreadsheetId, sheetName);
    if (rowIndex != null) return; // already in sheet
    const row = buildJobRow(job);
    row[0] = String(jobId);
    // K (Applied) and L (Application date) left empty for manual apply
    try {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A:Q`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
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

  /**
   * Mark a job row as applied: set Applied (K) to TRUE (checkbox tick) and Application date (L) to today (DD/MM/YYYY).
   * Column K should be formatted as Checkbox in Sheets so TRUE displays as a filled tickbox.
   * @param {number} rowIndex - 1-based row number
   * @param {string} [spreadsheetId]
   * @param {string} [sheetName] - e.g. 'Sheet1'
   */
  async markJobAsApplied(rowIndex, spreadsheetId = JOBS_SHEET_ID, sheetName = 'Sheet1') {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    const applicationDate = `${day}/${month}/${year}`;
    const range = `${sheetName}!K${rowIndex}:L${rowIndex}`;
    try {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[true, applicationDate]] },
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
