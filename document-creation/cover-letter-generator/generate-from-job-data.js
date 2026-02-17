/**
 * CLI entry point: discover job data (from job-data/ or a given path) and generate
 * cover letters using the tools in index.js.
 *
 * Usage:
 *   node document-creation/cover-letter-generator/generate-from-job-data.js [jobDataPath] [--resume path] [--out path]
 *   jobDataPath: path to a single job JSON file or directory of .json files (default: job-data/)
 *   --resume path: optional path to resume text file
 *   --out path: output directory for cover letters (default: document-creation/documents/coverletter)
 *
 * Requires Ollama (see index.js). Env: OLLAMA_MODEL, APPLICANT_NAME, etc.
 */

const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_JOB_DATA = path.join(PROJECT_ROOT, 'job-data');

const {
  loadResume,
  loadSampleCoverLetter,
  loadApplicantDetails,
  getApplicantLastName,
  ensureOutputDir,
  ensureOllamaRunning,
  buildPromptFromTemplate,
  callOllamaGenerateWithRetry,
  postProcessCoverLetterText,
  getJobId,
  generateCoverLetterBasename,
  writeCoverLetterToFolder,
  cleanupOllamaIfStarted,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_RESUME_DIR,
  DEFAULT_COVERLETTER_DIR,
} = require('./index.js');

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

async function main() {
  const { jobDataPath, resumePath, outputDir } = parseArgs();

  console.log('Cover letter generator (from job-data)');
  console.log('Job data path:', jobDataPath);
  console.log('Output dir:', outputDir);
  if (resumePath) console.log('Resume path:', resumePath);

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

  const { startedByUs } = await ensureOllamaRunning({ spawnIfNeeded: true });
  const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
  console.log('LLM backend:', startedByUs ? 'Ollama (started by this script)' : 'Ollama (already running)');
  console.log('Model:', OLLAMA_MODEL);

  const applicantDetails = loadApplicantDetails();
  const applicantName =
    (applicantDetails.applicantName && String(applicantDetails.applicantName).trim()) ||
    process.env.APPLICANT_NAME ||
    '';
  const applicantLastName =
    (applicantDetails.lastName && String(applicantDetails.lastName).trim()) ||
    (applicantName ? applicantName.trim().split(/\s+/).pop() : '') ||
    getApplicantLastName();
  const context = {
    applicantName,
    resumeSnippet: resumeText,
    sampleCoverLetter,
  };
  const results = [];

  const applicantDob = (applicantDetails.dob && String(applicantDetails.dob).trim()) || '';

  try {
    for (const entry of jobDataEntries) {
      for (const job of entry.jobs) {
        const prompt = buildPromptFromTemplate(job, context);
        console.log(`\nGenerating cover letter for: ${job.positionName} at ${job.company} (prompt ${prompt.length} chars)...`);
        const responseText = await callOllamaGenerateWithRetry(prompt);
        const cleaned = postProcessCoverLetterText(responseText);
        const folderName = getJobId(job, entry.path);
        const jobFolderPath = path.join(resolvedOutputDir, folderName);
        const fileBasename = generateCoverLetterBasename(job, {
          applicantLastName,
          applicantDob,
        });
        const { txtPath, docxPath, pdfPath } = await writeCoverLetterToFolder(jobFolderPath, cleaned, {
          basename: fileBasename,
        });
        results.push({
          job,
          entryPath: entry.path,
          responseText: cleaned,
          outputFolder: jobFolderPath,
          txtPath,
          docxPath,
          pdfPath,
        });
        console.log(`  Folder: ${jobFolderPath}`);
        console.log(`    ${path.basename(txtPath)}, ${path.basename(docxPath)}, ${path.basename(pdfPath)}`);
      }
    }

    console.log(`\nGenerated ${results.length} cover letter(s).`);
    results.forEach((r) => console.log('  ', r.outputFolder));
  } finally {
    cleanupOllamaIfStarted();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { parseArgs, resolvePath, loadJobData, main };
