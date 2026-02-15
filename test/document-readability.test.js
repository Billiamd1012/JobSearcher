/**
 * Tests that resume and cover letter documents can be opened, extracted as text,
 * and contain coherent human-readable content suitable for the LLM.
 *
 * Run: npm test (or node --test test/document-readability.test.js)
 *
 * Requires document-creation/documents/resume/ and/or document-creation/documents/coverletter/ to exist with
 * .txt, .docx, or .pdf files. If a directory is missing or empty, those tests are skipped.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const {
  readTextFromFile,
  loadResume,
  loadSampleCoverLetter,
  DEFAULT_RESUME_DIR,
  DEFAULT_COVERLETTER_DIR,
  SUPPORTED_DOC_EXTENSIONS,
} = require('../document-creation/cover-letter-generator.js');

const MIN_LENGTH = 15;
const MIN_WORDS = 2;
const MIN_READABLE_RATIO = 0.5;

/**
 * Heuristic: text is coherent human-readable and usable by an LLM if it has
 * minimum length, no null bytes, is mostly letters/spaces/punctuation, and has at least a few words.
 * @param {string} text
 * @returns {{ ok: boolean, reason?: string }}
 */
function isCoherentAndUsable(text) {
  if (typeof text !== 'string') {
    return { ok: false, reason: 'content is not a string' };
  }
  if (text.includes('\0')) {
    return { ok: false, reason: 'content contains null bytes (binary or corrupted)' };
  }
  if (text.length < MIN_LENGTH) {
    return {
      ok: false,
      reason: `content too short (${text.length} chars, min ${MIN_LENGTH}) or extraction failed`,
    };
  }
  const readable = text.replace(/[^\w\s.,;:'"\-—–\n\r]/g, '');
  const ratio = readable.length / text.length;
  if (ratio < MIN_READABLE_RATIO) {
    return {
      ok: false,
      reason: `content mostly non-readable characters (readable ratio ${ratio.toFixed(2)}, min ${MIN_READABLE_RATIO})`,
    };
  }
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length < MIN_WORDS) {
    return {
      ok: false,
      reason: `too few words (${words.length}, min ${MIN_WORDS})`,
    };
  }
  return { ok: true };
}

function listSupportedFiles(dir) {
  const resolved = path.isAbsolute(dir) ? dir : path.resolve(__dirname, '..', dir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return [];
  }
  return fs
    .readdirSync(resolved)
    .filter((f) => SUPPORTED_DOC_EXTENSIONS.includes(path.extname(f).toLowerCase()))
    .map((f) => path.join(resolved, f));
}

describe('Resume and cover letter document readability', () => {
  describe('coherence heuristic', () => {
    it('rejects empty, too short, or non-readable content', () => {
      assert.ok(!isCoherentAndUsable('').ok);
      assert.ok(!isCoherentAndUsable('hi').ok);
      assert.ok(!isCoherentAndUsable('a'.repeat(20)).ok); // no words
      assert.ok(!isCoherentAndUsable('x\u0000y'.repeat(10)).ok);
    });
    it('accepts coherent human-readable text', () => {
      assert.ok(isCoherentAndUsable('Dear Hiring Manager, I am writing to apply for the role.').ok);
      assert.ok(isCoherentAndUsable('Software Engineer with 5 years experience in Node.js and React.').ok);
    });
  });

  describe('document-creation/documents/resume/', () => {
    const files = listSupportedFiles(DEFAULT_RESUME_DIR);

    if (files.length === 0) {
      it('no supported resume files to test (add .txt, .docx or .pdf to document-creation/documents/resume/)', () => {
        // Skip when dir missing or no supported files
      });
    } else {
      for (const filePath of files) {
        const name = path.basename(filePath);
        it(`resume "${name}" opens and yields coherent LLM-usable text`, async () => {
          const text = await readTextFromFile(filePath);
          const result = isCoherentAndUsable(text);
          assert.ok(result.ok, `Resume ${name}: ${result.reason || 'coherence check failed'}`);
        });
      }
    }

    it('loadResume() returns coherent text when it finds a file', async () => {
      const text = await loadResume(null);
      if (text.length === 0) return; // no file found, nothing to assert
      const result = isCoherentAndUsable(text);
      assert.ok(result.ok, `loadResume(): ${result.reason || 'coherence check failed'}`);
    });
  });

  describe('document-creation/documents/coverletter/', () => {
    const files = listSupportedFiles(DEFAULT_COVERLETTER_DIR);

    if (files.length === 0) {
      it('no supported cover letter files to test (add .txt, .docx or .pdf to document-creation/documents/coverletter/)', () => {});
    } else {
      for (const filePath of files) {
        const name = path.basename(filePath);
        it(`cover letter "${name}" opens and yields coherent LLM-usable text`, async () => {
          const text = await readTextFromFile(filePath);
          const result = isCoherentAndUsable(text);
          assert.ok(result.ok, `Cover letter ${name}: ${result.reason || 'coherence check failed'}`);
        });
      }
    }

    it('loadSampleCoverLetter() returns coherent text when it finds a sample', async () => {
      const text = await loadSampleCoverLetter();
      if (text.length === 0) return;
      const result = isCoherentAndUsable(text);
      assert.ok(result.ok, `loadSampleCoverLetter(): ${result.reason || 'coherence check failed'}`);
    });
  });
});
