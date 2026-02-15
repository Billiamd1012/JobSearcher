/**
 * Seek Job Search — Playwright script (outline only)
 *
 * Goal: Use Playwright to search for jobs on Seek and save each listing
 * as a JSON file in ./job-data/ for use in later steps (cover letters,
 * spreadsheet updates, etc.).
 *
 * ========== PSEUDOCODE OUTLINE ==========
 *
 * 1. SETUP
 *    - Launch browser (Chromium; consider headless vs headed for debugging)
 *    - Create new page
 *    - Set viewport / user-agent if needed to avoid blocks
 *
 * 2. NAVIGATE TO SEEK
 *    - Go to Seek job search URL (e.g. main search or region-specific)
 *    - Wait for search form / results area to be ready
 *
 * 3. APPLY SEARCH CRITERIA
 *    - Fill in job title / keywords input
 *    - Set location if required
 *    - Apply any filters (e.g. job type, date posted, salary)
 *    - Submit search or trigger search
 *    - Wait for results to load (network idle or selector for first result)
 *
 * 4. COLLECT JOB LISTINGS (with pagination)
 *    - Loop until no more pages (or hit a page limit):
 *      a. Find all job card / listing elements on current page
 *      b. For each listing:
 *           - Extract: job title, company name, job URL, location,
 *             description snippet, posted date, any other useful fields
 *           - Build a job object
 *           - Generate a safe filename (e.g. slug from title + id or timestamp)
 *           - Write job object as JSON to ./job-data/<filename>.json
 *      c. If "next page" / pagination exists:
 *           - Click next (or go to next page URL)
 *           - Wait for new results to load
 *      d. Else: break
 *
 * 5. CLEANUP
 *    - Close browser
 *    - Optionally log summary (e.g. number of jobs saved)
 *
 * 6. EDGE CASES / LATER CONSIDERATIONS
 *    - Deduplication: skip or overwrite if we already have this job ID/URL in job-data
 *    - Rate limiting: optional small delay between pages or between requests
 *    - Login: if Seek requires login to see full results, add auth step
 *    - Captcha / bot detection: may need to slow down or use headed mode
 *    - Error handling: retry failed pages, log failures, don’t crash on single bad listing
 *
 * Output: One JSON file per job in ./job-data/
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, 'config', '.env') });
const { chromium } = require('playwright');
const { GmailManager } = require('./gmail-api');

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const JOB_DATA_DIR = path.join(__dirname, 'job-data');

// Verbosity (set VERBOSITY=0|1|2 in env): 0 = no logs, 1 = start + errors, 2 = full verbose (default)
const _verb = parseInt(process.env.VERBOSITY, 10);
const VERBOSITY = Math.min(2, Math.max(0, Number.isInteger(_verb) ? _verb : 2));

function log(level, ...args) {
  if (VERBOSITY >= level) console.log(...args);
}
const logStart = (...args) => log(1, ...args);
const logVerbose = (...args) => log(2, ...args);

/**
 * Save a screenshot of the current page to the screenshots folder.
 * @param {import('playwright').Page | null} page
 * @param {string} kind - e.g. 'finished' or 'error'
 * @returns {Promise<string | null>} path of saved file, or null
 */
async function takeScreenshot(page, kind = 'screenshot') {
  if (!page || page.isClosed()) return null;
  try {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    const name = `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    const filePath = path.join(SCREENSHOTS_DIR, name);
    await page.screenshot({ path: filePath, fullPage: false });
    logVerbose('Screenshot saved:', filePath);
    return filePath;
  } catch (e) {
    logVerbose('Screenshot failed:', e.message);
    return null;
  }
}

/**
 * Parse Seek "Posted X ago" text and return date string dd/mm/yyyy from reference date.
 * @param {string} text - e.g. "Posted 3d ago", "Posted 1w ago", "Posted today", "Posted yesterday"
 * @param {Date} [refDate] - reference date (default: now)
 * @returns {string} dd/mm/yyyy or empty string if unparseable
 */
function parsePostedDate(text, refDate = new Date()) {
  if (!text || typeof text !== 'string') return '';
  const t = text.trim();
  const today = new Date(refDate);
  today.setHours(0, 0, 0, 0);
  let d = new Date(today);
  if (/posted\s+today/i.test(t)) {
    // already d
  } else if (/posted\s+yesterday/i.test(t)) {
    d.setDate(d.getDate() - 1);
  } else {
    const match = t.match(/posted\s+(\d+)\s*(d|w|mo|m)\s+ago/i);
    if (!match) return '';
    const n = parseInt(match[1], 10);
    const unit = (match[2] || '').toLowerCase();
    if (unit === 'd') d.setDate(d.getDate() - n);
    else if (unit === 'w') d.setDate(d.getDate() - n * 7);
    else if (unit === 'mo' || unit === 'm') {
      const day = d.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() - n);
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, lastDay));
    } else return '';
  }
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

/**
 * Normalize scraped work type to one of: Full Time, Part Time, Contract, Casual.
 * @param {string} raw - Raw text e.g. "This is a full time job" or "Contract"
 * @returns {string}
 */
function normalizeWorkType(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const t = raw.trim().toLowerCase();
  if (/full\s*time/.test(t)) return 'Full Time';
  if (/part\s*time/.test(t)) return 'Part Time';
  if (/contract/.test(t)) return 'Contract';
  if (/casual/.test(t)) return 'Casual';
  return '';
}

/**
 * Generate a safe filename for a job JSON file (no extension).
 * Prefers job ID from Seek URL (/job/12345678), else slug from title + timestamp.
 * @param {{ link?: string, positionName?: string }} job
 * @returns {string}
 */
function jobDataFilename(job) {
  const link = job.link || '';
  const idMatch = link.match(/\/job\/(\d+)/);
  if (idMatch) return idMatch[1];
  const slug = (job.positionName || 'job')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'job';
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${slug}-${ts}`;
}

/**
 * Wait for network idle with a fallback timer. Proceeds after timeoutMs even if
 * network never goes idle, so we don't throw and can continue interaction.
 * @param {import('playwright').Page} page
 * @param {number} [timeoutMs] - max wait (default 15000)
 */
async function waitForNetworkIdleOrTimeout(page, timeoutMs = 15000) {
  await Promise.race([
    page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {}),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
}

/**
 * Wait for page load or network-idle, with a timeout (used before search page only).
 * Never throws: proceeds after timeoutMs if load/networkidle don't fire.
 * @param {import('playwright').Page} page
 * @param {number} [timeoutMs]
 */
async function waitForPageReady(page, timeoutMs = 5000) {
  const loadOrIdle = Promise.race([
    page.waitForLoadState('load', { timeout: timeoutMs }).catch(() => {}),
    page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {}),
  ]);
  await Promise.race([
    loadOrIdle,
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
}

/**
 * Wait for LCP or timeout (used from search results onward).
 * @param {import('playwright').Page} page
 * @param {number} [timeoutMs]
 */
async function waitForLCPOrTimeout(page, timeoutMs = 2500) {
  const lcpPromise = page
    .evaluate((maxMs) => {
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(t);
          resolve();
        };
        const t = setTimeout(done, maxMs);
        if (
          typeof PerformanceObserver === 'undefined' ||
          !PerformanceObserver.supportedEntryTypes?.includes('largest-contentful-paint')
        ) {
          done();
          return;
        }
        try {
          const observer = new PerformanceObserver(() => done());
          observer.observe({ type: 'largest-contentful-paint', buffered: true });
          const existing = performance.getEntriesByType('largest-contentful-paint');
          if (existing.length > 0) done();
        } catch {
          done();
        }
      });
    }, timeoutMs)
    .catch(() => {});
  await Promise.race([lcpPromise, new Promise((r) => setTimeout(r, timeoutMs))]);
}

/** Throw with a clear message so the catch block can take a screenshot. */
function expectPage(condition, stageDescription) {
  if (!condition) {
    throw new Error(`Page state check failed: expected ${stageDescription}. Check screenshots/ for the captured page.`);
  }
}

/**
 * Scrape job description from a Seek job detail page (tab already loaded).
 * Tries data-automation selectors first, then fallbacks. Waits for content to appear (JS-rendered).
 * @param {import('playwright').Page} jobPage - Page on a Seek job URL (e.g. /job/12345)
 * @returns {Promise<string>} Description text or empty string
 */
async function scrapeJobDescription(jobPage) {
  const DESCRIPTION_WAIT_MS = 10000;
  const MIN_DESCRIPTION_LENGTH = 50;

  const selectors = [
    '[data-automation="jobAdDetails"]',
    '[data-automation="jobDescription"]',
    'article[data-automation="jobDetail"]',
    '[data-automation="job-detail"]',
    'article section',
    'section[class*="description"], div[class*="description"]',
  ];

  for (const selector of selectors) {
    const locator = jobPage.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: DESCRIPTION_WAIT_MS });
      const text = await locator.innerText().catch(() => null);
      if (text && text.trim().length >= MIN_DESCRIPTION_LENGTH) {
        logVerbose('Stage: job page — description scraped from', selector);
        return text.trim();
      }
    } catch {
      // Selector not found or empty; try next
    }
  }

  // Fallback: any block that looks like job ad body (has "About" / "Responsibilities" / "You" etc.)
  const bodyCandidates = jobPage.locator('section, article, [role="main"]').filter({
    has: jobPage.locator('h2, h3, h4, strong').filter({ hasText: /about|role|responsibilities|you|requirements|description/i }),
  });
  const count = await bodyCandidates.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const el = bodyCandidates.nth(i);
    const text = await el.innerText().catch(() => null);
    if (text && text.trim().length >= MIN_DESCRIPTION_LENGTH) {
      logVerbose('Stage: job page — description scraped from section/article fallback');
      return text.trim();
    }
  }

  return '';
}

async function main() {
  let browser;
  let page = null;
  try {
    logStart('Seek Job Search starting...');

    // --- 1. SETUP ---
    logVerbose('Stage: setup — launching browser');
    browser = await chromium.launch({
      headless: false,
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    page = await context.newPage();
    logVerbose('Stage: setup — page created');

    // --- 2. NAVIGATE TO SEEK ---
    const SEEK_URL = 'https://www.seek.com.au/';
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

    // Dismiss login popup: wait for "Continue with Email", or click Sign in to open it
    logVerbose('Stage: login — dismiss popup (Continue with Email or Sign in)');
    const continueWithEmail = page.getByRole('link', {
      name: /continue with email/i,
    });
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

    // Fill email on login page
    const emailField = page.getByLabel(/email address/i);
    await emailField.waitFor({ state: 'visible', timeout: 10000 });
    expectPage(await emailField.isVisible().catch(() => false), 'login step: email address field visible');
    await emailField.fill(process.env.LOGIN_EMAIL || '');

    const emailSignInCodeButton = page.getByRole('button', {
      name: /email me a sign in code/i,
    });
    await emailSignInCodeButton.waitFor({ state: 'visible', timeout: 5000 });
    expectPage(await emailSignInCodeButton.isVisible().catch(() => false), 'login step: "Email me a sign in code" button visible');

    logVerbose('Stage: login — requesting sign-in code (email)');
    await emailSignInCodeButton.click();

    // Wait for verification code input to appear, then fixed wait for email, then fetch and enter code
    logVerbose('Stage: login — waiting for verification code input');
    const codeInputWait = page.getByLabel(/code|verification/i).first();
    await codeInputWait.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

    const waitSeconds = 10;
    logVerbose(`Stage: login — waiting ${waitSeconds}s for verification email...`);
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));

    const gmail = await GmailManager.fromClientSecret();
    logStart('Checking Gmail for Seek verification code...');
    const codes = await gmail.findSeekVerificationCodes({ maxMessages: 5 });
    const latest = codes.length > 0 ? codes[0] : null;
    if (latest) {
      logStart('Seek verification code:', latest.code);
      logVerbose('Stage: login — entering verification code');
      const code = String(latest.code).replace(/\D/g, '').slice(0, 6);
      // Re-query inputs after Gmail fetch (avoid stale element); try single input or 6 separate OTP boxes
      const singleInput = page.locator('input[inputmode="numeric"]').or(
        page.locator('input[type="tel"]').or(
          page.getByLabel(/code|verification|enter.*code/i).locator('input').first()
        )
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
        logVerbose('Stage: login — entered code into 6 separate inputs');
      } else if (singleVisible) {
        const codeBox = await singleInput.boundingBox().catch(() => null);
        if (codeBox) {
          await page.mouse.click(codeBox.x + codeBox.width / 2, codeBox.y + codeBox.height / 2);
        } else {
          await singleInput.click();
        }
        await new Promise((r) => setTimeout(r, 300));
        await singleInput.fill('', { timeout: 2000 }).catch(() => {});
        await singleInput.fill(code, { timeout: 5000 });
        logVerbose('Stage: login — entered code into single input');
      } else {
        const fallback = page.getByLabel(/code|verification/i).first();
        if (await fallback.isVisible().catch(() => false)) {
          const codeBox = await fallback.boundingBox().catch(() => null);
          if (codeBox) {
            await page.mouse.click(codeBox.x + codeBox.width / 2, codeBox.y + codeBox.height / 2);
          } else {
            await fallback.click();
          }
          await new Promise((r) => setTimeout(r, 300));
          await fallback.fill(code, { timeout: 5000 });
          logVerbose('Stage: login — entered code via label fallback');
        }
      }
    } else {
      logStart('No Seek verification code found in recent emails (from:seek.com.au newer_than:1d).');
      logVerbose('No Seek verification code found in recent emails.');
    }

    // --- 3. APPLY SEARCH CRITERIA (on main search page) ---
    logVerbose('Stage: search criteria — waiting for post-login page, then navigating to Seek home');
    logVerbose('Entering search criteria: Classification ICT, subcategories Developer/Programmers, Engineering - Software, Testing & QA, Web Development; Where: All Adelaide SA');
    await waitForPageReady(page, 5000);
    try {
      await page.goto(SEEK_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
      if (err.message && !err.message.includes('ERR_ABORTED')) throw err;
    }
    await waitForPageReady(page, 10000);
    // Allow extra time for post-login page to finish loading before failing (retry every 5s, up to 30s)
    const searchFormWaitMs = 30000;
    const searchFormPollMs = 5000;
    const searchFormDeadline = Date.now() + searchFormWaitMs;
    let searchFormVisible = false;
    while (Date.now() < searchFormDeadline) {
      const ictVisible = await page.getByText(/information\s*&\s*communication\s*technology/i).first().isVisible().catch(() => false);
      const anyClassificationVisible = await page.getByRole('button', { name: /any classification/i }).first().isVisible().catch(() => false)
        || await page.getByText(/any classification/i).first().isVisible().catch(() => false);
      searchFormVisible = ictVisible || anyClassificationVisible;
      if (searchFormVisible) break;
      logVerbose('Stage: search criteria — search form not yet visible, waiting...');
      await new Promise((r) => setTimeout(r, searchFormPollMs));
    }
    expectPage(searchFormVisible, 'search page with Information & Communication Technology or Any classification (after login)');

    // Open classification dropdown
    const anyClassificationButton = page
      .getByRole('button', { name: /any classification/i })
      .or(page.getByText(/any classification/i).first());
    await anyClassificationButton.click();
    await waitForPageReady(page, 1500);

    // Select classification: Information & Communication Technology
    const ictClassification = page.getByRole('link', { name: /information\s*&\s*communication\s*technology/i }).or(
      page.getByText(/information\s*&\s*communication\s*technology/i).first()
    );
    await ictClassification.first().click();
    await waitForPageReady(page, 1500);
    logVerbose('Stage: search criteria — ICT selected');

    // Select subcategories
    logVerbose('Stage: search criteria — selecting subcategories');
    const subcategories = [
      /developer\/programmers/i,
      /engineering\s*-\s*software/i,
      /testing\s*&\s*quality\s*assurance/i,
      /web\s*development\s*&\s*production/i,
    ];
    for (const sub of subcategories) {
      const el = page.getByRole('checkbox', { name: sub }).or(page.getByText(sub).first());
      if (await el.first().isVisible().catch(() => false)) {
        await el.first().click();
        await waitForPageReady(page, 500);
      }
    }
    logVerbose('Stage: search criteria — subcategories selected');

    // Where: physical click on field, then enter All Adelaide SA
    logVerbose('Stage: search criteria — filling Where (All Adelaide SA)');
    const whereField = page
      .getByPlaceholder(/enter suburb, city, or region/i)
      .or(page.getByLabel(/where/i))
      .first();
    await whereField.waitFor({ state: 'visible', timeout: 10000 });
    expectPage(await whereField.isVisible().catch(() => false), 'Where field visible');
    const box = await whereField.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    } else {
      await whereField.click();
    }
    await whereField.fill('All Adelaide SA');
    await waitForPageReady(page, 2000);
    const adelaideOption = page.getByRole('option', { name: /all adelaide\s*sa/i }).or(
      page.getByText(/all adelaide\s*sa/i).first()
    );
    await adelaideOption.first().click();
    await waitForPageReady(page, 1000);

    // Submit search
    const searchForm = page.locator('form').filter({
      has: page.getByPlaceholder(/enter suburb, city, or region/i),
    }).first();
    const submitBtn = searchForm.getByRole('button', { name: /search|find jobs|submit/i })
      .or(searchForm.locator('button[type="submit"]'))
      .or(searchForm.locator('input[type="submit"]'));
    const submitVisible = await submitBtn.first().isVisible().catch(() => false);
    expectPage(submitVisible, 'Search submit button visible before submit');
    if (submitVisible) {
      await submitBtn.first().click();
    } else {
      const searchButton = page.getByRole('button', { name: /^search$/i });
      await searchButton.first().click();
    }

    // Wait for search results and scrape all job cards on the first page (total wait ≤ 8s)
    logVerbose('Stage: results — waiting for search results URL and first job link');
    await page.waitForURL(/\/job\/|search|jobs-in/, { timeout: 5000 }).catch(() => {});
    const urlAfterSubmit = page.url();
    const isSearchOrJobUrl = /\/job\/|search|jobs-in/.test(urlAfterSubmit);
    expectPage(isSearchOrJobUrl, `URL after submit should be search or job page, got: ${urlAfterSubmit}`);

    // Wait for the first job link to be in the DOM (attached). Seek often keeps the link hidden (e.g. overlay);
    // we only need it present to read href, so use 'attached' not 'visible'. (5s + 3s = 8s max total above)
    const firstJobLink = page.locator('[data-automation="jobCard"] a[href*="/job/"], article a[href*="/job/"]').first();
    await firstJobLink.waitFor({ state: 'attached', timeout: 3000 });
    const jobCards = page.locator('[data-automation="jobCard"]').or(
      page.locator('article').filter({ has: page.locator('a[href*="/job/"]') })
    );
    const cardCount = await jobCards.count();
    expectPage(cardCount > 0, 'at least one job card on search results page');
    logStart(`Stage: results — scraping ${cardCount} jobs from first page`);

    fs.mkdirSync(JOB_DATA_DIR, { recursive: true });

    for (let i = 0; i < cardCount; i++) {
      const card = jobCards.nth(i);
      logVerbose(`Stage: job ${i + 1}/${cardCount} — scraping card`);

      const CARD_SCRAPE_MS = 3000;
      const linkOverlay = card.locator('[data-automation="job-list-item-link-overlay"]').first();
      const linkAnchor = card.locator('a[href*="/job/"]').first();
      let link = (await linkOverlay.getAttribute('href', { timeout: CARD_SCRAPE_MS }).catch(() => null)) || (await linkAnchor.getAttribute('href', { timeout: CARD_SCRAPE_MS }).catch(() => null));
      if (link && !link.startsWith('http')) link = new URL(link, 'https://www.seek.com.au').href;
      link = link || '';

      const positionName =
        (await card.locator('[data-automation="jobTitle"]').first().textContent({ timeout: CARD_SCRAPE_MS }).catch(() => null))?.trim() ||
        (await linkAnchor.textContent({ timeout: CARD_SCRAPE_MS }).catch(() => null))?.trim() ||
        '';

      const company =
        (await card.locator('[data-automation="companyName"]').first().textContent({ timeout: CARD_SCRAPE_MS }).catch(() => null))?.trim() ||
        (await card.locator('[data-automation="jobCompany"]').first().textContent({ timeout: CARD_SCRAPE_MS }).catch(() => null))?.trim() ||
        '';

      const location =
        (await card.locator('[data-automation="jobLocation"]').first().textContent({ timeout: CARD_SCRAPE_MS }).catch(() => null))?.trim() ||
        (await card.getByText(/,?\s*(Adelaide|SA|Sydney|Melbourne|Brisbane|Perth|Canberra)/).first().textContent({ timeout: CARD_SCRAPE_MS }).catch(() => null))?.trim() ||
        '';

      const typeRaw =
        (await card.locator('[data-automation="jobWorkType"]').first().textContent({ timeout: CARD_SCRAPE_MS }).catch(() => null))?.trim() ||
        (await card.getByText(/full time|part time|contract|casual/i).first().textContent({ timeout: CARD_SCRAPE_MS }).catch(() => null))?.trim() ||
        '';
      const type = normalizeWorkType(typeRaw) || typeRaw;

      let posted =
        (await card.locator('[data-automation="jobListingDate"]').first().textContent({ timeout: CARD_SCRAPE_MS }).catch(() => null))?.trim() ||
        (await card.getByText(/\d{1,2}\/\d{1,2}\/\d{2,4}|today|yesterday|\d+\s*day/i).first().textContent({ timeout: CARD_SCRAPE_MS }).catch(() => null))?.trim() ||
        '';

      const job = { positionName, company, posted, type, location, link };

      if (!link) {
        logStart(`Job ${i + 1}/${cardCount} skipped (no link): ${positionName || '(no title)'}`);
        continue;
      }

      logVerbose('Stage: job details — opening job in new tab via scraped link');
      const jobPage = await context.newPage();
      try {
        await jobPage.goto(link, { waitUntil: 'domcontentloaded', timeout: 8000 });
      } catch (navErr) {
        await jobPage.close().catch(() => {});
        logStart(`Job ${i + 1}/${cardCount} failed to load: ${link} — ${navErr.message}`);
        continue;
      }
      if (jobPage && !jobPage.isClosed()) {
        logVerbose('Stage: job page — reading posted date and full description');
        await jobPage.waitForLoadState('domcontentloaded').catch(() => {});
        await waitForLCPOrTimeout(jobPage, 2500);
        await jobPage.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        if (i === 0) {
          logVerbose('Stage: two tabs open — saving screenshots two-tabs-search and two-tabs-job');
          await takeScreenshot(page, 'two-tabs-search');
          await takeScreenshot(jobPage, 'two-tabs-job');
        }
        const postedSpan = jobPage.locator('span').filter({ hasText: /^Posted\s+/i }).first();
        const postedText = await postedSpan.textContent().catch(() => null);
        if (postedText) {
          const calculated = parsePostedDate(postedText);
          if (calculated) job.posted = calculated;
        }
        job.description = await scrapeJobDescription(jobPage);
        await jobPage.close();
      } else {
        job.description = '';
      }

      logStart(`Job ${i + 1}/${cardCount}: ${positionName || '(no title)'}${company ? ` at ${company}` : ''}`);
      const filename = jobDataFilename(job) + '.json';
      const jobDataPath = path.join(JOB_DATA_DIR, filename);
      if (fs.existsSync(jobDataPath)) {
        fs.unlinkSync(jobDataPath);
        logVerbose('Removed existing job file (same id):', jobDataPath);
      }
      fs.writeFileSync(jobDataPath, JSON.stringify(job, null, 2), 'utf-8');
      logStart('Job data saved:', jobDataPath);
    }

    logStart(`Scraped ${cardCount} job(s) from first page.`);
    await takeScreenshot(page, 'finished');

    logVerbose('Stage: done — pausing then closing browser');
    // Brief pause before closing so user can see result
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } catch (err) {
    let errMsg = err.message || String(err);
    if (page && !page.isClosed()) {
      try {
        const pageUrl = await page.url();
        if (pageUrl) errMsg += ` (page URL: ${pageUrl})`;
      } catch {
        // ignore url() failure
      }
    }
    logStart('Error:', errMsg);
    await takeScreenshot(page, 'error');
    err.message = errMsg;
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}

main().catch((err) => {
  if (VERBOSITY >= 1) console.error(err);
  process.exit(1);
});
