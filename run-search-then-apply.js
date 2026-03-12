/**
 * Parent script: run Seek job search (all pages), then run job apply for the scraped jobs.
 * Usage: node run-search-then-apply.js
 * Requires: config/.env, config/token.json, and dependencies for job-search and job-apply.
 */

const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname);
const SYNC_APPLIED_SCRIPT = path.join(ROOT, 'scripts', 'sync-applied-status-from-sheet.js');
const REFRESH_SCRIPT = path.join(ROOT, 'scripts', 'refresh-oauth-token.js');
const SEARCH_SCRIPT = path.join(ROOT, 'job-search', 'seek-job-search.js');
const APPLY_SCRIPT = path.join(ROOT, 'job-apply', 'job-apply.js');

function run(scriptPath, scriptName) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env },
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${scriptName} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

/**
 * Run a script with stderr captured so the caller can inspect it on failure (e.g. to detect invalid_grant).
 * Stderr is still forwarded to process.stderr so the user sees the output.
 */
function runWithStderrCapture(scriptPath, scriptName) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: ROOT,
      stdio: ['inherit', 'inherit', 'pipe'],
      env: { ...process.env },
    });
    const stderrChunks = [];
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderrChunks.push(chunk);
        process.stderr.write(chunk);
      });
    }
    child.on('close', (code) => {
      const capturedStderr = stderrChunks.map((c) => c.toString()).join('');
      if (code === 0) {
        resolve();
      } else {
        const err = new Error(`${scriptName} exited with code ${code}`);
        err.capturedStderr = capturedStderr;
        reject(err);
      }
    });
    child.on('error', reject);
  });
}

async function main() {
  console.log('=== Step 0: Sync applied status from sheet ===\n');
  try {
    await runWithStderrCapture(SYNC_APPLIED_SCRIPT, 'sync-applied-status-from-sheet.js');
  } catch (err) {
    const stderr = err.capturedStderr || '';
    const message = err.message || '';
    if (stderr.includes('invalid_grant') || message.includes('invalid_grant')) {
      console.log('\nGoogle token expired or revoked. Opening browser to re-authenticate (Gmail + Sheets)...\n');
      await run(REFRESH_SCRIPT, 'refresh-oauth-token.js');
      console.log('\nRetrying sync applied status...\n');
      await run(SYNC_APPLIED_SCRIPT, 'sync-applied-status-from-sheet.js');
    } else {
      throw err;
    }
  }
  console.log('\n=== Step 1: Seek job search (scrape all pages) ===\n');
  await run(SEARCH_SCRIPT, 'seek-job-search.js');
  console.log('\n=== Step 2: Job apply (apply to scraped jobs) ===\n');
  await run(APPLY_SCRIPT, 'job-apply.js');
  console.log('\nDone: search and apply completed.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
