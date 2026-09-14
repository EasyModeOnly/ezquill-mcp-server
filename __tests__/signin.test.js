import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from '../src/lib/create-server.js';
import { cancelSignIn } from '../src/lib/oauth.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// No window may appear because a test ran.
process.env.EZQUILL_NO_BROWSER = '1';

/**
 * A stand-in authorization server, so the sign-in flow is exercised for real
 * rather than described by a mock. Only discovery is needed: the flow returns
 * its url and stops, which is the behaviour under test.
 */
const issuers = [];

async function fakeIssuer() {
  const server = createHttpServer((req, res) => {
    if (req.url.startsWith('/.well-known/openid-configuration')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        authorization_endpoint: 'https://auth.example.test/auth',
        token_endpoint: 'https://auth.example.test/token',
      }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  issuers.push(server);
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

/** Call a tool through the server's real dispatch path, funnel included. */
async function callTool(server, name, args = {}) {
  const handler = server._requestHandlers.get(CallToolRequestSchema.shape.method.value);
  return handler({ method: 'tools/call', params: { name, arguments: args } }, {});
}

const parse = (result) => JSON.parse(result.content[0].text);

afterEach(() => {
  // Closed HERE rather than at the end of each test body. An assertion that
  // fails throws before any trailing close() runs, leaving a listening server
  // that keeps the event loop alive — so the suite HANGS precisely when a test
  // fails, which is the moment you least want to wait ninety seconds to find
  // out. Cleanup that only runs on success is not cleanup.
  while (issuers.length) issuers.pop().close();

  // A pending flow is module state: left standing, the next test would be
  // handed the previous one's url by the "same url while pending" rule.
  cancelSignIn();
  delete process.env.EZQUILL_ISSUER;
  delete process.env.EZQUILL_TOKEN;
  delete process.env.EZQUILL_TOKEN_PATH;
});

describe('the sign-in funnel', () => {
  test('an unauthenticated call returns a link as a PLAIN result, not an error', async () => {
    // The single most important property. A client that treats isError as a
    // failure would swallow the link, and the tool result is the only channel
    // that reaches a person: stdout is the protocol and stderr is a log nobody
    // opens.
    const issuer = await fakeIssuer();
    process.env.EZQUILL_ISSUER = issuer.url;
    process.env.EZQUILL_TOKEN_PATH = '/nonexistent/ezquill/token.json';

    const server = createServer({ surface: 'local' });
    const result = await callTool(server, 'list_projects');

    assert.notEqual(result.isError, true, 'the sign-in prompt must not be an error');
    const body = parse(result);
    assert.equal(body.status, 'sign_in_required');
    assert.match(body.authUrl, /^https:\/\/auth\.example\.test\/auth\?/);

    // PKCE, and the loopback the callback comes back to.
    const url = new URL(body.authUrl);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('code_challenge'));
    assert.match(url.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    // Delete is NOT requested by default: Keycloak's consent screen is
    // accept-or-decline over the whole set, so asking would make "permanently
    // delete your work" a condition of installing.
    assert.ok(!url.searchParams.get('scope').includes('ezquill:delete'));

    issuer.server.close();
  });

  test('it fires on the FIRST call, with no second hop', async () => {
    const issuer = await fakeIssuer();
    process.env.EZQUILL_ISSUER = issuer.url;
    process.env.EZQUILL_TOKEN_PATH = '/nonexistent/ezquill/token.json';

    const server = createServer({ surface: 'local' });
    const body = parse(await callTool(server, 'get_outline', { projectId: 'p' }));
    assert.equal(body.status, 'sign_in_required',
      'the first call must start the flow, not tell the agent to call another tool');

    issuer.server.close();
  });

  test('a second call while one is pending returns the SAME url', async () => {
    // Two live flows means two listeners and two states, and whichever url the
    // person did not click sits there until it times out — then they are told
    // the sign-in failed when it did not.
    const issuer = await fakeIssuer();
    process.env.EZQUILL_ISSUER = issuer.url;
    process.env.EZQUILL_TOKEN_PATH = '/nonexistent/ezquill/token.json';

    const server = createServer({ surface: 'local' });
    const first = parse(await callTool(server, 'list_projects'));
    const second = parse(await callTool(server, 'list_projects'));
    assert.equal(first.authUrl, second.authUrl);

    issuer.server.close();
  });

  test('an explicit EZQUILL_TOKEN suppresses the offer', async () => {
    // The env credential outranks a cached sign-in, so a browser flow could not
    // take effect. Offering one sends somebody on an errand that cannot work.
    process.env.EZQUILL_TOKEN = 'explicit-but-rejected';
    const server = createServer({ surface: 'local' });

    globalThis.fetch = async () => ({
      ok: false, status: 401, statusText: '', json: async () => ({ error: { message: 'nope' } }),
    });

    const result = await callTool(server, 'list_projects');
    assert.equal(result.isError, true);
    assert.equal(parse(result).error, 'NOT_AUTHENTICATED');
  });

  test('a 403 does NOT offer a sign-in', async () => {
    // Signed in but not permitted — a scope never granted, or a project this
    // person cannot reach. Signing in again cannot fix either, and a familiar
    // sign-in prompt hides the real reason behind something that looks routine.
    const issuer = await fakeIssuer();
    process.env.EZQUILL_ISSUER = issuer.url;
    // A CACHED sign-in, not EZQUILL_TOKEN. Using the env var would make
    // hasExplicitCredential() true, which suppresses the offer on its own — so
    // the test would pass without the 403 rule existing at all.
    const dir = await mkdtemp(join(tmpdir(), 'ezq-403-'));
    const cache = join(dir, 'token.json');
    await writeFile(cache, JSON.stringify({ accessToken: 'limited', expiresAt: Date.now() + 1e6 }));
    process.env.EZQUILL_TOKEN_PATH = cache;

    globalThis.fetch = async () => ({
      ok: false, status: 403, statusText: '',
      json: async () => ({ error: { message: 'read-only connection' } }),
    });

    const server = createServer({ surface: 'local' });
    const result = await callTool(server, 'list_projects');

    assert.equal(result.isError, true);
    assert.equal(parse(result).error, 'FORBIDDEN_SCOPE');
    assert.ok(!('authUrl' in parse(result)), 'a 403 must not hand back a sign-in link');

    issuer.server.close();
  });

  test('the remote surface never offers a sign-in', async () => {
    // Over a connector the CLIENT owns the OAuth flow; signing the SERVER in as
    // somebody is not what the caller asked for.
    process.env.EZQUILL_TOKEN_PATH = '/nonexistent/ezquill/token.json';
    const server = createServer({ surface: 'remote' });

    const result = await callTool(server, 'list_projects');
    assert.equal(result.isError, true, 'the remote surface must report the error plainly');
    assert.equal(parse(result).error, 'NOT_AUTHENTICATED');
  });

  test('the sign-in tools are not dispatchable on the remote surface', async () => {
    const server = createServer({ surface: 'remote' });
    const result = await callTool(server, 'authenticate');
    assert.equal(result.isError, true);
    assert.match(parse(result).message, /Unknown tool/);
  });
});
