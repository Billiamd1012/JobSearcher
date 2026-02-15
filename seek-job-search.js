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

require('dotenv').config();
const { chromium } = require('playwright');

async function main() {
  let browser;
  try {
    // --- 1. SETUP ---
    browser = await chromium.launch({
      headless: false, // set to false for debugging
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // --- 2. NAVIGATE TO SEEK ---
    const SEEK_URL = 'https://www.seek.com.au/';
    await page.goto(SEEK_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    await page
      .getByRole('heading', { name: /perform a job search/i })
      .waitFor({ state: 'visible', timeout: 15000 });

    // Dismiss login popup: wait for "Continue with Email", or click Sign in to open it
    const continueWithEmail = page.getByRole('link', {
      name: /continue with email/i,
    });
    try {
      await continueWithEmail.waitFor({ state: 'visible', timeout: 8000 });
      await continueWithEmail.click();
    } catch {
      const signInButton = page.getByRole('link', { name: /sign in/i });
      await signInButton.waitFor({ state: 'visible', timeout: 5000 });
      await signInButton.click();
      await continueWithEmail.waitFor({ state: 'visible', timeout: 8000 });
      await continueWithEmail.click();
    }

    // Fill email on login page
    const emailField = page.getByLabel(/email address/i);
    await emailField.waitFor({ state: 'visible', timeout: 10000 });
    await emailField.fill(process.env.LOGIN_EMAIL || '');

    const emailSignInCodeButton = page.getByRole('button', {
      name: /email me a sign in code/i,
    });
    await emailSignInCodeButton.waitFor({ state: 'visible', timeout: 5000 });
    await emailSignInCodeButton.click();

    // TODO: 3. Apply search criteria
    // TODO: 4. Collect job listings (with pagination)

    // Show browser for 10 seconds before closing
    await new Promise((resolve) => setTimeout(resolve, 20000));
  } finally {
    if (browser) await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
