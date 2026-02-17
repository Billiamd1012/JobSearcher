/**
 * Cover Letter Generator — library of tools for creating cover letter documents.
 *
 * Steps 2–7: Ollama lifecycle, prompt construction, LLM call (with retry), post-process, write .txt/.docx/.pdf, cleanup.
 * This module does not load job data or run a CLI; it only exports functions and constants.
 *
 * To generate from the job-data folder, run: node document-creation/cover-letter-generator/generate-from-job-data.js
 *
 * Env: OLLAMA_MODEL, OLLAMA_BASE_URL, COVER_LETTER_OUTPUT_FORMAT, APPLICANT_NAME, APPLICANT_LAST_NAME,
 * COVER_LETTER_STOP_OLLAMA, OLLAMA_RETRY_ATTEMPTS, OLLAMA_RETRY_DELAY_MS.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const { Document, Paragraph, TextRun, Packer } = require('docx');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DOCUMENTS_DIR = path.join(__dirname, '..', 'documents');
const DEFAULT_OUTPUT_DIR = path.join(DOCUMENTS_DIR, 'coverletter');
const DEFAULT_RESUME_DIR = path.join(DOCUMENTS_DIR, 'resume');
const DEFAULT_COVERLETTER_DIR = path.join(DOCUMENTS_DIR, 'coverletter');
const DEFAULT_APPLICANT_DETAILS_DIR = path.join(DOCUMENTS_DIR, 'details', 'applicant-details');
const DEFAULT_PROMPT_PATH = path.join(DOCUMENTS_DIR, 'prompts', 'cover-letter-default.txt');

const DEFAULT_PROMPT_TEMPLATE = `You are a professional cover letter writer. Write a concise, tailored cover letter for the following job application. Use a formal but warm tone. Do not invent qualifications; align the letter with the candidate's background when provided.

Company: {{company}}
Role: {{positionName}}
Location: {{location}}
Job type: {{type}}

Job description:
---
{{description}}
---

Applicant context (use only if provided):
{{applicantName}}
{{resumeSnippet}}

{{coverLetterSection}}

Instructions:
- Address the letter to the hiring team or "Hiring Manager" if no name is given.
- Open with a short paragraph stating the role and company you are applying to.
- In one or two paragraphs, connect your experience and motivation to the role and company (use resume/context above if provided).
- Close with a brief sign-off (e.g. "Yours sincerely") followed by a placeholder for the applicant's name: [Your full name] or the applicant name if provided.
- Keep the letter to one page when possible (roughly 250–400 words).
- Output only the cover letter text, no meta-commentary or markdown.

Cover letter:
`;

const SUPPORTED_DOC_EXTENSIONS = ['.txt', '.docx', '.pdf'];
const SAMPLE_COVER_LETTER_NAMES = [
  'sample.txt', 'sample.docx', 'sample.pdf',
  'sample-cover-letter.txt', 'sample-cover-letter.docx', 'sample-cover-letter.pdf',
  'example.txt', 'example.docx', 'example.pdf',
  'example-cover-letter.txt', 'example-cover-letter.docx', 'example-cover-letter.pdf',
];

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_READY_TIMEOUT_MS = 60000;
const OLLAMA_POLL_MS = 500;
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
const OLLAMA_GENERATE_TIMEOUT_MS = 120000;
const OLLAMA_MAX_TOKENS = 1024;
const OLLAMA_TEMPERATURE = 0.7;
const OLLAMA_STOP = ['\n\n\n', '---']; // stop on triple newline or markdown divider
const COVER_LETTER_OUTPUT_FORMAT = (process.env.COVER_LETTER_OUTPUT_FORMAT || 'docx').toLowerCase(); // 'txt' | 'docx'
const OLLAMA_RETRY_ATTEMPTS = Math.max(0, parseInt(process.env.OLLAMA_RETRY_ATTEMPTS || '2', 10));
const OLLAMA_RETRY_DELAY_MS = Math.max(0, parseInt(process.env.OLLAMA_RETRY_DELAY_MS || '2000', 10));
const COVERLETTER_BASENAME = 'coverletter'; // inside each job folder: coverletter.txt, coverletter.docx, coverletter.pdf

let ollamaProcess = null;

// ---------- Paths and file reading ----------

/**
 * Resolve a path to absolute; if relative, resolve against PROJECT_ROOT.
 * @param {string} p
 * @returns {string}
 */
function resolvePath(p) {
  if (!path.isAbsolute(p)) {
    p = path.resolve(PROJECT_ROOT, p);
  }
  return p;
}

/**
 * Extract plain text from a file. Supports .txt, .docx, and .pdf.
 * @param {string} filePath - Absolute or relative path to the file
 * @returns {Promise<string>}
 */
async function readTextFromFile(filePath) {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(PROJECT_ROOT, filePath);
  if (!fs.existsSync(resolved)) return '';
  const ext = path.extname(resolved).toLowerCase();

  try {
    if (ext === '.txt') {
      return fs.readFileSync(resolved, 'utf-8').trim();
    }
    if (ext === '.docx') {
      const result = await mammoth.extractRawText({ path: resolved });
      return (result.value || '').trim();
    }
    if (ext === '.pdf') {
      const buffer = fs.readFileSync(resolved);
      const data = await pdfParse(buffer);
      return (data.text || '').trim();
    }
  } catch (err) {
    console.warn('Could not read file:', resolved, err.message);
    return '';
  }
  return '';
}

/**
 * Optionally load resume text from a file path (supports .txt, .docx, .pdf).
 * If no path given, looks in document-creation/documents/resume for any supported file.
 * @param {string | null} resumePath
 * @returns {Promise<string>}
 */
async function loadResume(resumePath) {
  if (resumePath) {
    const resolved = resolvePath(resumePath);
    if (!fs.existsSync(resolved)) {
      console.warn('Resume path not found:', resolved);
      return '';
    }
    return readTextFromFile(resolved);
  }
  return findAndLoadResumeFromDirectory(DEFAULT_RESUME_DIR);
}

/**
 * If no resume path was given, look in documents/resume for a .txt, .docx or .pdf and load it.
 * @param {string} dir - e.g. document-creation/documents/resume
 * @returns {Promise<string>}
 */
async function findAndLoadResumeFromDirectory(dir) {
  const resolved = path.isAbsolute(dir) ? dir : path.resolve(PROJECT_ROOT, dir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return '';
  const files = fs.readdirSync(resolved).filter((f) =>
    SUPPORTED_DOC_EXTENSIONS.includes(path.extname(f).toLowerCase())
  );
  if (files.length === 0) return '';
  const first = path.join(resolved, files[0]);
  return readTextFromFile(first);
}

/**
 * Look in document-creation/documents/coverletter for a sample file (sample.txt, sample.docx, sample.pdf, etc.) and load it.
 * @returns {Promise<string>}
 */
async function loadSampleCoverLetter() {
  const resolved = DEFAULT_COVERLETTER_DIR;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return '';
  const files = fs.readdirSync(resolved);
  for (const name of SAMPLE_COVER_LETTER_NAMES) {
    if (files.includes(name)) {
      const text = await readTextFromFile(path.join(resolved, name));
      if (text) return text;
    }
  }
  const sampleAny = files.find((f) => {
    const ext = path.extname(f).toLowerCase();
    return f.toLowerCase().includes('sample') && SUPPORTED_DOC_EXTENSIONS.includes(ext);
  });
  if (sampleAny) {
    return readTextFromFile(path.join(resolved, sampleAny));
  }
  return '';
}

/**
 * Load applicant details from document-creation/documents/details/applicant-details/.
 * Prefers applicant.json; otherwise uses the first .json file (alphabetically).
 * @param {string} [dir] - Directory to read from (default: DEFAULT_APPLICANT_DETAILS_DIR)
 * @returns {{ applicantName?: string, lastName?: string, dob?: string, [key: string]: unknown }}
 */
function loadApplicantDetails(dir = DEFAULT_APPLICANT_DETAILS_DIR) {
  const resolved = path.isAbsolute(dir) ? dir : path.resolve(PROJECT_ROOT, dir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return {};
  const files = fs.readdirSync(resolved).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return {};
  const preferred = files.find((f) => f === 'applicant.json');
  const name = preferred || files.sort()[0];
  const filePath = path.join(resolved, name);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return typeof data === 'object' && data !== null ? data : {};
  } catch (err) {
    console.warn('Could not read applicant details from', filePath, err.message);
    return {};
  }
}

/**
 * Ensure output directory exists.
 * @param {string} outputDir
 */
function ensureOutputDir(outputDir) {
  const resolved = resolvePath(outputDir);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

// ---------- Step 2: Local LLM lifecycle (Ollama) ----------

/**
 * Check if Ollama is reachable (HTTP GET to base URL).
 * @returns {Promise<boolean>}
 */
function isOllamaRunning() {
  return new Promise((resolve) => {
    const url = new URL(OLLAMA_BASE_URL);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname || '/',
        method: 'GET',
        timeout: 3000,
      },
      (res) => {
        resolve(res.statusCode === 200 || res.statusCode < 500);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/**
 * Spawn Ollama serve (assumes `ollama` on PATH).
 * @returns {Promise<import('child_process').ChildProcess>}
 */
function spawnOllama() {
  return new Promise((resolve, reject) => {
    const child = spawn('ollama', ['serve'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      cwd: PROJECT_ROOT,
    });
    ollamaProcess = child;
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      ollamaProcess = null;
      reject(new Error(`Failed to start Ollama: ${err.message}. Is Ollama installed and on PATH?`));
    });
    child.on('exit', (code, signal) => {
      ollamaProcess = null;
      if (code !== 0 && code != null) {
        console.warn('Ollama process exited:', code, signal, stderr.slice(-500));
      }
    });
    // Give it a moment to start
    setTimeout(() => resolve(child), 500);
  });
}

/**
 * Wait until Ollama responds to a simple request or timeout.
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function waitForOllamaReady(timeoutMs = OLLAMA_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function poll() {
      if (Date.now() > deadline) {
        reject(new Error(`Ollama did not become ready within ${timeoutMs}ms`));
        return;
      }
      isOllamaRunning().then((ok) => {
        if (ok) {
          resolve();
          return;
        }
        setTimeout(poll, OLLAMA_POLL_MS);
      });
    }
    poll();
  });
}

/**
 * Ensure Ollama is running: check first; if not, spawn and wait for ready.
 * @param {{ spawnIfNeeded?: boolean }} [options]
 * @returns {Promise<{ startedByUs: boolean }>}
 */
async function ensureOllamaRunning(options = {}) {
  const spawnIfNeeded = options.spawnIfNeeded !== false;

  if (await isOllamaRunning()) {
    return { startedByUs: false };
  }

  if (!spawnIfNeeded) {
    throw new Error(
      `Ollama is not running at ${OLLAMA_BASE_URL}. Start it with \`ollama serve\` or run this script without --no-spawn.`
    );
  }

  console.log('Ollama not detected; starting ollama serve...');
  await spawnOllama();
  await waitForOllamaReady();
  console.log('Ollama is ready.');
  return { startedByUs: true };
}

/**
 * Ensure the default prompt file exists; if not, create it from DEFAULT_PROMPT_TEMPLATE.
 */
function ensurePromptFileExists() {
  if (!fs.existsSync(DEFAULT_PROMPT_PATH)) {
    const dir = path.dirname(DEFAULT_PROMPT_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DEFAULT_PROMPT_PATH, DEFAULT_PROMPT_TEMPLATE, 'utf-8');
  }
}

/**
 * Load the default prompt template and replace placeholders.
 * @param {object} job - Job object with positionName, company, description, etc.
 * @param {{ applicantName?: string, resumeSnippet?: string, sampleCoverLetter?: string }} [context]
 * @returns {string}
 */
function buildPromptFromTemplate(job, context = {}) {
  ensurePromptFileExists();
  let template = fs.readFileSync(DEFAULT_PROMPT_PATH, 'utf-8');

  const description = (job.description || '').slice(0, 12000);
  const resumeSnippet = (context.resumeSnippet || '').slice(0, 3000);
  const applicantName = context.applicantName || '';
  const sampleCoverLetter = (context.sampleCoverLetter || '').trim();

  const coverLetterSection = sampleCoverLetter
    ? `Use the following cover letter as an example to base your tone, format and content off:\n\n---\n${sampleCoverLetter}\n---\n\n`
    : '';

  const vars = {
    company: job.company || '',
    positionName: job.positionName || '',
    location: job.location || '',
    type: job.type || '',
    description,
    applicantName: applicantName || '(Not provided)',
    resumeSnippet: resumeSnippet || '(Not provided)',
    coverLetterSection,
  };

  for (const [key, value] of Object.entries(vars)) {
    template = template.replace(new RegExp(`{{${key}}}`, 'g'), () => value);
  }

  return template;
}

// ---------- Step 4: Call local LLM (Ollama) ----------

/**
 * Call Ollama /api/generate with the given prompt. Returns full response text.
 * @param {string} prompt - Full prompt string (template already filled).
 * @param {{ model?: string, stream?: boolean, num_predict?: number, temperature?: number, stop?: string[] }} [opts]
 * @returns {Promise<string>} Generated text (response.response)
 */
function callOllamaGenerate(prompt, opts = {}) {
  const url = new URL(OLLAMA_BASE_URL);
  const model = opts.model ?? OLLAMA_MODEL;
  const body = JSON.stringify({
    model,
    prompt,
    stream: false,
    options: {
      num_predict: opts.num_predict ?? OLLAMA_MAX_TOKENS,
      temperature: opts.temperature ?? OLLAMA_TEMPERATURE,
      stop: opts.stop ?? OLLAMA_STOP,
    },
  });

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: '/api/generate',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body, 'utf-8'),
        },
        timeout: opts.timeout ?? OLLAMA_GENERATE_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode !== 200) {
            let msg = `Ollama /api/generate returned ${res.statusCode}: ${raw.slice(0, 300)}`;
            if (res.statusCode === 404 && raw.includes('not found')) {
              msg += `\nPull a model first, e.g.: ollama pull ${model}. Or set OLLAMA_MODEL to a model you have.`;
            }
            reject(new Error(msg));
            return;
          }
          try {
            const data = JSON.parse(raw);
            const text = data.response != null ? String(data.response).trim() : '';
            resolve(text);
          } catch (e) {
            reject(new Error(`Ollama returned invalid JSON: ${e.message}`));
          }
        });
      }
    );
    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        reject(new Error(`Cannot connect to Ollama at ${OLLAMA_BASE_URL}. Is it running?`));
      } else {
        reject(err);
      }
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Ollama generate timed out after ${opts.timeout ?? OLLAMA_GENERATE_TIMEOUT_MS}ms`));
    });
    req.write(body);
    req.end();
  });
}

// ---------- Step 5: Post-process and save ----------

/**
 * Strip markdown/code fences and normalize whitespace so the cover letter is plain text.
 * @param {string} raw - Raw model output
 * @returns {string}
 */
function postProcessCoverLetterText(raw) {
  if (typeof raw !== 'string') return '';
  let text = raw.trim();
  // Remove optional markdown code block wrapper
  const codeFence = /^```\w*\n?([\s\S]*?)```\s*$/m;
  const match = text.match(codeFence);
  if (match) text = match[1].trim();
  // Collapse 3+ newlines to 2
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trimEnd() + (text ? '\n' : '');
}

/**
 * Get job ID from job.link (e.g. seek.com.au/job/90276720) or from entry file path stem.
 * @param {object} job - Job with optional link, id
 * @param {string} [entryPath] - Path to the job JSON file (e.g. .../job-data/90276720.json)
 * @returns {string} Job id for use as folder name
 */
function getJobId(job, entryPath) {
  if (job.id != null && String(job.id).trim()) return String(job.id).trim();
  const link = (job.link || '').trim();
  const m = link.match(/\/job\/(\d+)/);
  if (m) return m[1];
  if (entryPath) {
    const stem = path.basename(entryPath, path.extname(entryPath));
    if (stem) return stem;
  }
  return 'job';
}

/**
 * Generate cover letter file basename: DOB.LastName.Company (no extension).
 * DOB is YYYYMMDD from applicant details; use 00000000 if missing.
 * @param {object} job - Job with company
 * @param {{ applicantLastName?: string, applicantDob?: string }} [opts] - applicantDob e.g. "2003-12-10"
 * @returns {string} Basename for .txt, .docx, .pdf files
 */
function generateCoverLetterBasename(job, opts = {}) {
  const dobRaw = (opts.applicantDob || '').trim();
  const digits = dobRaw ? dobRaw.replace(/-/g, '') : '';
  const dobPart = digits.length >= 6 ? digits.slice(-6) : '000000'; // YYMMDD (e.g. 031210)
  const lastName = (opts.applicantLastName || '').trim().replace(/\s+/g, '') || 'Applicant';
  const companySlug = (job.company || 'Company').replace(/\s+/g, '').replace(/[^\w\-]/g, '') || 'Company';
  return `${dobPart}.${lastName}.${companySlug}`;
}

/**
 * Generate output folder name for a job (legacy: YYMMDD.LastName.CL.CompanyName).
 * Prefer using getJobId(job, entryPath) for folder name and generateCoverLetterBasename for file names.
 * @param {object} job - Job with company, positionName, etc.
 * @param {{ applicantLastName?: string }} [opts]
 * @returns {string} Folder name only (no path)
 */
function generateOutputFolderName(job, opts = {}) {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const datePart = yy + mm + dd;
  const lastName = (opts.applicantLastName || '').trim() || 'Applicant';
  const companySlug = (job.company || 'Company').replace(/\s+/g, '').replace(/[^\w\-]/g, '') || 'Company';
  return `${datePart}.${lastName}.CL.${companySlug}`;
}

/**
 * Generate output filename: YYMMDD.LastName.CL.CompanyName(.txt|.docx). Company and name have no spaces.
 * @param {object} job - Job with company, positionName, etc.
 * @param {{ applicantLastName?: string, outputFormat?: string }} [opts]
 * @returns {string} Basename only (no path)
 */
function generateOutputFilename(job, opts = {}) {
  const format = (opts.outputFormat || COVER_LETTER_OUTPUT_FORMAT).toLowerCase();
  const ext = format === 'docx' ? '.docx' : '.txt';
  const base = generateOutputFolderName(job, opts);
  return base + ext;
}

/**
 * Write cover letter text to a file (.txt or .docx).
 * @param {string} fullPath - Absolute path to output file (including extension)
 * @param {string} text - Plain text content
 * @param {{ format?: string }} [opts] - format: 'txt' | 'docx'
 * @returns {Promise<void>}
 */
async function writeCoverLetter(fullPath, text, opts = {}) {
  const format = (opts.format || COVER_LETTER_OUTPUT_FORMAT).toLowerCase();
  if (format === 'docx') {
    const lines = text.split(/\n/);
    const paragraphs = lines.map((line) => new Paragraph({ children: [new TextRun(line || ' ')] }));
    const doc = new Document({ sections: [{ children: paragraphs }] });
    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(fullPath, buffer);
  } else {
    fs.writeFileSync(fullPath, text, 'utf-8');
  }
}

/**
 * Create a PDF buffer from plain text (one paragraph per line, simple layout).
 * @param {string} text - Plain text content
 * @returns {Promise<Buffer>}
 */
async function textToPdfBuffer(text) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 11;
  const lineHeight = fontSize * 1.4;
  const margin = 50;
  const lines = (text || '').trim().split(/\n/);
  let page = pdfDoc.addPage();
  let { width, height } = page.getSize();
  let y = height - margin;

  for (const line of lines) {
    if (y < margin) {
      page = pdfDoc.addPage();
      ({ width, height } = page.getSize());
      y = height - margin;
    }
    page.drawText(line || ' ', {
      x: margin,
      y,
      size: fontSize,
      font,
    });
    y -= lineHeight;
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

/**
 * Write cover letter to a job folder in three formats: .txt, .docx, .pdf.
 * Creates the folder if needed. File names use basename from opts, or COVERLETTER_BASENAME.
 * @param {string} folderPath - Absolute path to the job folder (e.g. outputDir/90276720)
 * @param {string} text - Plain text content
 * @param {{ basename?: string }} [opts] - Basename for files (no extension); e.g. 20031210.Darker.CompanySlug
 * @returns {Promise<{ txtPath: string, docxPath: string, pdfPath: string }>}
 */
async function writeCoverLetterToFolder(folderPath, text, opts = {}) {
  fs.mkdirSync(folderPath, { recursive: true });
  const fileBasename = (opts.basename && String(opts.basename).trim()) || COVERLETTER_BASENAME;
  const base = path.join(folderPath, fileBasename);
  const txtPath = base + '.txt';
  const docxPath = base + '.docx';
  const pdfPath = base + '.pdf';

  fs.writeFileSync(txtPath, text, 'utf-8');

  const lines = text.split(/\n/);
  const paragraphs = lines.map((line) => new Paragraph({ children: [new TextRun(line || ' ')] }));
  const doc = new Document({ sections: [{ children: paragraphs }] });
  const docxBuffer = await Packer.toBuffer(doc);
  fs.writeFileSync(docxPath, docxBuffer);

  const pdfBuffer = await textToPdfBuffer(text);
  fs.writeFileSync(pdfPath, pdfBuffer);

  return { txtPath, docxPath, pdfPath };
}

/**
 * Get applicant last name from APPLICANT_NAME or APPLICANT_LAST_NAME env.
 * @returns {string}
 */
function getApplicantLastName() {
  const last = process.env.APPLICANT_LAST_NAME;
  if (last && typeof last === 'string') return last.trim();
  const full = process.env.APPLICANT_NAME;
  if (full && typeof full === 'string') {
    const parts = full.trim().split(/\s+/);
    return parts[parts.length - 1] || 'Applicant';
  }
  return 'Applicant';
}

// ---------- Step 6: Cleanup ----------

/**
 * If we started Ollama and COVER_LETTER_STOP_OLLAMA=1, kill the process.
 */
function cleanupOllamaIfStarted() {
  if (ollamaProcess && process.env.COVER_LETTER_STOP_OLLAMA === '1') {
    ollamaProcess.kill();
    ollamaProcess = null;
    console.log('Ollama process stopped (COVER_LETTER_STOP_OLLAMA=1).');
  }
}

// ---------- Step 7: Retry / backoff ----------

/**
 * Call Ollama generate with retries and backoff on failure.
 * @param {string} prompt
 * @param {object} [opts] - Same as callOllamaGenerate, plus retries
 * @returns {Promise<string>}
 */
async function callOllamaGenerateWithRetry(prompt, opts = {}) {
  const maxAttempts = Math.max(1, (opts.retryAttempts ?? OLLAMA_RETRY_ATTEMPTS) + 1);
  const delayMs = opts.retryDelayMs ?? OLLAMA_RETRY_DELAY_MS;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await callOllamaGenerate(prompt, opts);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        console.warn(`Ollama attempt ${attempt}/${maxAttempts} failed: ${err.message}. Retrying in ${delayMs}ms...`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

module.exports = {
  resolvePath,
  ensureOutputDir,
  ensureOllamaRunning,
  DEFAULT_OUTPUT_DIR,
  readTextFromFile,
  loadResume,
  loadSampleCoverLetter,
  buildPromptFromTemplate,
  callOllamaGenerate,
  callOllamaGenerateWithRetry,
  postProcessCoverLetterText,
  getJobId,
  generateCoverLetterBasename,
  generateOutputFolderName,
  generateOutputFilename,
  writeCoverLetter,
  writeCoverLetterToFolder,
  textToPdfBuffer,
  getApplicantLastName,
  loadApplicantDetails,
  cleanupOllamaIfStarted,
  DEFAULT_RESUME_DIR,
  DEFAULT_COVERLETTER_DIR,
  DEFAULT_APPLICANT_DETAILS_DIR,
  SUPPORTED_DOC_EXTENSIONS,
  COVERLETTER_BASENAME,
};
