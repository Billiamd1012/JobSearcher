/**
 * Tests for cover letter generator steps 3 (prompt construction) and 4 (call Ollama).
 * Run: npm test (or node --test test/cover-letter-generator.test.js)
 *
 * Prompt tests are unit tests. Ollama generate tests mock http.request (no live Ollama needed).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const {
  buildPromptFromTemplate,
  callOllamaGenerate,
} = require('../document-creation/cover-letter-generator.js');

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
