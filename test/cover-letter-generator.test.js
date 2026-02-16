/**
 * Tests for cover letter generator steps 3 (prompt construction) and 4 (call Ollama).
 * Run: npm test (or node --test test/cover-letter-generator.test.js)
 * Uses document-creation/cover-letter-generator (index.js).
 *
 * Prompt tests are unit tests. Ollama generate tests mock http.request (no live Ollama needed).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  buildPromptFromTemplate,
  callOllamaGenerate,
  callOllamaGenerateWithRetry,
  postProcessCoverLetterText,
  generateOutputFolderName,
  generateOutputFilename,
  writeCoverLetter,
  writeCoverLetterToFolder,
  textToPdfBuffer,
  getApplicantLastName,
  cleanupOllamaIfStarted,
  COVERLETTER_BASENAME,
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

  it('collapses 3+ newlines to 2', () => {
    const raw = 'Para one.\n\n\n\nPara two.';
    assert.ok(postProcessCoverLetterText(raw).includes('\n\n'));
    assert.ok(!postProcessCoverLetterText(raw).includes('\n\n\n'));
  });

  it('ensures output ends with single newline', () => {
    const raw = 'Hello world';
    assert.strictEqual(postProcessCoverLetterText(raw), 'Hello world\n');
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
    assert.strictEqual(fs.readFileSync(txtPath, 'utf-8'), text);
    assert.ok(path.basename(txtPath).startsWith(COVERLETTER_BASENAME));
    assert.ok(path.basename(docxPath).startsWith(COVERLETTER_BASENAME));
    assert.ok(path.basename(pdfPath).startsWith(COVERLETTER_BASENAME));
    const pdfBuf = fs.readFileSync(pdfPath);
    assert.ok(Buffer.isBuffer(pdfBuf) && pdfBuf.length > 100);
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
