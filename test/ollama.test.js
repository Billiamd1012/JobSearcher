/**
 * Tests that Ollama is running and the API responds.
 * Run: npm test (or node --test test/ollama.test.js)
 *
 * Requires Ollama to be running (e.g. `ollama serve`). Use OLLAMA_BASE_URL
 * to point at a different host (default: http://localhost:11434).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

/**
 * GET a path on the Ollama base URL; returns { statusCode, body } or throws.
 * @param {string} path - e.g. '/' or '/api/tags'
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
function ollamaGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path || '/', OLLAMA_BASE_URL);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'GET',
        timeout: 5000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

describe('Ollama', () => {
  it('responds at base URL', async () => {
    const { statusCode } = await ollamaGet('/');
    assert.ok(
      statusCode >= 200 && statusCode < 500,
      `Expected 2xx/3xx, got ${statusCode}. Is Ollama running? (ollama serve)`
    );
  });

  it('API /api/tags returns JSON with models array', async () => {
    const { statusCode, body } = await ollamaGet('/api/tags');
    assert.strictEqual(statusCode, 200, `Expected 200 from /api/tags, got ${statusCode}`);
    const data = JSON.parse(body);
    assert.ok(Array.isArray(data.models), 'Response should have "models" array');
  });
});
