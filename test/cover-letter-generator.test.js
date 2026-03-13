/**
 * Tests for cover letter generator steps 3 (prompt construction) and 4 (call Ollama).
 * Run: npm test (or node --test test/cover-letter-generator.test.js)
 * Uses document-creation/cover-letter-generator (index.js).
 *
 * Prompt tests are unit tests. Ollama generate tests mock http.request (no live Ollama needed).
 * Remote-Ollama tests mock both http and https so that remote OLLAMA_BASE_URL still produces output.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const https = require('https');

const fs = require('fs');
const path = require('path');
const os = require('os');

const { Document, Packer } = require('docx');

const {
  buildPromptFromTemplate,
  callOllamaGenerate,
  callOllamaGenerateWithRetry,
  postProcessCoverLetterText,
  runCoverLetterChecks,
  generateOutputFolderName,
  generateOutputFilename,
  writeCoverLetter,
  writeCoverLetterToFolder,
  wrapLineForPdf,
  textToPdfBuffer,
  getApplicantLastName,
  getJobId,
  generateCoverLetterBasename,
  cleanupOllamaIfStarted,
  stripAiMessageFromCoverLetterText,
  buildCoverLetterDocxParagraphs,
  AI_COVER_LETTER_MESSAGE,
  DEFAULT_OUTPUT_DIR,
  COVERLETTER_BASENAME,
  parseOllamaGenerateResponse,
  extractWrappedLetter,
  looksLikeOutlineLetter,
} = require('../document-creation/cover-letter-generator/index.js');

// ---------- Step 3: Prompt construction ----------

describe('buildPromptFromTemplate (step 3)', () => {
  const baseJob = {
    company: 'Acme Corp',
    positionName: 'Software Engineer',
    location: 'Adelaide',
    type: 'Full Time',
    description: 'We need a developer.',
  };

  it('fills company, role, location, type and description', () => {
    const prompt = buildPromptFromTemplate(baseJob, {});
    assert.ok(prompt.includes('Acme Corp'), 'company');
    assert.ok(prompt.includes('Software Engineer'), 'positionName');
    assert.ok(prompt.includes('Adelaide'), 'location');
    assert.ok(prompt.includes('Full Time'), 'type');
    assert.ok(prompt.includes('We need a developer.'), 'description');
  });

  it('uses (Not provided) when applicantName and resumeSnippet are missing', () => {
    const prompt = buildPromptFromTemplate(baseJob, {});
    assert.ok(prompt.includes('(Not provided)'));
  });

  it('injects applicantName and resumeSnippet when provided', () => {
    const prompt = buildPromptFromTemplate(baseJob, {
      applicantName: 'Jane Doe',
      resumeSnippet: '5 years Node.js experience.',
    });
    assert.ok(prompt.includes('Jane Doe'));
    assert.ok(prompt.includes('5 years Node.js experience.'));
    assert.ok(!prompt.includes('(Not provided)'));
  });

  it('truncates description to 12000 characters', () => {
    const longDesc = 'x'.repeat(15000);
    const prompt = buildPromptFromTemplate({ ...baseJob, description: longDesc }, {});
    const descMatch = prompt.match(/---\n([\s\S]*?)\n---/);
    assert.ok(descMatch, 'description block present');
    assert.strictEqual(descMatch[1].length, 12000, 'description truncated to 12000');
  });

  it('truncates resumeSnippet to 3000 characters', () => {
    const longResume = 'r'.repeat(5000);
    const prompt = buildPromptFromTemplate(baseJob, { resumeSnippet: longResume });
    assert.ok(prompt.includes('r'.repeat(3000)));
    assert.ok(!prompt.includes('r'.repeat(3001)));
  });

  it('includes coverLetterSection when sample cover letter is provided', () => {
    const prompt = buildPromptFromTemplate(baseJob, {
      sampleCoverLetter: 'Dear Sir,\n\nI am writing to apply...',
    });
    assert.ok(prompt.includes('Use the following cover letter as an example'));
    assert.ok(prompt.includes('Dear Sir,'));
    assert.ok(prompt.includes('I am writing to apply...'));
    assert.ok(prompt.includes('---'));
  });

  it('omits coverLetterSection when sample is empty', () => {
    const prompt = buildPromptFromTemplate(baseJob, { sampleCoverLetter: '' });
    assert.ok(!prompt.includes('Use the following cover letter as an example'));
  });

  it('includes instruction lines and "Cover letter:" at end', () => {
    const prompt = buildPromptFromTemplate(baseJob, {});
    assert.ok(prompt.includes('Address the letter to the hiring team'));
    assert.ok(prompt.includes('Output only the cover letter text'));
    assert.ok(prompt.trimEnd().endsWith('Cover letter:'));
  });

  it('preserves dollar amounts in description (no $ replacement interpretation)', () => {
    const jobWithSalary = {
      ...baseJob,
      description: 'Salary: $100,000. Range $80k-$120k.',
    };
    const prompt = buildPromptFromTemplate(jobWithSalary, {});
    assert.ok(prompt.includes('$100,000'), 'dollar amount preserved');
    assert.ok(prompt.includes('$80k-$120k'), 'salary range preserved');
    assert.ok(prompt.includes('Salary: $'), 'leading $ preserved (not eaten by $1 ref)');
  });
});

// ---------- Tests using job-data/90083734.json (Semantic Sciences) ----------

const JOB_DATA_90083734_PATH = path.join(__dirname, '..', 'job-data', '90083734.json');

function loadJob90083734() {
  const raw = fs.readFileSync(JOB_DATA_90083734_PATH, 'utf-8');
  return JSON.parse(raw);
}

describe('cover letter generator with job-data/90083734.json', () => {
  let job90083734;

  before(() => {
    assert.ok(fs.existsSync(JOB_DATA_90083734_PATH), 'job-data/90083734.json must exist');
    job90083734 = loadJob90083734();
  });

  it('loads job with company Semantic Sciences and role Software Team Lead', () => {
    assert.strictEqual(job90083734.company, 'Semantic Sciences Pty Ltd');
    assert.strictEqual(job90083734.positionName, 'Software Team Lead');
    assert.strictEqual(job90083734.location, 'Adelaide SA');
    assert.strictEqual(job90083734.type, 'Full Time');
    assert.ok(job90083734.description && job90083734.description.length > 100);
  });

  it('buildPromptFromTemplate includes job details and description snippet', () => {
    const prompt = buildPromptFromTemplate(job90083734, {});
    assert.ok(prompt.includes('Semantic Sciences Pty Ltd'));
    assert.ok(prompt.includes('Software Team Lead'));
    assert.ok(prompt.includes('Adelaide SA'));
    assert.ok(prompt.includes('Full Time'));
    assert.ok(prompt.includes('Sensuris'));
    assert.ok(prompt.includes('grant management'));
    assert.ok(prompt.includes('Java EE') || prompt.includes('Docker') || prompt.includes('Terraform'));
  });

  it('generateOutputFolderName produces valid folder name for this job', () => {
    const folderName = generateOutputFolderName(job90083734, { applicantLastName: 'Smith' });
    assert.ok(/^\d{6}\.Smith\.CL\./.test(folderName), folderName);
    assert.ok(folderName.includes('SemanticSciences') || folderName.length >= 10);
  });

  it('full pipeline: prompt → mock response → postProcess → writeCoverLetterToFolder', async () => {
    const prompt = buildPromptFromTemplate(job90083734, {
      applicantName: 'Test User',
      resumeSnippet: 'Senior developer with 10 years experience.',
    });
    assert.ok(prompt.length > 500);

    const mockLlmResponse = `Dear Hiring Manager,

I am writing to apply for the Software Team Lead position at Semantic Sciences Pty Ltd.

With over 10 years in software development and experience in Java, Docker, and cloud delivery, I am excited about the opportunity to lead your team and contribute to Sensuris.

Yours sincerely,
[Test User]
`;
    const cleaned = postProcessCoverLetterText(mockLlmResponse);
    assert.ok(cleaned.includes('Semantic Sciences Pty Ltd'));
    assert.ok(cleaned.endsWith('\n'));

    const tempDir = path.join(os.tmpdir(), `cover-letter-90083734-test-${Date.now()}`);
    const { txtPath, docxPath, pdfPath } = await writeCoverLetterToFolder(tempDir, cleaned);
    assert.ok(fs.existsSync(txtPath));
    assert.ok(fs.existsSync(docxPath));
    assert.ok(fs.existsSync(pdfPath));
    assert.strictEqual(fs.readFileSync(txtPath, 'utf-8'), cleaned);
    try {
      fs.rmSync(tempDir, { recursive: true });
    } catch {
      // ignore
    }
  });
});

// ---------- Step 4: Call Ollama (mocked) ----------

function mockHttpRequest(fakeResponse) {
  const originalRequest = http.request;
  http.request = function (opts, responseCallback) {
    const mockRes = {
      statusCode: fakeResponse.statusCode ?? 200,
      _dataListener: null,
      _endListener: null,
      on(ev, fn) {
        if (ev === 'data') this._dataListener = fn;
        if (ev === 'end') this._endListener = fn;
        return this;
      },
    };
    const mockReq = {
      write: () => {},
      end: () => {
        setImmediate(() => {
          if (mockRes._dataListener && fakeResponse.body != null) {
            mockRes._dataListener(
              Buffer.from(
                typeof fakeResponse.body === 'string'
                  ? fakeResponse.body
                  : JSON.stringify(fakeResponse.body)
              )
            );
          }
          if (mockRes._endListener) mockRes._endListener();
        });
      },
      on: () => mockReq,
    };
    setImmediate(() => responseCallback(mockRes));
    return mockReq;
  };
  return () => {
    http.request = originalRequest;
  };
}

describe('callOllamaGenerate (step 4)', () => {
  it('returns trimmed response.response on 200 with valid JSON', async () => {
    const restore = mockHttpRequest({
      statusCode: 200,
      body: { response: '  Dear Hiring Manager,\n\nI am writing to apply.  ', done: true },
    });
    try {
      const text = await callOllamaGenerate('test prompt');
      assert.strictEqual(text, 'Dear Hiring Manager,\n\nI am writing to apply.');
    } finally {
      restore();
    }
  });

  it('returns empty string when response.response is missing', async () => {
    const restore = mockHttpRequest({
      statusCode: 200,
      body: { done: true },
    });
    try {
      const text = await callOllamaGenerate('test');
      assert.strictEqual(text, '');
    } finally {
      restore();
    }
  });

  it('rejects with message including status and body on non-200', async () => {
    const restore = mockHttpRequest({
      statusCode: 500,
      body: 'Internal Server Error',
    });
    try {
      await assert.rejects(
        async () => callOllamaGenerate('test'),
        (err) => {
          assert.ok(err.message.includes('500'));
          assert.ok(err.message.includes('Internal'));
          return true;
        }
      );
    } finally {
      restore();
    }
  });

  it('rejects with pull/model hint on 404 model not found', async () => {
    const restore = mockHttpRequest({
      statusCode: 404,
      body: '{"error":"model \'llama3.2\' not found"}',
    });
    try {
      await assert.rejects(
        async () => callOllamaGenerate('test'),
        (err) => {
          assert.ok(err.message.includes('404'));
          assert.ok(err.message.includes('not found'));
          assert.ok(err.message.includes('Pull') || err.message.includes('OLLAMA_MODEL'));
          return true;
        }
      );
    } finally {
      restore();
    }
  });

  it('rejects with "invalid JSON" when response is not JSON', async () => {
    const restore = mockHttpRequest({
      statusCode: 200,
      body: 'not json at all',
    });
    try {
      await assert.rejects(
        async () => callOllamaGenerate('test'),
        (err) => {
          assert.ok(err.message.includes('invalid JSON'));
          return true;
        }
      );
    } finally {
      restore();
    }
  });

  it('rejects with connection message on ECONNREFUSED', async () => {
    const originalRequest = http.request;
    http.request = function (opts, cb) {
      const mockReq = { write: () => {}, end: () => {}, on: (ev, fn) => ev === 'error' && setImmediate(() => fn({ code: 'ECONNREFUSED' })) };
      return mockReq;
    };
    try {
      await assert.rejects(
        async () => callOllamaGenerate('test'),
        (err) => {
          assert.ok(err.message.includes('Cannot connect'));
          assert.ok(err.message.includes('Is it running'));
          return true;
        }
      );
    } finally {
      http.request = originalRequest;
    }
  });

  it('rejects with timeout message on request timeout', async () => {
    const originalRequest = http.request;
    http.request = function (opts, cb) {
      const mockReq = {
        write: () => {},
        end: () => {},
        destroy: () => {},
        on: (ev, fn) => {
          if (ev === 'timeout') setImmediate(() => fn());
          return mockReq;
        },
      };
      setImmediate(() => cb({ statusCode: 200, on: () => {} })); // never ends, so timeout fires
      return mockReq;
    };
    try {
      await assert.rejects(
        async () => callOllamaGenerate('test', { timeout: 100 }),
        (err) => {
          assert.ok(err.message.includes('timed out'));
          return true;
        }
      );
    } finally {
      http.request = originalRequest;
    }
  });
});

describe('extractWrappedLetter and parseOllamaGenerateResponse (wrapped markers)', () => {
  const letter = 'Dear Hiring Manager,\n\nI am writing to apply for the role.\n\nYours sincerely,\nJane Doe';

  it('extractWrappedLetter returns content between <<<COVER_LETTER_START>>> and <<<COVER_LETTER_END>>>', () => {
    const wrapped = `Some planning here.\n<<<COVER_LETTER_START>>>\n${letter}\n<<<COVER_LETTER_END>>>\nMore text.`;
    assert.strictEqual(extractWrappedLetter(wrapped), letter);
  });

  it('extractWrappedLetter is case-insensitive for markers', () => {
    const wrapped = `<<<cover_letter_start>>>\n${letter}\n<<<cover_letter_end>>>`;
    assert.strictEqual(extractWrappedLetter(wrapped), letter);
  });

  it('extractWrappedLetter returns empty string when markers absent', () => {
    assert.strictEqual(extractWrappedLetter(letter), '');
    assert.strictEqual(extractWrappedLetter(''), '');
  });

  it('parseOllamaGenerateResponse returns only wrapped content when response contains markers', () => {
    const body = JSON.stringify({
      response: `Outline here.\n<<<COVER_LETTER_START>>>\n${letter}\n<<<COVER_LETTER_END>>>`,
      done: true,
    });
    const out = parseOllamaGenerateResponse(body);
    assert.strictEqual(out, letter);
  });

  it('parseOllamaGenerateResponse returns only wrapped content when thinking contains markers', () => {
    const body = JSON.stringify({
      response: '',
      thinking: `*   **Header:** ...\n*   **Opening:** ...\n<<<COVER_LETTER_START>>>\n${letter}\n<<<COVER_LETTER_END>>>`,
      done: true,
    });
    const out = parseOllamaGenerateResponse(body);
    assert.strictEqual(out, letter);
  });

  it('buildPromptFromTemplate includes wrapper instruction (markers in prompt)', () => {
    const prompt = buildPromptFromTemplate(
      { company: 'Acme', positionName: 'Engineer', description: 'Build things.' },
      { applicantName: 'Jane' }
    );
    assert.ok(prompt.includes('<<<COVER_LETTER_START>>>'), 'prompt should instruct wrapping with start marker');
    assert.ok(prompt.includes('<<<COVER_LETTER_END>>>'), 'prompt should instruct wrapping with end marker');
  });

  it('parseOllamaGenerateResponse returns extracted letter when thinking contains outline-style content (outline is used as fallback)', () => {
    const outlineThinking = [
      'Thinking:',
      '**Salutation:** Dear Hiring Manager,',
      '**Opening:** State role (Azure Engineer) and company (Green Light PS Pty Ltd). Mention interest.',
      '**Body 1:** Connect IT degree to Azure. Mention scripting.',
      '**Closing:** Reiterate enthusiasm.',
      'Yours sincerely, William Darker.',
    ].join('\n');
    const body = JSON.stringify({ response: '', thinking: outlineThinking, done: true });
    const out = parseOllamaGenerateResponse(body);
    assert.ok(out.length > 0, 'should return extracted content (outline fallback)');
    assert.ok(/Dear\s+Hiring\s+Manager/i.test(out), 'should start with salutation');
    assert.ok(/Yours sincerely/i.test(out), 'should include sign-off');
    assert.ok(looksLikeOutlineLetter(out), 'extracted outline should be detected by looksLikeOutlineLetter');
  });

  it('looksLikeOutlineLetter returns true for outline-style text, false for prose', () => {
    const outline = 'Dear Hiring Manager,\nState role (Azure Engineer) and company. Mention interest.\nConnect X to Y.\nYours sincerely, Jane.';
    const prose = 'Dear Hiring Manager,\n\nI am writing to apply for the Azure Engineer role at Green Light PS Pty Ltd.\n\nYours sincerely,\nJane Doe.';
    assert.strictEqual(looksLikeOutlineLetter(outline), true);
    assert.strictEqual(looksLikeOutlineLetter(prose), false);
  });
});

// ---------- Remote Ollama (https): ensure we get output when using remote hosted model ----------

describe('remote Ollama (HTTPS) produces output', () => {
  const REMOTE_URL = 'https://ollama.remote.example.com';
  const indexPath = path.join(__dirname, '..', 'document-creation', 'cover-letter-generator', 'index.js');
  const indexResolved = require.resolve(indexPath);

  function mockBothProtocols(generateResponseText) {
    const body = { response: generateResponseText, done: true };
    const restoreHttp = http.request;
    const restoreHttps = https.request;

    function createMockRequest() {
      return function (opts, responseCallback) {
        const isGenerate = opts.method === 'POST' && (opts.path === '/api/generate' || (opts.pathname && opts.pathname.includes && opts.pathname.includes('/api/generate')));
        const pathStr = opts.path || opts.pathname || '';
        const isGeneratePath = pathStr.includes('/api/generate');
        const statusCode = isGeneratePath && opts.method === 'POST' ? 200 : 200;
        const mockRes = {
          statusCode,
          _dataListener: null,
          _endListener: null,
          on(ev, fn) {
            if (ev === 'data') this._dataListener = fn;
            if (ev === 'end') this._endListener = fn;
            return this;
          },
        };
        const mockReq = {
          write: () => {},
          end: () => {
            setImmediate(() => {
              if (mockRes._dataListener && isGeneratePath && opts.method === 'POST') {
                mockRes._dataListener(Buffer.from(JSON.stringify(body)));
              }
              if (mockRes._endListener) mockRes._endListener();
            });
          },
          on: () => mockReq,
        };
        setImmediate(() => responseCallback(mockRes));
        return mockReq;
      };
    }

    http.request = createMockRequest('http');
    https.request = createMockRequest('https');

    return () => {
      http.request = restoreHttp;
      https.request = restoreHttps;
    };
  }

  it('ensureOllamaRunning does not spawn and callOllamaGenerate returns output when OLLAMA_BASE_URL is remote https', async () => {
    const savedEnv = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = REMOTE_URL;
    delete require.cache[indexResolved];
    const remoteIndex = require(indexPath);
    const restoreMocks = mockBothProtocols('Dear Hiring Manager,\n\nI am writing to apply via the remote model.\n\nYours sincerely,\n[Your full name]');

    try {
      const { startedByUs } = await remoteIndex.ensureOllamaRunning({ spawnIfNeeded: true });
      assert.strictEqual(startedByUs, false, 'should not start local Ollama when remote URL is used');

      const text = await remoteIndex.callOllamaGenerate('test prompt');
      assert.ok(text.length > 0, 'remote generate must return non-empty output');
      assert.ok(text.includes('remote model'), text);
    } finally {
      restoreMocks();
      if (savedEnv !== undefined) process.env.OLLAMA_BASE_URL = savedEnv;
      else delete process.env.OLLAMA_BASE_URL;
      delete require.cache[indexResolved];
      require(indexPath); // re-load default so later tests see localhost again
    }
  });

  it('callOllamaGenerate with remote http URL returns output when https mock is not used (http path)', async () => {
    const savedEnv = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = 'http://remote.example.com';
    delete require.cache[indexResolved];
    const remoteIndex = require(indexPath);
    const restoreMocks = mockBothProtocols('Output from remote http host.');

    try {
      const text = await remoteIndex.callOllamaGenerate('test');
      assert.strictEqual(text, 'Output from remote http host.');
    } finally {
      restoreMocks();
      if (savedEnv !== undefined) process.env.OLLAMA_BASE_URL = savedEnv;
      else delete process.env.OLLAMA_BASE_URL;
      delete require.cache[indexResolved];
      require(indexPath);
    }
  });

  it('full pipeline with mocked Ollama (NDJSON) produces .txt with non-zero bytes', async () => {
    const ndjsonBody =
      JSON.stringify({ response: 'Dear Hiring Manager,\n\n', done: false }) +
      '\n' +
      JSON.stringify({ response: 'I am writing to apply for the role at Acme Corp.\n\nYours sincerely,\n', done: false }) +
      '\n' +
      JSON.stringify({ response: 'Jane Doe', done: true });
    const restoreHttp = http.request;
    const restoreHttps = https.request;
    http.request = function (opts, responseCallback) {
      const pathStr = opts.path || opts.pathname || '';
      const isGenerate = opts.method === 'POST' && pathStr.includes('/api/generate');
      const mockRes = {
        statusCode: 200,
        _dataListener: null,
        _endListener: null,
        on(ev, fn) {
          if (ev === 'data') this._dataListener = fn;
          if (ev === 'end') this._endListener = fn;
          return this;
        },
      };
      const mockReq = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            if (mockRes._dataListener && isGenerate) mockRes._dataListener(Buffer.from(ndjsonBody));
            if (mockRes._endListener) mockRes._endListener();
          });
        },
        on: () => mockReq,
      };
      setImmediate(() => responseCallback(mockRes));
      return mockReq;
    };
    https.request = http.request;

    try {
      const job = { company: 'Acme Corp', positionName: 'Engineer', description: 'Build things.' };
      const prompt = buildPromptFromTemplate(job, { applicantName: 'Jane Doe' });
      const responseText = await callOllamaGenerateWithRetry(prompt);
      assert.ok(responseText.length > 0, 'Ollama must return non-empty text');
      const cleaned = postProcessCoverLetterText(responseText, { applicantName: 'Jane Doe' });
      const outputDir = path.join(os.tmpdir(), `cover-letter-nonzero-test-${Date.now()}`);
      const jobFolderPath = path.join(outputDir, getJobId(job));
      const basename = generateCoverLetterBasename(job, { applicantLastName: 'Doe' });
      const { txtPath } = await writeCoverLetterToFolder(jobFolderPath, cleaned, { basename });
      const stat = fs.statSync(txtPath);
      assert.ok(stat.size > 0, 'cover letter .txt file must not be zero bytes');
      const content = fs.readFileSync(txtPath, 'utf-8');
      assert.ok(content.trim().length > 0, 'cover letter .txt content must be non-empty');
      try {
        fs.rmSync(outputDir, { recursive: true });
      } catch {
        // ignore
      }
    } finally {
      http.request = restoreHttp;
      https.request = restoreHttps;
    }
  });
});

// ---------- Step 5: Post-process and save ----------

describe('postProcessCoverLetterText (step 5)', () => {
  it('returns empty string for non-string input', () => {
    assert.strictEqual(postProcessCoverLetterText(null), '');
    assert.strictEqual(postProcessCoverLetterText(undefined), '');
  });

  it('trims and strips markdown code fences', () => {
    const raw = '```\nDear Hiring Manager,\n\nI am writing to apply.\n```';
    assert.strictEqual(
      postProcessCoverLetterText(raw),
      'Dear Hiring Manager,\n\nI am writing to apply.\n'
    );
  });

  it('collapses 4+ newlines to 3 (preserves double paragraph gap)', () => {
    const raw = 'Para one.\n\n\n\n\nPara two.';
    const out = postProcessCoverLetterText(raw);
    assert.ok(out.includes('\n\n\n'), 'should preserve 3 newlines (double gap)');
    assert.ok(!out.includes('\n\n\n\n'), 'should collapse 4+ newlines to 3');
  });

  it('ensures output ends with single newline', () => {
    const raw = 'Hello world';
    assert.strictEqual(postProcessCoverLetterText(raw), 'Hello world\n');
  });

  it('replaces name placeholders with applicantName when provided', () => {
    const raw = 'Yours sincerely,\n\n[Your full name]';
    const withName = postProcessCoverLetterText(raw, { applicantName: 'William Darker' });
    assert.ok(withName.includes('William Darker'), withName);
    assert.ok(!withName.includes('[Your full name]'), withName);

    const insertHere = postProcessCoverLetterText('Sign-off,\n\nInsert name here', { applicantName: 'Jane Doe' });
    assert.ok(insertHere.includes('Jane Doe'), insertHere);
    assert.ok(!insertHere.includes('Insert name here'), insertHere);
  });

  it('leaves placeholders unchanged when applicantName is empty', () => {
    const raw = 'Yours sincerely,\n\n[Your full name]';
    assert.strictEqual(postProcessCoverLetterText(raw), raw.trimEnd() + '\n');
    assert.strictEqual(postProcessCoverLetterText(raw, {}), raw.trimEnd() + '\n');
  });
});

describe('runCoverLetterChecks (step 5)', () => {
  it('fails when [Your full name] or other placeholders are present', () => {
    const r1 = runCoverLetterChecks('Yours sincerely,\n\n[Your full name]');
    assert.strictEqual(r1.ok, false);
    assert.ok(r1.errors.some((e) => /Your full name/i.test(e)), r1.errors);

    const r2 = runCoverLetterChecks('Sign-off,\n\nInsert name here');
    assert.strictEqual(r2.ok, false);
    assert.ok(r2.errors.some((e) => /Insert name here/i.test(e)), r2.errors);
  });

  it('fails when cover letter is empty', () => {
    const r = runCoverLetterChecks('   \n  ');
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => /empty/i.test(e)), r.errors);
  });

  it('passes when no placeholders and content present', () => {
    const r = runCoverLetterChecks('Yours sincerely,\n\nWilliam Darker');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.errors.length, 0);
  });
});

describe('generateOutputFilename (step 5)', () => {
  const job = { company: 'Acme Corp', positionName: 'Engineer' };

  it('produces YYMMDD.LastName.CL.CompanyName format', () => {
    const name = generateOutputFilename(job, { applicantLastName: 'Doe', outputFormat: 'txt' });
    assert.ok(/^\d{6}\.Doe\.CL\.AcmeCorp\.txt$/.test(name), name);
  });

  it('uses .docx when outputFormat is docx', () => {
    const name = generateOutputFilename(job, { applicantLastName: 'Smith', outputFormat: 'docx' });
    assert.strictEqual(path.extname(name), '.docx');
    assert.ok(name.includes('Smith'));
  });

  it('sanitizes company name (no spaces)', () => {
    const name = generateOutputFilename(
      { company: 'Big Company Pty Ltd' },
      { applicantLastName: 'X', outputFormat: 'txt' }
    );
    assert.ok(!name.includes(' '));
    assert.ok(name.includes('CL.'));
  });

  it('defaults lastName to Applicant when not provided', () => {
    const name = generateOutputFilename(job, { outputFormat: 'txt' });
    assert.ok(name.includes('Applicant'));
  });
});

describe('generateOutputFolderName (step 5)', () => {
  const job = { company: 'Acme Corp', positionName: 'Engineer' };

  it('produces folder name without file extension', () => {
    const name = generateOutputFolderName(job, { applicantLastName: 'Doe' });
    assert.ok(/^\d{6}\.Doe\.CL\.AcmeCorp$/.test(name), name);
    assert.ok(!name.endsWith('.txt') && !name.endsWith('.docx') && !name.endsWith('.pdf'));
  });

  it('matches base of generateOutputFilename', () => {
    const folderName = generateOutputFolderName(job, { applicantLastName: 'X' });
    const fileTxt = generateOutputFilename(job, { applicantLastName: 'X', outputFormat: 'txt' });
    assert.strictEqual(path.basename(fileTxt, '.txt'), folderName);
  });
});

describe('writeCoverLetterToFolder (step 5)', () => {
  const tempDir = path.join(os.tmpdir(), `cover-letter-folder-test-${Date.now()}`);
  const jobFolder = path.join(tempDir, '260215.Doe.CL.Acme');

  before(() => {
    fs.mkdirSync(tempDir, { recursive: true });
  });

  after(() => {
    try {
      fs.rmSync(tempDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  it('creates folder with coverletter.txt, coverletter.docx, coverletter.pdf', async () => {
    const text = 'Dear Hiring Manager,\n\nI am writing to apply for the role.';
    const { txtPath, docxPath, pdfPath } = await writeCoverLetterToFolder(jobFolder, text);
    assert.ok(fs.existsSync(txtPath));
    assert.ok(fs.existsSync(docxPath));
    assert.ok(fs.existsSync(pdfPath));
    assert.strictEqual(fs.readFileSync(txtPath, 'utf-8'), text + (text ? '\n' : ''));
    assert.ok(path.basename(txtPath).startsWith(COVERLETTER_BASENAME));
    assert.ok(path.basename(docxPath).startsWith(COVERLETTER_BASENAME));
    assert.ok(path.basename(pdfPath).startsWith(COVERLETTER_BASENAME));
    const pdfBuf = fs.readFileSync(pdfPath);
    assert.ok(Buffer.isBuffer(pdfBuf) && pdfBuf.length > 100);
  });

  it('written .txt file has non-zero size and non-empty content', async () => {
    const text = 'Dear Hiring Manager,\n\nI am writing to apply for the Software Engineer role at Acme Corp.\n\nYours sincerely,\nJane Doe';
    const { txtPath } = await writeCoverLetterToFolder(jobFolder, text);
    const stat = fs.statSync(txtPath);
    assert.ok(stat.size > 0, 'cover letter .txt file must not be zero bytes');
    const content = fs.readFileSync(txtPath, 'utf-8');
    assert.ok(content.trim().length > 0, 'cover letter .txt content must be non-empty');
  });
});

describe('DOCX white-text AI message (testLetters)', () => {
  const testLettersDir = path.join(DEFAULT_OUTPUT_DIR, 'testLetters');
  const whiteTextDocxPath = path.join(testLettersDir, 'white-text-test.docx');

  before(() => {
    fs.mkdirSync(testLettersDir, { recursive: true });
  });

  it('creates a DOCX in coverletter/testLetters with white-text AI message', async () => {
    const bodyText = 'Dear Hiring Manager,\n\nI am writing to apply.';
    const paragraphs = buildCoverLetterDocxParagraphs(bodyText);
    const doc = new Document({ sections: [{ children: paragraphs }] });
    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(whiteTextDocxPath, buffer);

    assert.ok(fs.existsSync(whiteTextDocxPath));
    const stat = fs.statSync(whiteTextDocxPath);
    assert.ok(stat.size > 100, 'DOCX file should have content');
  });

  it('stripAiMessageFromCoverLetterText removes HTML/markdown/plain AI message', () => {
    const withHtml = `Yours sincerely,\n\n<font color="#ffffff">**${AI_COVER_LETTER_MESSAGE}**</font>`;
    assert.ok(!stripAiMessageFromCoverLetterText(withHtml).includes(AI_COVER_LETTER_MESSAGE));

    const withPlain = `Yours sincerely,\n\n${AI_COVER_LETTER_MESSAGE}`;
    assert.ok(!stripAiMessageFromCoverLetterText(withPlain).includes(AI_COVER_LETTER_MESSAGE));
  });
});

describe('textToPdfBuffer (step 5)', () => {
  it('returns a buffer for plain text', async () => {
    const buf = await textToPdfBuffer('Line one.\nLine two.');
    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.length > 50);
  });

  it('handles empty string', async () => {
    const buf = await textToPdfBuffer('');
    assert.ok(Buffer.isBuffer(buf));
  });

  it('wraps long lines so PDF text does not run off the page', async () => {
    const { PDFDocument, StandardFonts } = require('pdf-lib');
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontSize = 11;
    const margin = 50;
    const pageWidth = 595;
    const contentWidth = pageWidth - 2 * margin;

    const longLine =
      'I am excited to apply for the Junior Web Designer role at Education Web Solutions Pty Ltd, where I can utilize my skills.';
    const wrapped = wrapLineForPdf(longLine, contentWidth, font, fontSize);

    assert.ok(wrapped.length >= 2, 'long line should wrap into multiple lines');
    for (const segment of wrapped) {
      const w = font.widthOfTextAtSize(segment, fontSize);
      assert.ok(
        w <= contentWidth + 1,
        `wrapped segment "${segment.slice(0, 30)}..." width ${w} should be <= contentWidth ${contentWidth}`
      );
    }

    const buf = await textToPdfBuffer(longLine);
    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.length > 100, 'PDF with wrapped long line should have content');
  });
});

describe('writeCoverLetter (step 5)', () => {
  const tempDir = path.join(os.tmpdir(), `cover-letter-test-${Date.now()}`);

  before(() => {
    fs.mkdirSync(tempDir, { recursive: true });
  });

  after(() => {
    try {
      fs.rmSync(tempDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  it('writes .txt file with correct content', async () => {
    const outPath = path.join(tempDir, 'test-cl.txt');
    const text = 'Dear Hiring Manager,\n\nI am writing to apply.';
    await writeCoverLetter(outPath, text, { format: 'txt' });
    assert.ok(fs.existsSync(outPath));
    assert.strictEqual(fs.readFileSync(outPath, 'utf-8'), text);
  });

  it('writes .docx file that exists and has content', async () => {
    const outPath = path.join(tempDir, 'test-cl.docx');
    const text = 'Dear Sir,\n\nI wish to apply.';
    await writeCoverLetter(outPath, text, { format: 'docx' });
    assert.ok(fs.existsSync(outPath));
    const buf = fs.readFileSync(outPath);
    assert.ok(buf.length > 100);
    assert.ok(Buffer.isBuffer(buf));
  });
});

describe('getApplicantLastName (step 5)', () => {
  it('returns APPLICANT_LAST_NAME when set', () => {
    const prev = process.env.APPLICANT_LAST_NAME;
    process.env.APPLICANT_LAST_NAME = 'Smith';
    try {
      assert.strictEqual(getApplicantLastName(), 'Smith');
    } finally {
      if (prev !== undefined) process.env.APPLICANT_LAST_NAME = prev;
      else delete process.env.APPLICANT_LAST_NAME;
    }
  });

  it('returns last word of APPLICANT_NAME when APPLICANT_LAST_NAME not set', () => {
    const prevName = process.env.APPLICANT_NAME;
    const prevLast = process.env.APPLICANT_LAST_NAME;
    delete process.env.APPLICANT_LAST_NAME;
    process.env.APPLICANT_NAME = 'Jane Doe';
    try {
      assert.strictEqual(getApplicantLastName(), 'Doe');
    } finally {
      if (prevName !== undefined) process.env.APPLICANT_NAME = prevName;
      else delete process.env.APPLICANT_NAME;
      if (prevLast !== undefined) process.env.APPLICANT_LAST_NAME = prevLast;
    }
  });

  it('returns Applicant when neither env is set', () => {
    const prevName = process.env.APPLICANT_NAME;
    const prevLast = process.env.APPLICANT_LAST_NAME;
    delete process.env.APPLICANT_NAME;
    delete process.env.APPLICANT_LAST_NAME;
    try {
      assert.strictEqual(getApplicantLastName(), 'Applicant');
    } finally {
      if (prevName !== undefined) process.env.APPLICANT_NAME = prevName;
      if (prevLast !== undefined) process.env.APPLICANT_LAST_NAME = prevLast;
    }
  });
});

// ---------- Step 6: Cleanup ----------

describe('cleanupOllamaIfStarted (step 6)', () => {
  it('does nothing when COVER_LETTER_STOP_OLLAMA is not 1', () => {
    assert.doesNotThrow(() => cleanupOllamaIfStarted());
  });
});

// ---------- Step 7: Retry ----------

describe('callOllamaGenerateWithRetry (step 7)', () => {
  it('returns response on first success', async () => {
    const restore = mockHttpRequest({
      statusCode: 200,
      body: { response: 'Hello', done: true },
    });
    try {
      const text = await callOllamaGenerateWithRetry('test', { retryAttempts: 0 });
      assert.strictEqual(text, 'Hello');
    } finally {
      restore();
    }
  });

  it('retries and succeeds on second attempt', async () => {
    let callCount = 0;
    const originalRequest = http.request;
    http.request = function (opts, cb) {
      callCount++;
      if (callCount === 1) {
        const failRes = {
          statusCode: 500,
          _endListener: null,
          on(ev, fn) {
            if (ev === 'end') this._endListener = fn;
            return this;
          },
        };
        setImmediate(() => {
          cb(failRes);
          setImmediate(() => failRes._endListener && failRes._endListener());
        });
        return { write: () => {}, end: () => {}, on: () => {} };
      }
      const mockRes = {
        statusCode: 200,
        _dataListener: null,
        _endListener: null,
        on(ev, fn) {
          if (ev === 'data') this._dataListener = fn;
          if (ev === 'end') this._endListener = fn;
          return this;
        },
      };
      const mockReq = {
        write: () => {},
        end: () => {
          setImmediate(() => {
            if (mockRes._dataListener) mockRes._dataListener(Buffer.from(JSON.stringify({ response: 'Retry OK', done: true })));
            if (mockRes._endListener) mockRes._endListener();
          });
        },
        on: () => mockReq,
      };
      setImmediate(() => cb(mockRes));
      return mockReq;
    };
    try {
      const text = await callOllamaGenerateWithRetry('test', { retryAttempts: 1, retryDelayMs: 0 });
      assert.strictEqual(text, 'Retry OK');
      assert.strictEqual(callCount, 2);
    } finally {
      http.request = originalRequest;
    }
  });

  it('rejects after all retries exhausted', async () => {
    const restore = mockHttpRequest({ statusCode: 500, body: 'Error' });
    try {
      await assert.rejects(
        async () => callOllamaGenerateWithRetry('test', { retryAttempts: 1, retryDelayMs: 0 }),
        (err) => err.message.includes('500')
      );
    } finally {
      restore();
    }
  });
});
