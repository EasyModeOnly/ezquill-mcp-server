import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { call, retry } from '../src/lib/api.js';
import { withRequest } from '../src/lib/request-context.js';

const realFetch = globalThis.fetch;
const realRetry = { ...retry };

let waits;
beforeEach(() => {
  waits = [];
  // No real time passes, and jitter is pinned so the waits are exact.
  retry.sleep = async (ms) => { waits.push(ms); };
  retry.random = () => 0;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(retry, realRetry);
});

const run = (path, opts) => withRequest({ token: 't' }, () => call(path, opts));

/** Answers each request with the next response in `script`, recording what was sent. */
function script(...responses) {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ method: init?.method ?? 'GET', body: init?.body });
    const r = responses[Math.min(sent.length - 1, responses.length - 1)];
    const headers = new Headers(r.headers ?? {});
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: '',
      headers,
      json: async () => r.body ?? {},
    };
  };
  return sent;
}

const tooMany = (retryAfter) => ({
  status: 429,
  headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter },
  body: { error: { message: 'Too many requests. Please slow down and try again.' } },
});

describe('call() retries a 429', () => {
  test('waits the Retry-After, then returns the answer', async () => {
    const sent = script(tooMany('1'), { status: 200, body: { ok: 1 } });
    assert.deepEqual(await run('/x'), { ok: 1 });
    assert.equal(sent.length, 2);
    assert.deepEqual(waits, [1000]);
  });

  test('the wait doubles per retry, with the hint as a floor', async () => {
    script(tooMany('1'), tooMany('1'), { status: 200, body: {} });
    await run('/x');
    assert.deepEqual(waits, [1000, 2000]);
  });

  test('jitter only ever lengthens the wait', async () => {
    // Returning before Retry-After is being refused again, so jitter must add.
    retry.random = () => 0.5;
    script(tooMany('2'), { status: 200, body: {} });
    await run('/x');
    assert.deepEqual(waits, [3000]);
  });

  test('gives up after three attempts with the same error as before', async () => {
    const sent = script(tooMany('1'));
    await assert.rejects(run('/x'), (err) => {
      assert.equal(err.detail.status, 429);
      assert.equal(err.detail.attempts, 3);
      assert.match(err.message, /Too many requests/);
      return true;
    });
    assert.equal(sent.length, 3);
  });

  test('a missing Retry-After falls back to a default wait', async () => {
    // The web app's routes pass an API 429 through without the header.
    script(tooMany(undefined), { status: 200, body: {} });
    await run('/api/video/compile', { app: true });
    assert.deepEqual(waits, [retry.fallbackMs]);
  });

  test('an HTTP-date Retry-After is honoured', async () => {
    const at = new Date(Date.now() + 2000).toUTCString();
    script(tooMany(at), { status: 200, body: {} });
    await run('/x');
    assert.equal(waits.length, 1);
    assert.ok(waits[0] > 0 && waits[0] <= 2000, `waited ${waits[0]}`);
  });

  test('a wait longer than the cap is refused, not slept through', async () => {
    const sent = script(tooMany('60'), { status: 200, body: {} });
    await assert.rejects(run('/x'), (err) => err.detail.status === 429 && !('attempts' in err.detail));
    assert.equal(sent.length, 1);
    assert.deepEqual(waits, []);
  });

  test('a POST is replayed with the same body', async () => {
    // Safe because the API refuses in middleware, before any handler runs.
    const sent = script(tooMany('1'), { status: 200, body: { id: 'n' } });
    await run('/nodes', { method: 'POST', body: { title: 'Shot 5' } });
    assert.equal(sent.length, 2);
    assert.equal(sent[1].method, 'POST');
    assert.equal(sent[1].body, sent[0].body);
  });

  test('no other status is retried', async () => {
    for (const status of [400, 403, 404, 409, 500, 503]) {
      const sent = script({ status, body: { error: { message: 'no' } } });
      await assert.rejects(run('/x'));
      assert.equal(sent.length, 1, `${status} was retried`);
    }
    assert.deepEqual(waits, []);
  });
});
