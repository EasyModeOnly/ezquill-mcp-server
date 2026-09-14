import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

/**
 * The remote transport's contract, exercised against the real process.
 *
 * These are the three things the deploy verification checks in production, so
 * they are worth pinning here where a failure is cheap: an unauthenticated POST
 * must 401 with a pointer to the metadata document, GET must explain the 405
 * rather than look broken, and /health must answer without touching the API.
 */
let proc;
let base;

before(async () => {
  proc = spawn(process.execPath, ['src/http.js'], {
    env: { ...process.env, PORT: '0', EZQUILL_API_BASE_URL: 'http://127.0.0.1:9' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // The port is printed on stderr; PORT=0 would leave us guessing otherwise.
  for await (const chunk of proc.stderr) {
    const match = String(chunk).match(/listening on :(\d+)/);
    if (match) { base = `http://127.0.0.1:${match[1]}`; break; }
  }
  if (!base) throw new Error('server did not report a port');
});

after(async () => {
  proc?.kill('SIGTERM');
  await once(proc, 'exit').catch(() => {});
});

describe('the remote transport', () => {
  test('an unauthenticated POST is 401 and points at the metadata document', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
    });
    assert.equal(res.status, 401);

    const challenge = res.headers.get('www-authenticate') ?? '';
    assert.match(challenge, /^Bearer /);
    // RFC 9728 puts it at the DOMAIN ROOT with the resource path appended, not
    // under the resource path. Routing only /mcp and forgetting this second
    // path makes the handshake fail before anyone sees a consent screen.
    assert.match(challenge, /\/\.well-known\/oauth-protected-resource\/mcp/);
  });

  test('GET is 405 and says why, rather than looking broken', async () => {
    const res = await fetch(`${base}/mcp`);
    assert.equal(res.status, 405);
    assert.match((await res.json()).message, /stateless/i);
  });

  test('health does not depend on the ezQuill API', async () => {
    // The API base points at a closed port for this whole suite. A health check
    // that proxied would turn somebody else's outage into this service being
    // marked unhealthy.
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'ok');
  });

  test('an unknown path is 404, not a hung request', async () => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});
