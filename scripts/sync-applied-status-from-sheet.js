#!/usr/bin/env node
/**
 * Sync applied status from the Google Sheet to job-data/applied-status.json.
 * Sheet is the source of truth; this script overwrites the local file.
 *
 * Run: node scripts/sync-applied-status-from-sheet.js
 * Requires: JOBS_SHEET_ID in config/.env, config/token.json with spreadsheets scope.
 * If you get auth errors, run: node scripts/refresh-oauth-token.js
 */

const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(PROJECT_ROOT, 'config', '.env') });

const { SheetsManager, JOBS_SHEET_ID } = require(path.join(PROJECT_ROOT, 'sheets-api'));

const JOB_DATA_DIR = path.join(PROJECT_ROOT, 'job-data');
const APPLIED_STATUS_PATH = path.join(JOB_DATA_DIR, 'applied-status.json');
const SHEET_NAME = process.env.SHEET_NAME || 'Sheet1';

/** Applied column (K) is considered "applied" if it matches this (same as sheets-api). */
function isAppliedValue(applied) {
  const s = (applied != null && String(applied).trim()) || '';
  return /^(\s*y(es)?|\s*1|\s*true)\s*$/i.test(s);
}

/** Extract job ID from a row: column A if numeric, else from Link (J) /job/(\d+)/. */
function getJobIdFromRow(row) {
  const colA = (row[0] != null && String(row[0]).trim()) || '';
  if (/^\d+$/.test(colA)) return colA;
  const link = (row[9] != null && String(row[9]).trim()) || '';
  const match = link.match(/\/job\/(\d+)/);
  return match ? match[1] : null;
}

async function main() {
  if (!JOBS_SHEET_ID || !JOBS_SHEET_ID.trim()) {
    console.error('JOBS_SHEET_ID is not set. Set it in config/.env.');
    process.exit(1);
  }

  let sheets;
  try {
    sheets = await SheetsManager.fromClientSecret();
  } catch (err) {
    console.error('Failed to create Sheets manager:', err.message);
    if (err.message && err.message.includes('token')) {
      console.error('Run: node scripts/refresh-oauth-token.js');
    }
    process.exit(1);
  }

  const range = `${SHEET_NAME}!A:K`;
  let rows;
  try {
    rows = await sheets.getValues(range, JOBS_SHEET_ID);
  } catch (err) {
    console.error('Failed to read sheet:', err.message);
    process.exit(1);
  }

  const appliedSet = new Set();
  const notAppliedSet = new Set();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    const firstCell = (row[0] != null && String(row[0]).trim()) || '';
    if (firstCell === 'ID') continue; // header row
    const jobId = getJobIdFromRow(row);
    if (!jobId) continue;
    const applied = (row[10] != null && String(row[10]).trim()) || '';
    if (isAppliedValue(applied)) {
      appliedSet.add(jobId);
    } else {
      notAppliedSet.add(jobId);
    }
  }

  const appliedIds = [...appliedSet].sort();
  const notAppliedIds = [...notAppliedSet].sort();
  const payload = {
    lastSyncedAt: new Date().toISOString(),
    applied: appliedIds,
    notApplied: notAppliedIds,
  };

  fs.mkdirSync(JOB_DATA_DIR, { recursive: true });
  fs.writeFileSync(APPLIED_STATUS_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  console.log('Updated', APPLIED_STATUS_PATH, '— applied:', appliedIds.length, ', not applied:', notAppliedIds.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
