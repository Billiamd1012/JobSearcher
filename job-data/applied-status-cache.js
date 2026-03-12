/**
 * Read job-data/applied-status.json (written by scripts/sync-applied-status-from-sheet.js).
 * Used by job-apply and seek-job-search to avoid API calls and skip already-applied jobs.
 */

const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const APPLIED_STATUS_PATH = path.join(PROJECT_ROOT, 'job-data', 'applied-status.json');

/**
 * Load applied-status.json if it exists.
 * @returns {{ applied: string[], notApplied: string[], lastSyncedAt: string } | null}
 */
function loadAppliedStatus() {
  if (!fs.existsSync(APPLIED_STATUS_PATH)) return null;
  try {
    const raw = fs.readFileSync(APPLIED_STATUS_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return data && Array.isArray(data.applied) ? data : null;
  } catch {
    return null;
  }
}

/**
 * True if the job is marked as applied in the local cache (applied-status.json).
 * If the file is missing or invalid, returns false (so we don't skip).
 * @param {string} jobId - e.g. '90276720'
 * @returns {boolean}
 */
function isJobAppliedFromCache(jobId) {
  if (!jobId || typeof jobId !== 'string') return false;
  const data = loadAppliedStatus();
  if (!data || !Array.isArray(data.applied)) return false;
  return data.applied.includes(String(jobId).trim());
}

module.exports = { loadAppliedStatus, isJobAppliedFromCache, APPLIED_STATUS_PATH };
