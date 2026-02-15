/**
 * Cover Letter Generator — Steps 1 & 2
 *
 * Step 1: Setup / entry point — accept job-data path(s), optional resume, output path;
 *         resolve paths, load job data, ensure output directory exists.
 * Step 2: Local LLM lifecycle — check if Ollama is running; if not, spawn it and wait for ready.
 *
 * Usage:
 *   node document-creation/cover-letter-generator.js [jobDataPath] [--resume path] [--out path]
 *   jobDataPath: path to a single job JSON file or to job-data/ directory (default: job-data/)
 *   --resume path: optional path to resume text file
 *   --out path: output directory for cover letters (default: document-creation/documents/coverletter)
 *
 * Requires Ollama installed and (unless already running) available on PATH for spawning.
 * Set OLLAMA_MODEL to the model to use (default: llama3.2). Pull with e.g. ollama pull llama3.2.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_JOB_DATA = path.join(PROJECT_ROOT, 'job-data');
const DEFAULT_OUTPUT_DIR = path.join(__dirname, 'documents', 'coverletter');
const DEFAULT_RESUME_DIR = path.join(__dirname, 'documents', 'resume');
const DEFAULT_COVERLETTER_DIR = path.join(__dirname, 'documents', 'coverletter');
const DEFAULT_PROMPT_PATH = path.join(__dirname, 'prompts', 'cover-letter-default.txt');
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

let ollamaProcess = null;

// ---------- Step 1: Setup / Entry point ----------

/**
 * Parse argv for jobDataPath, --resume, --out.
 * @param {string[]} argv
 * @returns {{ jobDataPath: string, resumePath: string | null, outputDir: string }}
 */
function parseArgs(argv = process.argv.slice(2)) {
  let jobDataPath = DEFAULT_JOB_DATA;
  let resumePath = null;
  let outputDir = DEFAULT_OUTPUT_DIR;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--resume' && argv[i + 1]) {
      resumePath = argv[++i];
    } else if ((argv[i] === '--out' || argv[i] === '-o') && argv[i + 1]) {
      outputDir = argv[++i];
    } else if (!argv[i].startsWith('-')) {
      jobDataPath = argv[i];
    }
  }

  return { jobDataPath, resumePath, outputDir };
}

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
 * Load job data from a path (single file or directory of JSON files).
 * @param {string} jobDataPath - Path to a .json file or directory containing .json files
 * @returns {{ jobs: object[], path: string }[]} Array of { jobs: [job], path } for single file, or { jobs, path } per file
 */
function loadJobData(jobDataPath) {
  const resolved = resolvePath(jobDataPath);
  const stat = fs.statSync(resolved);

  if (stat.isFile()) {
    const raw = fs.readFileSync(resolved, 'utf-8');
    const job = JSON.parse(raw);
    return [{ jobs: [job], path: resolved }];
  }

  if (stat.isDirectory()) {
    const files = fs.readdirSync(resolved).filter((f) => f.endsWith('.json'));
    return files.map((f) => {
      const filePath = path.join(resolved, f);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const job = JSON.parse(raw);
      return { jobs: [job], path: filePath };
    });
  }

  throw new Error(`Job data path is neither file nor directory: ${resolved}`);
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
  const resolved = resolvePath(dir);
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
  const resolved = resolvePath(DEFAULT_COVERLETTER_DIR);
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
 * Load the default prompt template and replace placeholders.
 * @param {object} job - Job object with positionName, company, description, etc.
 * @param {{ applicantName?: string, resumeSnippet?: string, sampleCoverLetter?: string }} [context]
 * @returns {string}
 */
function buildPromptFromTemplate(job, context = {}) {
  const templatePath = path.resolve(__dirname, 'prompts', 'cover-letter-default.txt');
  let template = fs.readFileSync(templatePath, 'utf-8');

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
    template = template.replace(new RegExp(`{{${key}}}`, 'g'), value);
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

// ---------- Main ----------

async function main() {
  const { jobDataPath, resumePath, outputDir } = parseArgs();

  console.log('Cover letter generator (steps 1 & 2)');
  console.log('Job data path:', jobDataPath);
  console.log('Output dir:', outputDir);
  if (resumePath) console.log('Resume path:', resumePath);

  // Step 1
  const resolvedJobPath = resolvePath(jobDataPath);
  if (!fs.existsSync(resolvedJobPath)) {
    throw new Error(`Job data path does not exist: ${resolvedJobPath}`);
  }

  const jobDataEntries = loadJobData(resolvedJobPath);
  const resumeText = await loadResume(resumePath);
  const sampleCoverLetter = await loadSampleCoverLetter();
  const resolvedOutputDir = ensureOutputDir(outputDir);

  if (resumeText) console.log('Resume: loaded from', resumePath || DEFAULT_RESUME_DIR);
  else if (resumePath) console.log('Resume path:', resumePath, '(file not found or empty)');
  if (sampleCoverLetter) console.log('Sample cover letter: loaded from', DEFAULT_COVERLETTER_DIR);
  console.log(`Loaded ${jobDataEntries.length} job file(s). Output directory: ${resolvedOutputDir}`);

  // Step 2
  const { startedByUs } = await ensureOllamaRunning({ spawnIfNeeded: true });
  console.log('LLM backend:', startedByUs ? 'Ollama (started by this script)' : 'Ollama (already running)');
  console.log('Model:', OLLAMA_MODEL);

  // Step 3 & 4: Build prompt per job, call Ollama, collect response text
  const context = {
    applicantName: process.env.APPLICANT_NAME || '',
    resumeSnippet: resumeText,
    sampleCoverLetter,
  };
  const results = [];

  for (const entry of jobDataEntries) {
    for (const job of entry.jobs) {
      const prompt = buildPromptFromTemplate(job, context);
      console.log(`\nGenerating cover letter for: ${job.positionName} at ${job.company} (prompt ${prompt.length} chars)...`);
      const responseText = await callOllamaGenerate(prompt);
      results.push({ job, entryPath: entry.path, responseText });
      console.log(`  Done. Response length: ${responseText.length} chars`);
    }
  }

  console.log(`\nGenerated ${results.length} cover letter(s).`);
  if (results.length > 0 && results[0].responseText) {
    const preview = results[0].responseText.slice(0, 200).replace(/\n/g, ' ');
    console.log('First letter preview:', preview + (results[0].responseText.length > 200 ? '...' : ''));
  }

  // Optional: tear down if we started Ollama (configurable via env)
  if (ollamaProcess && process.env.COVER_LETTER_STOP_OLLAMA === '1') {
    ollamaProcess.kill();
    console.log('Ollama process stopped (COVER_LETTER_STOP_OLLAMA=1).');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    if (ollamaProcess) ollamaProcess.kill();
    process.exit(1);
  });
}

module.exports = {
  readTextFromFile,
  loadResume,
  loadSampleCoverLetter,
  buildPromptFromTemplate,
  callOllamaGenerate,
  DEFAULT_RESUME_DIR,
  DEFAULT_COVERLETTER_DIR,
  SUPPORTED_DOC_EXTENSIONS,
};
