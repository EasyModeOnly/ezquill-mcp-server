import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withRequest } from '../src/lib/request-context.js';

let dir;
let cachePath;
let credentials;

// Each test gets its own module instance, because the cache is deliberately
// memoised per process and a shared one would let tests leak into each other.
async function load() {
  return import(`../src/lib/credentials.js?v=${Math.random()}`);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ezq-'));
  cachePath = join(dir, 'token.json');
  process.env.EZQUILL_TOKEN_PATH = cachePath;
  delete process.env.EZQUILL_TOKEN;
  credentials = await load();
});

afterEach(() => {
  delete process.env.EZQUILL_TOKEN;
  delete process.env.EZQUILL_TOKEN_PATH;
});

describe('credential precedence, one way only', () => {
  test('the request context beats everything', async () => {
    process.env.EZQUILL_TOKEN = 'env-token';
    await credentials.storeTokens({ accessToken: 'oauth-token', expiresAt: Date.now() + 1e6 });

    const resolved = await withRequest({ token: 'request-token' }, () =>
      credentials.resolveCredential()
    );
    assert.equal(resolved.token, 'request-token');
    assert.equal(resolved.source, 'request');
  });

  test('an EXPLICIT env credential beats a cached sign-in', async () => {
    // Somebody who sets EZQUILL_TOKEN is stating which account this server acts
    // as. A cached sign-in quietly winning would make that setting a lie, with
    // no way to tell from outside which was used.
    process.env.EZQUILL_TOKEN = 'env-token';
    await credentials.storeTokens({ accessToken: 'oauth-token', expiresAt: Date.now() + 1e6 });

    const resolved = await credentials.resolveCredential();
    assert.equal(resolved.token, 'env-token');
    assert.equal(resolved.source, 'env');
  });

  test('a cached sign-in is used when nothing else is set', async () => {
    await credentials.storeTokens({ accessToken: 'oauth-token', expiresAt: Date.now() + 1e6 });
    const resolved = await credentials.resolveCredential();
    assert.equal(resolved.token, 'oauth-token');
    assert.equal(resolved.source, 'oauth');
  });

  test('nothing configured resolves to nothing, not a throw', async () => {
    const resolved = await credentials.resolveCredential();
    assert.equal(resolved.token, '');
    assert.equal(resolved.source, 'none');
  });
});

describe('the token cache', () => {
  test('is written 0600, and an existing loose file is tightened', async () => {
    // writeFile's mode applies only on CREATE, so a file written earlier under
    // a different umask would keep its permissions without the explicit chmod.
    await writeFile(cachePath, '{}', { mode: 0o644 });
    const fresh = await load();
    await fresh.storeTokens({ accessToken: 'x' });

    const mode = (await stat(cachePath)).mode & 0o777;
    assert.equal(mode, 0o600, `mode was ${mode.toString(8)}`);
  });

  test('a corrupt cache reads as "not signed in" rather than crashing', async () => {
    await writeFile(cachePath, 'not json at all');
    const fresh = await load();
    assert.equal((await fresh.resolveCredential()).source, 'none');
  });

  test('signing out removes the file', async () => {
    await credentials.storeTokens({ accessToken: 'x' });
    await readFile(cachePath, 'utf8'); // exists
    await credentials.forgetTokens();
    await assert.rejects(() => readFile(cachePath, 'utf8'));
    assert.equal((await credentials.resolveCredential()).source, 'none');
  });

  test('hasExplicitCredential reflects only the env var', async () => {
    assert.equal(credentials.hasExplicitCredential(), false);
    process.env.EZQUILL_TOKEN = 'x';
    assert.equal(credentials.hasExplicitCredential(), true);
  });
});
