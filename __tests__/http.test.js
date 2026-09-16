import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * The remote transport's contract, exercised against the real process.
 *
 * These are the things the deploy verification checks in production, so they
 * are worth pinning here where a failure is cheap: an unauthenticated POST must
 * 401 with a pointer to the metadata document, GET must explain the 405 rather
 * than look broken, /health must answer without touching the API, and /version
 * must report the build without a token.
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

  test('serves RFC 9728 metadata at the domain root, unauthenticated', async () => {
    // A client reads this precisely because it has no credential yet, so a 401
    // here would make the handshake unresolvable.
    const res = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    assert.equal(res.status, 200);

    const doc = await res.json();
    assert.match(doc.resource, /\/mcp$/);
    assert.ok(Array.isArray(doc.authorization_servers) && doc.authorization_servers.length === 1);
    assert.deepEqual(doc.scopes_supported, ['ezquill:read', 'ezquill:write']);
    assert.deepEqual(doc.bearer_methods_supported, ['header']);
  });

  test('the remote sign-in never asks for delete (#323)', async () => {
    // A client requests the challenge's `scope`, else every scope in
    // scopes_supported. Either one naming delete puts it on the consent
    // screen, where declining it means not connecting at all.
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
    });
    const challenge = res.headers.get('www-authenticate') ?? '';
    const scope = challenge.match(/scope="([^"]+)"/)?.[1];
    assert.ok(scope, `no scope in ${challenge}`);
    assert.deepEqual(scope.split(' ').sort(), ['ezquill:read', 'ezquill:write', 'openid']);

    const doc = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.ok(!doc.scopes_supported.includes('ezquill:delete'));
  });

  test('the 401 challenge points at a path this server actually answers', async () => {
    // The failure this prevents is silent: a challenge naming a path nobody
    // serves makes the handshake fail before a person ever sees a consent
    // screen, with an error that says nothing about routing.
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
    });
    const challenge = res.headers.get('www-authenticate') ?? '';
    const advertised = challenge.match(/resource_metadata="([^"]+)"/)?.[1];
    assert.ok(advertised, `no resource_metadata in ${challenge}`);

    const followed = await fetch(advertised.replace(/^https:/, 'http:'));
    assert.equal(followed.status, 200, 'the advertised metadata url must resolve');
  });

  test('version answers without a token, and names the build', async () => {
    // No Authorization header on purpose. The whole value of this endpoint is
    // that it answers the one question a token cannot help you ask — which
    // build is running — so a 401 here would leave it no better than /mcp.
    const res = await fetch(`${base}/version`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.name, 'ezquill-mcp-server');
    assert.equal(body.version, pkg.version);
    // Nothing set EZQUILL_BUILD_SHA for this process, and an unknown sha must
    // read as unknown rather than as a plausible-looking string: the deploy
    // check compares this field for equality against the sha it just deployed.
    assert.equal(body.sha, null);
  });

  test('version reports the sha the deploy handed it', async () => {
    // Read from the environment, not baked into the image — deploy.yml pushes
    // one image per sha and also moves `:latest`, so only the deploy knows
    // what is actually running here.
    const child = spawn(process.execPath, ['src/http.js'], {
      env: { ...process.env, PORT: '0', EZQUILL_BUILD_SHA: 'deadbee' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    try {
      let url;
      for await (const chunk of child.stderr) {
        const match = String(chunk).match(/listening on :(\d+)/);
        if (match) { url = `http://127.0.0.1:${match[1]}/version`; break; }
      }
      assert.ok(url, 'server did not report a port');
      assert.equal((await (await fetch(url)).json()).sha, 'deadbee');
    } finally {
      child.kill('SIGTERM');
      await once(child, 'exit').catch(() => {});
    }
  });

  test('an unknown path is 404, not a hung request', async () => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});
