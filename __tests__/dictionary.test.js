import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS } from '../src/tools/index.js';
import { withRequest } from '../src/lib/request-context.js';
import { Code } from '../src/lib/errors.js';

const tool = (name) => TOOLS.find((t) => t.name === name);
const run = (name, args) => withRequest({ token: 't' }, () => tool(name).handler(args));

const BASE = 'https://api.test.example';

/**
 * Stub the network only, keyed on the EXACT raw path (encoding included), so a
 * wrong prefix or an unencoded word misses every route and shows up as a 404.
 * A route may answer `{ __status, body }` to fail with that JSON body.
 */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const raw = String(url);
    const u = new URL(raw);
    calls.push({ url: raw, path: u.pathname, query: u.searchParams });
    const respond = routes[u.pathname];
    if (respond === undefined) {
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
    }
    if (respond.__status) {
      return { ok: false, status: respond.__status, statusText: '', json: async () => respond.body };
    }
    return { ok: true, status: 200, json: async () => respond };
  };
  return calls;
}

const realFetch = globalThis.fetch;
const realBase = process.env.EZQUILL_API_BASE_URL;
process.env.EZQUILL_API_BASE_URL = BASE;
afterEach(() => { globalThis.fetch = realFetch; });
process.on('exit', () => {
  if (realBase === undefined) delete process.env.EZQUILL_API_BASE_URL;
  else process.env.EZQUILL_API_BASE_URL = realBase;
});

const sources = [{ id: 'oewn', name: 'Open English WordNet', version: '2024', license: 'CC BY 4.0',
  licenseUrl: 'x', sourceUrl: 'y', attribution: 'z', importedAt: '2026-01-01T00:00:00Z' }];

function page(slug) {
  return {
    page: {
      headword: { slug, display: slug, senseCount: 1, relationCount: 2 },
      entries: [{
        lemma: slug, pos: 'verb', source: 'oewn',
        senses: [{
          key: `${slug}%2:38:00::`, gloss: 'move fast', examples: [], tags: [],
          synonyms: [{ lemma: 'sprint', slug: 'sprint', source: 'oewn', weight: 0.8 }],
          similar: [], antonyms: [{ lemma: 'walk', slug: 'walk', source: 'oewn', weight: 0 }],
          broader: [], narrower: [], also: [],
        }],
      }],
      moreSynonyms: [], formOf: [], forms: [], sources,
    },
  };
}

describe('lookup_word', () => {
  test('returns the page in the API shape, dropping only empty sense arrays', async () => {
    stubFetch({ '/api/v1/words/run': page('run') });
    const result = await run('lookup_word', { word: 'run' });

    assert.equal(result.headword.slug, 'run');
    assert.deepEqual(result.sources, sources, 'attribution is required by the licences');
    const sense = result.entries[0].senses[0];
    assert.equal(sense.key, 'run%2:38:00::', 'the key is what a favourite names a sense by');
    assert.equal(sense.gloss, 'move fast');
    assert.equal(sense.synonyms[0].lemma, 'sprint');
    assert.equal(sense.antonyms[0].weight, 0, 'a non-empty array is kept whole');
    for (const empty of ['examples', 'tags', 'similar', 'broader', 'narrower', 'also']) {
      assert.ok(!(empty in sense), `${empty} is empty and dropped`);
    }
    assert.ok(!('resolvedFrom' in result), 'no redirect, no resolvedFrom');
  });

  test('follows a redirect once, naming where it came from', async () => {
    const formOf = [{ form: 'ran', lemma: 'run', lemmaSlug: 'run', pos: 'verb', tags: ['past'], source: 'oewn' }];
    const calls = stubFetch({
      '/api/v1/words/ran': { redirectTo: 'run', formOf },
      '/api/v1/words/run': page('run'),
    });
    const result = await run('lookup_word', { word: 'ran' });

    assert.equal(calls.length, 2);
    assert.equal(result.headword.slug, 'run');
    assert.equal(result.resolvedFrom, 'ran');
    assert.deepEqual(result.inflectionOf, formOf);
  });

  test("carries the thesaurus-only page it redirected past (ezquill #375)", async () => {
    const from = { ...page('books').page, moreSynonyms: [{ lemma: 'ledger', slug: 'ledger', source: 'moby', weight: 1 }] };
    stubFetch({
      '/api/v1/words/books': { redirectTo: 'book', from },
      '/api/v1/words/book': page('book'),
    });
    const result = await run('lookup_word', { word: 'books' });

    assert.equal(result.headword.slug, 'book');
    assert.equal(result.from.headword.slug, 'books');
    assert.deepEqual(result.from.moreSynonyms.map((r) => r.slug), ['ledger']);
  });

  test('never follows a second redirect', async () => {
    const calls = stubFetch({
      '/api/v1/words/a': { redirectTo: 'b' },
      '/api/v1/words/b': { redirectTo: 'a' },
    });
    const result = await run('lookup_word', { word: 'a' });

    assert.equal(calls.length, 2, 'exactly one redirect followed');
    assert.equal(result.redirectTo, 'b');
    assert.match(result.note, /only one redirect/);
  });

  test('a redirect to itself is not followed at all', async () => {
    const calls = stubFetch({ '/api/v1/words/loop': { redirectTo: 'loop' } });
    const result = await run('lookup_word', { word: 'loop' });
    assert.equal(calls.length, 1);
    assert.ok(result.note);
  });

  test('a 404 returns the suggestions rather than throwing', async () => {
    const suggestions = [{ slug: 'sanguine', display: 'sanguine', match: 'fuzzy', senseCount: 2 }];
    stubFetch({
      '/api/v1/words/sanguin': { __status: 404, body: { error: { message: 'no such word' }, suggestions } },
    });
    const result = await run('lookup_word', { word: 'sanguin' });
    assert.deepEqual(result, { found: false, word: 'sanguin', suggestions });
  });

  test('a 400 is still an ordinary error', async () => {
    stubFetch({
      '/api/v1/words/%3F%3F%3F': { __status: 400, body: { error: { message: 'a word needs a letter' } } },
    });
    await assert.rejects(
      () => run('lookup_word', { word: '???' }),
      (err) => err.code === Code.REQUEST_FAILED && /needs a letter/.test(err.message)
    );
  });

  test('a word with a space or an apostrophe is URL-encoded', async () => {
    const calls = stubFetch({
      '/api/v1/words/give%20up': page('give-up'),
      "/api/v1/words/o'clock": page('oclock'),
    });
    await run('lookup_word', { word: 'give up' });
    await run('lookup_word', { word: "o'clock" });

    assert.equal(calls[0].url, `${BASE}/api/v1/words/give%20up`);
    // encodeURIComponent leaves the apostrophe alone, and so does the URL
    // parser; what matters is that it is one path segment, not two.
    assert.equal(calls[1].url, `${BASE}/api/v1/words/o'clock`);
  });

  test('a slash cannot escape the words route', async () => {
    const calls = stubFetch({});
    await run('lookup_word', { word: 'and/or' });
    assert.equal(calls[0].url, `${BASE}/api/v1/words/and%2For`);
  });
});

describe('list_word_favorites', () => {
  const fav = { id: 'f1', slug: 'run', word: 'run', note: '', createdAt: 'c', updatedAt: 'u', inDictionary: true };

  test('is served from the API ROOT, never under /api/v1', async () => {
    // The API registers /me routes at its root. Under /api/v1 they 404, which
    // a tool would report as "you have no favourites".
    const calls = stubFetch({ '/me/words': { items: [fav], total: 1, hasMore: false } });
    const result = await run('list_word_favorites', {});

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE}/me/words`);
    assert.ok(!calls[0].url.includes('/api/v1'));
    assert.deepEqual(result, { items: [fav], total: 1, hasMore: false });
  });

  test('passes the query through, omitting empty parameters', async () => {
    const calls = stubFetch({ '/me/words': { items: [], total: 0, hasMore: false } });
    await run('list_word_favorites', { q: 'ru', pos: '', limit: 20, offset: 40 });

    const query = calls[0].query;
    assert.equal(query.get('q'), 'ru');
    assert.equal(query.get('limit'), '20');
    assert.equal(query.get('offset'), '40');
    assert.ok(!query.has('pos'), 'an empty pos is not sent');
  });

  test('with a word, lists every star on that word', async () => {
    const calls = stubFetch({
      '/me/words/give%20up': { items: [fav, { ...fav, id: 'f2', senseKey: 'k', gloss: 'g' }] },
    });
    const result = await run('list_word_favorites', { word: 'give up' });

    assert.equal(calls[0].url, `${BASE}/me/words/give%20up`);
    assert.equal(result.items.length, 2);
    assert.ok(!('total' in result));
  });
});
