/**
 * Job Apply — Read unapplied jobs from the sheet (or first job in job-data for get started),
 * generate cover letter, navigate to job page, sign in if needed, click Apply, and get to the
 * screen where user selects/uploads cover letter and resume. Supervised: does not submit.
 * External redirects: close tab and skip without marking applied.
 *
 * Run: node job-apply/job-apply.js
 * Uses first job in job-data to get started. Set JOB_APPLY_USE_SHEET=1 to use sheet unapplied list.
 * Requires: config/.env (LOGIN_EMAIL, GMAIL_CLIENT_SECRET), config/token.json, job-data/*.json
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(PROJECT_ROOT, 'config', '.env') });

const { chromium } = require('playwright');
const { GmailManager } = require(path.join(PROJECT_ROOT, 'gmail-api'));
const { SheetsManager } = require(path.join(PROJECT_ROOT, 'sheets-api'));
const { runCoverLetterChecks } = require(path.join(PROJECT_ROOT, 'document-creation', 'cover-letter-generator', 'index.js'));

const JOB_DATA_DIR = path.join(PROJECT_ROOT, 'job-data');
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const COVER_LETTER_SCRIPT = path.join(PROJECT_ROOT, 'document-creation', 'cover-letter-generator', 'generate-from-job-data.js');
const COVER_LETTER_OUT_DIR = path.join(PROJECT_ROOT, 'document-creation', 'documents', 'coverletter');
const SEEK_ORIGIN = 'https://www.seek.com.au';

const _verb = parseInt(process.env.VERBOSITY, 10);
const VERBOSITY = Math.min(2, Math.max(0, Number.isInteger(_verb) ? _verb : 2));
const useSheet = process.env.JOB_APPLY_USE_SHEET === '1';

function log(level, ...args) {
  if (VERBOSITY >= level) console.log(...args);
}
const logStart = (...args) => log(1, ...args);
const logVerbose = (...args) => log(2, ...args);

/**
 * Take a screenshot and save to job-apply/screenshots/.
 * @param {import('playwright').Page} page
 * @param {string} [kind] - Label (e.g. 'apply-upload-screen')
 * @param {string} [id] - Optional id (e.g. job id) to make the filename easier to identify
 * @returns {Promise<string|null>} Path to saved file or null
 */
async function takeScreenshot(page, kind = 'screenshot', id = '') {
  if (!page || page.isClosed()) return null;
  try {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const idPart = id != null && String(id).trim() ? `${String(id).trim()}-` : '';
    const name = `${kind}-${idPart}${timestamp}.png`;
    const filePath = path.join(SCREENSHOTS_DIR, name);
    await page.screenshot({ path: filePath, fullPage: false });
    logVerbose('Screenshot saved:', filePath);
    return filePath;
  } catch (e) {
    logVerbose('Screenshot failed:', e.message);
    return null;
  }
}

async function waitForNetworkIdleOrTimeout(page, timeoutMs = 15000) {
  await Promise.race([
    page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {}),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
}

async function waitForPageReady(page, timeoutMs = 5000) {
  const loadOrIdle = Promise.race([
    page.waitForLoadState('load', { timeout: timeoutMs }).catch(() => {}),
    page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {}),
  ]);
  await Promise.race([loadOrIdle, new Promise((r) => setTimeout(r, timeoutMs))]);
}

function expectPage(condition, stageDescription) {
  if (!condition) {
    throw new Error(`Page state check failed: expected ${stageDescription}. Check job-apply/screenshots/ for the captured page.`);
  }
}

/**
 * Get jobs to process. For get started: first job from job-data. With JOB_APPLY_USE_SHEET=1: unapplied from sheet that have job-data.
 */
async function getJobsToApply() {
  if (useSheet) {
    const sheets = await SheetsManager.fromClientSecret();
    const unapplied = await sheets.getUnappliedJobs();
    const out = [];
    for (const row of unapplied) {
      const jobPath = path.join(JOB_DATA_DIR, `${row.jobId}.json`);
      if (!fs.existsSync(jobPath)) continue;
      const job = JSON.parse(fs.readFileSync(jobPath, 'utf-8'));
      out.push({ ...row, job, jobDataPath: jobPath });
    }
    return out;
  }
  const files = fs.readdirSync(JOB_DATA_DIR).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) {
    throw new Error('No job JSON files in job-data/. Run job search first.');
  }
  const firstFile = files[0];
  const jobDataPath = path.join(JOB_DATA_DIR, firstFile);
  const job = JSON.parse(fs.readFileSync(jobDataPath, 'utf-8'));
  const jobId = firstFile.replace(/\.json$/, '');
  const link = (job.link && job.link.trim()) || '';
  if (!link) throw new Error(`First job ${firstFile} has no link.`);
  return [{ jobId, link, positionName: job.positionName || '', company: job.company || '', job, jobDataPath }];
}

/**
 * Generate cover letter for a job via generate-from-job-data script.
 */
function generateCoverLetter(jobDataPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [COVER_LETTER_SCRIPT, jobDataPath, '--out', COVER_LETTER_OUT_DIR],
      { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Cover letter generator exited ${code}: ${stderr.slice(-500)}`));
    });
    child.on('error', reject);
  });
}

/**
 * Resolve path to the PDF cover letter for this job. If not found, run generate-from-job-data then look again.
 * @param {string} jobId - e.g. from job link /job/90276720
 * @param {string} jobDataPath - path to job JSON
 * @returns {Promise<string>} - absolute path to coverletter.pdf
 */
async function getCoverLetterPdfPath(jobId, jobDataPath) {
  const jobFolder = path.join(COVER_LETTER_OUT_DIR, jobId);
  const findPdf = () => {
    if (!fs.existsSync(jobFolder)) return null;
    const files = fs.readdirSync(jobFolder).filter((f) => f.endsWith('.pdf'));
    return files.length > 0 ? path.join(jobFolder, files[0]) : null;
  };
  let pdfPath = findPdf();
  if (pdfPath) return pdfPath;
  logStart('Cover letter PDF not found. Running generate-from-job-data...');
  await generateCoverLetter(jobDataPath);
  pdfPath = findPdf();
  if (!pdfPath) throw new Error(`Cover letter PDF still missing after generation. Check ${jobFolder}`);
  return pdfPath;
}

/**
 * Perform Seek login (dismiss popup, continue with email, fill email, request code, wait, fetch from Gmail, enter code).
 */
async function seekLogin(page) {
  const continueWithEmail = page.getByRole('link', { name: /continue with email/i });
  try {
    await continueWithEmail.waitFor({ state: 'visible', timeout: 8000 });
    await continueWithEmail.click();
  } catch {
    await waitForPageReady(page, 2000);
    const signInButton = page
      .getByRole('link', { name: /sign in/i })
      .or(page.getByRole('button', { name: /sign in/i }))
      .or(page.getByText(/sign in/i).first());
    await signInButton.first().waitFor({ state: 'attached', timeout: 10000 });
    await signInButton.first().scrollIntoViewIfNeeded().catch(() => {});
    const signInBox = await signInButton.first().boundingBox().catch(() => null);
    if (signInBox) {
      await page.mouse.click(signInBox.x + signInBox.width / 2, signInBox.y + signInBox.height / 2);
    } else {
      await signInButton.first().click({ force: true });
    }
    await continueWithEmail.waitFor({ state: 'visible', timeout: 8000 });
    const continueBox = await continueWithEmail.boundingBox().catch(() => null);
    if (continueBox) {
      await page.mouse.click(continueBox.x + continueBox.width / 2, continueBox.y + continueBox.height / 2);
    } else {
      await continueWithEmail.click();
    }
  }

  const emailField = page.getByLabel(/email address/i);
  await emailField.waitFor({ state: 'visible', timeout: 10000 });
  expectPage(await emailField.isVisible().catch(() => false), 'login: email field visible');
  await emailField.fill(process.env.LOGIN_EMAIL || '');

  const emailSignInCodeButton = page.getByRole('button', { name: /email me a sign in code/i });
  await emailSignInCodeButton.waitFor({ state: 'visible', timeout: 5000 });
  expectPage(await emailSignInCodeButton.isVisible().catch(() => false), 'login: Email me a sign in code button visible');
  await emailSignInCodeButton.click();

  const codeInputWait = page.getByLabel(/code|verification/i).first();
  await codeInputWait.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

  const waitSeconds = 10;
  logVerbose(`Stage: login — waiting ${waitSeconds}s for verification email...`);
  await new Promise((r) => setTimeout(r, waitSeconds * 1000));

  const gmail = await GmailManager.fromClientSecret();
  logStart('Checking Gmail for Seek verification code...');
  const codes = await gmail.findSeekVerificationCodes({ maxMessages: 5 });
  const latest = codes.length > 0 ? codes[0] : null;
  if (latest) {
    logStart('Seek verification code:', latest.code);
    const code = String(latest.code).replace(/\D/g, '').slice(0, 6);
    const singleInput = page.locator('input[inputmode="numeric"]').or(
      page.locator('input[type="tel"]').or(page.getByLabel(/code|verification|enter.*code/i).locator('input').first())
    ).first();
    const sixInputs = page.locator('input[inputmode="numeric"], input[type="tel"]');
    const singleVisible = await singleInput.isVisible().catch(() => false);
    const count = await sixInputs.count().catch(() => 0);
    if (count >= 6) {
      for (let i = 0; i < 6 && i < code.length; i++) {
        const box = sixInputs.nth(i);
        const b = await box.boundingBox().catch(() => null);
        if (b) {
          await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
          await page.keyboard.type(code[i], { delay: 50 });
        } else {
          await box.fill(code[i]);
        }
      }
    } else if (singleVisible) {
      const codeBox = await singleInput.boundingBox().catch(() => null);
      if (codeBox) await page.mouse.click(codeBox.x + codeBox.width / 2, codeBox.y + codeBox.height / 2);
      else await singleInput.click();
      await new Promise((r) => setTimeout(r, 300));
      await singleInput.fill('', { timeout: 2000 }).catch(() => {});
      await singleInput.fill(code, { timeout: 5000 });
    } else {
      const fallback = page.getByLabel(/code|verification/i).first();
      if (await fallback.isVisible().catch(() => false)) {
        const codeBox = await fallback.boundingBox().catch(() => null);
        if (codeBox) await page.mouse.click(codeBox.x + codeBox.width / 2, codeBox.y + codeBox.height / 2);
        else await fallback.click();
        await new Promise((r) => setTimeout(r, 300));
        await fallback.fill(code, { timeout: 5000 });
      }
    }
  } else {
    logStart('No Seek verification code found in recent emails.');
  }
}

/**
 * Check if current page is on Seek (not external redirect).
 */
function isSeekUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.hostname === 'www.seek.com.au' || u.hostname === 'seek.com.au';
  } catch {
    return false;
  }
}

async function main() {
  let browser;
  let page = null;
  let applicationTab = null;
  const applicationTabs = [];
  let pausedForVerification = false;
  const SEEK_URL = 'https://www.seek.com.au/';

  try {
    logStart('Job Apply starting (supervised — will not submit applications).');

    const jobs = await getJobsToApply();
    if (jobs.length === 0) {
      logStart('No jobs to apply for (sheet has no unapplied jobs with job-data, or job-data is empty).');
      return;
    }
    logStart(`Processing ${jobs.length} job(s).`);

    const first = jobs[0];
    const { jobId, link, positionName, company, jobDataPath } = first;

    logStart(`Job: ${positionName || '(no title)'} at ${company || '(no company)'} (${jobId})`);

    logStart('Generating cover letter...');
    await generateCoverLetter(jobDataPath);
    logStart('Cover letter generated.');

    // --- Same workflow as search script: setup, navigate, login (up until search form) ---
    logVerbose('Stage: launch browser');
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    page = await context.newPage();
    logVerbose('Stage: setup — page created');

    // --- Navigate to Seek (same as search) ---
    logVerbose('Stage: navigate — goto Seek home');
    await page.goto(SEEK_URL, { waitUntil: 'domcontentloaded' });
    logVerbose('Stage: navigate — waiting for networkidle (with 15s fallback) and page ready');
    await waitForNetworkIdleOrTimeout(page, 15000);
    await waitForPageReady(page, 5000);
    logVerbose('Stage: navigate — waiting for "Perform a job search" heading');
    const headingVisible = await page
      .getByRole('heading', { name: /perform a job search/i })
      .waitFor({ state: 'visible', timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    expectPage(headingVisible, 'home page with "Perform a job search" heading');
    logVerbose('Stage: navigate — home page ready');

    // --- Dismiss login popup: same as search (Continue with Email, or click Sign in to open it) ---
    logVerbose('Stage: login — dismiss popup (Continue with Email or Sign in)');
    const continueWithEmail = page.getByRole('link', { name: /continue with email/i });
    try {
      await continueWithEmail.waitFor({ state: 'visible', timeout: 8000 });
      await continueWithEmail.click();
    } catch {
      await waitForPageReady(page, 2000);
      const signInButton = page
        .getByRole('link', { name: /sign in/i })
        .or(page.getByRole('button', { name: /sign in/i }))
        .or(page.getByText(/sign in/i).first());
      await signInButton.first().waitFor({ state: 'attached', timeout: 10000 });
      await signInButton.first().scrollIntoViewIfNeeded().catch(() => {});
      const signInBox = await signInButton.first().boundingBox().catch(() => null);
      if (signInBox) {
        await page.mouse.click(signInBox.x + signInBox.width / 2, signInBox.y + signInBox.height / 2);
      } else {
        await signInButton.first().click({ force: true });
      }
      await continueWithEmail.waitFor({ state: 'visible', timeout: 8000 });
      const continueBox = await continueWithEmail.boundingBox().catch(() => null);
      if (continueBox) {
        await page.mouse.click(continueBox.x + continueBox.width / 2, continueBox.y + continueBox.height / 2);
      } else {
        await continueWithEmail.click();
      }
    }

    // --- Fill email, request code, wait, Gmail, enter code (same as search) ---
    const emailField = page.getByLabel(/email address/i);
    await emailField.waitFor({ state: 'visible', timeout: 10000 });
    expectPage(await emailField.isVisible().catch(() => false), 'login step: email address field visible');
    await emailField.fill(process.env.LOGIN_EMAIL || '');

    const emailSignInCodeButton = page.getByRole('button', { name: /email me a sign in code/i });
    await emailSignInCodeButton.waitFor({ state: 'visible', timeout: 5000 });
    expectPage(await emailSignInCodeButton.isVisible().catch(() => false), 'login step: "Email me a sign in code" button visible');
    logVerbose('Stage: login — requesting sign-in code (email)');
    await emailSignInCodeButton.click();

    logVerbose('Stage: login — waiting for verification code input');
    const codeInputWait = page.getByLabel(/code|verification/i).first();
    await codeInputWait.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

    const waitSeconds = 10;
    logVerbose(`Stage: login — waiting ${waitSeconds}s for verification email...`);
    await new Promise((r) => setTimeout(r, waitSeconds * 1000));

    const gmail = await GmailManager.fromClientSecret();
    logStart('Checking Gmail for Seek verification code...');
    const codes = await gmail.findSeekVerificationCodes({ maxMessages: 5 });
    const latest = codes.length > 0 ? codes[0] : null;
    if (latest) {
      logStart('Seek verification code:', latest.code);
      logVerbose('Stage: login — entering verification code');
      const code = String(latest.code).replace(/\D/g, '').slice(0, 6);
      const singleInput = page.locator('input[inputmode="numeric"]').or(
        page.locator('input[type="tel"]').or(page.getByLabel(/code|verification|enter.*code/i).locator('input').first())
      ).first();
      const sixInputs = page.locator('input[inputmode="numeric"], input[type="tel"]');
      const singleVisible = await singleInput.isVisible().catch(() => false);
      const count = await sixInputs.count().catch(() => 0);
      if (count >= 6) {
        for (let i = 0; i < 6 && i < code.length; i++) {
          const box = sixInputs.nth(i);
          const b = await box.boundingBox().catch(() => null);
          if (b) {
            await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
            await page.keyboard.type(code[i], { delay: 50 });
          } else {
            await box.fill(code[i]);
          }
        }
      } else if (singleVisible) {
        const codeBox = await singleInput.boundingBox().catch(() => null);
        if (codeBox) await page.mouse.click(codeBox.x + codeBox.width / 2, codeBox.y + codeBox.height / 2);
        else await singleInput.click();
        await new Promise((r) => setTimeout(r, 300));
        await singleInput.fill('', { timeout: 2000 }).catch(() => {});
        await singleInput.fill(code, { timeout: 5000 });
      } else {
        const fallback = page.getByLabel(/code|verification/i).first();
        if (await fallback.isVisible().catch(() => false)) {
          const codeBox = await fallback.boundingBox().catch(() => null);
          if (codeBox) await page.mouse.click(codeBox.x + codeBox.width / 2, codeBox.y + codeBox.height / 2);
          else await fallback.click();
          await new Promise((r) => setTimeout(r, 300));
          await fallback.fill(code, { timeout: 5000 });
        }
      }
    } else {
      logStart('No Seek verification code found in recent emails.');
    }

    // --- Divergence: search script would fill search form here; we open job links in tabs instead ---
    await waitForPageReady(page, 5000);

    const fullLink = link.startsWith('http') ? link : new URL(link, SEEK_ORIGIN).href;

    if (applicationTabs.length >= 2) {
      const old = applicationTabs.shift();
      if (old && !old.isClosed()) await old.close().catch(() => {});
    }
    applicationTab = await context.newPage();
    applicationTabs.push(applicationTab);

    logStart('Stage: open job page');
    await applicationTab.goto(fullLink, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await waitForPageReady(applicationTab, 5000);

    const currentUrl = applicationTab.url();
    if (!isSeekUrl(currentUrl)) {
      logStart('External redirect detected. Closing tab and skipping (not marking as applied).');
      await applicationTab.close().catch(() => {});
      await takeScreenshot(page, 'external-redirect', jobId);
      return;
    }

    await takeScreenshot(applicationTab, 'job-page', jobId);

    const applyLink = applicationTab.getByRole('link', { name: /quick apply|apply/i }).first();
    const applyButton = applicationTab.getByRole('button', { name: /quick apply|apply/i }).first();
    const applyVisible = await applyLink.isVisible().catch(() => false) || await applyButton.isVisible().catch(() => false);
    if (applyVisible) {
      await applyLink.click().catch(() => applyButton.click());
      await waitForPageReady(applicationTab, 8000);
    } else {
      const anyApply = applicationTab.locator('a[href*="apply"], button').filter({ hasText: /apply/i }).first();
      await anyApply.click({ timeout: 5000 }).catch(() => {});
      await waitForPageReady(applicationTab, 8000);
    }

    const afterApplyUrl = applicationTab.url();
    if (!isSeekUrl(afterApplyUrl)) {
      logStart('Redirected to external site after Apply. Closing tab and skipping.');
      await applicationTab.close().catch(() => {});
      await takeScreenshot(page, 'external-after-apply', jobId);
      return;
    }

    await applicationTab.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));

    const hasUpload =
      (await applicationTab.getByText(/cover letter|resume|upload|attach|cv/i).first().isVisible().catch(() => false)) ||
      (await applicationTab.locator('input[type="file"]').first().isVisible().catch(() => false));
    if (hasUpload) {
      logStart('Reached screen with cover letter/resume upload or select.');
    }
    await takeScreenshot(applicationTab, 'apply-upload-screen', jobId);

    // Leave resume as default (no change). Scroll to cover letter, select "Upload a cover letter", upload PDF, then pause.
    const coverLetterHeading = applicationTab.getByText(/cover letter/i).first();
    await coverLetterHeading.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));

    const uploadCoverLetterOption = applicationTab.getByRole('radio', { name: /upload a cover letter/i }).first();
    await uploadCoverLetterOption.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    await uploadCoverLetterOption.click();
    await new Promise((r) => setTimeout(r, 800));

    const pdfPath = await getCoverLetterPdfPath(jobId, jobDataPath);
    logStart('Using cover letter PDF:', pdfPath);

    const jobFolder = path.dirname(pdfPath);
    const txtFiles = fs.existsSync(jobFolder) ? fs.readdirSync(jobFolder).filter((f) => f.endsWith('.txt')) : [];
    const txtPath = txtFiles.length > 0 ? path.join(jobFolder, txtFiles[0]) : null;
    if (!txtPath) throw new Error(`Cover letter .txt not found in ${jobFolder}`);
    const coverLetterText = fs.readFileSync(txtPath, 'utf-8');
    const check = runCoverLetterChecks(coverLetterText);
    if (!check.ok) {
      const msg = `Cover letter failed checks: ${check.errors.join('; ')}`;
      logStart(msg);
      throw new Error(msg);
    }
    logStart('Cover letter checks passed.');

    const coverLetterFileInput = applicationTab
      .locator('section, [role="group"], div')
      .filter({ has: applicationTab.getByText(/cover letter/i).first() })
      .locator('input[type="file"]')
      .first();
    await coverLetterFileInput.waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
    const fileInput = applicationTab.locator('input[type="file"]');
    const count = await fileInput.count();
    const coverLetterInput = count >= 2 ? fileInput.nth(1) : fileInput.first();
    await coverLetterInput.setInputFiles(pdfPath, { timeout: 5000 });

    await new Promise((r) => setTimeout(r, 1000));
    await takeScreenshot(applicationTab, 'cover-letter-uploaded');

    pausedForVerification = true;
    logStart('Pausing on this page for verification. Close the browser or press Ctrl+C when done.');
    await new Promise(() => {});
  } catch (err) {
    let errMsg = err.message || String(err);
    if (page && !page.isClosed()) {
      try {
        const u = await page.url();
        if (u) errMsg += ` (page URL: ${u})`;
      } catch (_) {}
      const screenshotPath = await takeScreenshot(page, 'error', jobId);
      if (screenshotPath) logStart('Error screenshot saved:', screenshotPath);
    }
    if (applicationTab && applicationTab !== page && !applicationTab.isClosed()) {
      const tabScreenshotPath = await takeScreenshot(applicationTab, 'error-application-tab', jobId);
      if (tabScreenshotPath) logStart('Error screenshot (application tab) saved:', tabScreenshotPath);
    }
    logStart('Error:', errMsg);
    throw err;
  } finally {
    if (browser && !pausedForVerification) await browser.close();
  }
}

main().catch((err) => {
  if (VERBOSITY >= 1) console.error(err);
  process.exit(1);
});
