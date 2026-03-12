/**
 * Run three runners in parallel: scrape (headless), cover-letter generator, apply (headed).
 * Sync applied status from the sheet once, then spawn all three; output may interleave.
 *
 * Usage: node run-parallel.js
 * Requires: config/.env, config/token.json, and dependencies for job-search, cover-letter, and job-apply.
 *
 * - Scrape runs headless (SEEK_HEADLESS=1). Cover-letter generates only for jobs that don't have one yet.
 * - Apply runs in a visible browser so you can intervene; it does not generate cover letters (JOB_APPLY_NO_GENERATE=1).
 */

const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname);
const SYNC_APPLIED_SCRIPT = path.join(ROOT, 'scripts', 'sync-applied-status-from-sheet.js');
const REFRESH_SCRIPT = path.join(ROOT, 'scripts', 'refresh-oauth-token.js');
const SEARCH_SCRIPT = path.join(ROOT, 'job-search', 'seek-job-search.js');
const COVER_LETTER_SCRIPT = path.join(ROOT, 'document-creation', 'cover-letter-generator', 'generate-from-job-data.js');
const APPLY_SCRIPT = path.join(ROOT, 'job-apply', 'job-apply.js');

function run(scriptPath, scriptName, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...env },
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

/**
 * Spawn a script with custom env; resolve with { name, code } when it exits (no reject on non-zero).
 */
function runInParallel(scriptPath, scriptName, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('close', (code) => resolve({ name: scriptName, code }));
    child.on('error', (err) => resolve({ name: scriptName, code: 1, err }));
  });
}

async function main() {
  console.log('=== Sync applied status from sheet ===\n');
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

  console.log('\n=== Starting scrape (headless), cover-letter, and apply (headed) in parallel ===\n');

  const scrapePromise = runInParallel(SEARCH_SCRIPT, 'seek-job-search.js', { SEEK_HEADLESS: '1' });
  const coverPromise = runInParallel(COVER_LETTER_SCRIPT, 'generate-from-job-data.js', {});
  const applyPromise = runInParallel(APPLY_SCRIPT, 'job-apply.js', { JOB_APPLY_NO_GENERATE: '1' });

  const [scrapeResult, coverResult, applyResult] = await Promise.all([scrapePromise, coverPromise, applyPromise]);

  console.log('\n--- scrape:', scrapeResult.code === 0 ? 'ok' : `exited ${scrapeResult.code}`);
  console.log('--- cover-letter:', coverResult.code === 0 ? 'ok' : `exited ${coverResult.code}`);
  console.log('--- apply:', applyResult.code === 0 ? 'ok' : `exited ${applyResult.code}`);

  if (scrapeResult.code !== 0 || coverResult.code !== 0 || applyResult.code !== 0) {
    process.exit(1);
  }
  console.log('\nDone: all three runners completed.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
