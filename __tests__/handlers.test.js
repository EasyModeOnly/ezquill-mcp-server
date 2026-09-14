import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS } from '../src/tools/index.js';
import { withRequest } from '../src/lib/request-context.js';
import { Code } from '../src/lib/errors.js';

const tool = (name) => TOOLS.find((t) => t.name === name);

/**
 * Stub the one thing that leaves this process.
 *
 * Handlers are tested through their real code path — schema, query building,
 * paging, shaping — with only the network replaced. A mock of the API client
 * would assert the behaviour the mock was written to have.
 */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, query: u.searchParams, method: init?.method ?? 'GET', init });

    for (const [pattern, respond] of Object.entries(routes)) {
      if (u.pathname.endsWith(pattern)) {
        const result = typeof respond === 'function' ? respond(u, init) : respond;
        if (result?.__status) {
          return {
            ok: false,
            status: result.__status,
            statusText: '',
            json: async () => ({ error: { message: result.message ?? '' } }),
          };
        }
        return { ok: true, status: 200, json: async () => result };
      }
    }
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
  };
  return calls;
}

const run = (name, args) => withRequest({ token: 't' }, () => tool(name).handler(args));

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('search_project', () => {
  test('returns no score of any kind, and renames header to context', async () => {
    stubFetch({
      '/search': {
        results: [
          { sourceType: 'node', sourceId: 's1', title: 'Ch 1', text: 'Her words.', header: 'Part I > Ch 1', distance: 0.6 },
        ],
      },
    });

    const { results } = await run('search_project', { projectId: 'p', query: 'q' });
    const keys = Object.keys(results[0]);

    assert.ok(!keys.includes('distance'), 'distance must never reach a caller');
    assert.ok(!keys.some((k) => /score|relevance|rank/i.test(k)), 'no score-shaped field');
    assert.equal(results[0].text, 'Her words.');
    assert.equal(results[0].context, 'Part I > Ch 1', 'header is returned as context');
    assert.ok(!('header' in results[0]));
  });

  test('preserves the order the API returned', async () => {
    // Order is the whole signal, so it must survive the mapping untouched.
    stubFetch({
      '/search': { results: ['a', 'b', 'c'].map((t, i) => ({ sourceId: t, text: t, distance: 0.9 - i })) },
    });
    const { results } = await run('search_project', { projectId: 'p', query: 'q' });
    assert.deepEqual(results.map((r) => r.sourceId), ['a', 'b', 'c']);
  });

  test('a 503 is SEARCH_UNAVAILABLE, never an empty result list', async () => {
    stubFetch({ '/search': { __status: 503, message: 'not configured' } });
    await assert.rejects(
      () => run('search_project', { projectId: 'p', query: 'q' }),
      (err) => {
        assert.equal(err.code, Code.SEARCH_UNAVAILABLE);
        assert.match(err.message, /not a statement about/i,
          'the message must deny making a claim about the manuscript');
        return true;
      }
    );
  });
});

describe('list_projects', () => {
  test('an empty account is NO_PROJECTS, not an empty list', async () => {
    stubFetch({ '/projects': { projects: [], hasMore: false, total: 0 } });
    await assert.rejects(
      () => run('list_projects', {}),
      (err) => err.code === Code.NO_PROJECTS
    );
  });

  test('an empty SEARCH result is an empty list, not NO_PROJECTS', async () => {
    // "You have nothing" and "nothing matched that word" are different facts.
    stubFetch({ '/projects': { projects: [], hasMore: false, total: 0 } });
    const result = await run('list_projects', { search: 'zzz' });
    assert.deepEqual(result.projects, []);
  });

  test('NO_PROJECTS hands back a URL, not a description of one', async () => {
    // Somebody can register from the connector's own sign-in page, so this
    // reaches people who have never opened ezQuill. "In the app" names a place
    // they have not been.
    process.env.EZQUILL_APP_BASE_URL = 'https://dev.ezquill.com';
    stubFetch({ '/projects': { projects: [], hasMore: false, total: 0 } });
    await assert.rejects(
      () => run('list_projects', {}),
      (err) => {
        assert.equal(err.code, Code.NO_PROJECTS);
        assert.equal(err.detail.createProjectUrl, 'https://dev.ezquill.com/new/project');
        assert.equal(
          err.toResult().createProjectUrl,
          'https://dev.ezquill.com/new/project',
          'the URL must survive serialisation into the tool result'
        );
        return true;
      }
    );
    delete process.env.EZQUILL_APP_BASE_URL;
  });

  test('an empty SHARED list offers no create link', async () => {
    // Somebody waiting to be invited to someone else's project is not helped by
    // a link to make their own, and offering it suggests the invitation was the
    // misunderstanding.
    stubFetch({ '/projects': { projects: [], hasMore: false, total: 0 } });
    await assert.rejects(
      () => run('list_projects', { shared: true }),
      (err) => {
        assert.equal(err.code, Code.NO_PROJECTS);
        assert.equal(err.detail.createProjectUrl, undefined);
        return true;
      }
    );
  });

  test('a refused request is FORBIDDEN_SCOPE, never NO_PROJECTS', async () => {
    // The inverse mistake, and the one that gets debugged in the wrong place:
    // reporting "you were not allowed to see this" as "this does not exist"
    // sends a writer looking for a manuscript they still have.
    stubFetch({ '/projects': { __status: 403 } });
    await assert.rejects(
      () => run('list_projects', {}),
      (err) => err.code === Code.FORBIDDEN_SCOPE
    );
  });

  test('shared:true asks for collaborator projects', async () => {
    const calls = stubFetch({ '/projects': { projects: [{ id: 'p', title: 'T', progress: {} }] } });
    await run('list_projects', { shared: true });
    assert.equal(calls[0].query.get('role'), 'collaborator');
  });
});

describe('read_scene', () => {
  test('assembles prose from blocks when the node itself is bare', async () => {
    // The epic #32 regression: fetching the node alone reports an empty scene
    // for every scene actually written.
    stubFetch({
      '/nodes/s1/entities': { cast: [{ entityId: 'e', name: 'Ana', kind: 'character', role: 'pov' }] },
      '/nodes/s1': { id: 's1', title: 'Arrival', nodeType: 'scene', hasProse: false, wordCount: 4 },
      '/nodes': {
        nodes: [
          { id: 'b2', nodeType: 'block', order: 2, hasProse: true, content: { plainText: 'Then dusk.' } },
          { id: 'b1', nodeType: 'block', order: 1, hasProse: true, content: { plainText: 'She arrived.' } },
        ],
        hasMore: false,
      },
    });

    const scene = await run('read_scene', { projectId: 'p', nodeId: 's1' });
    assert.equal(scene.prose, 'She arrived.\n\nThen dusk.');
    assert.equal(scene.cast[0].role, 'pov', 'roles are raw, not labelled');
  });

  test('a cast fetch failing does not lose the prose', async () => {
    stubFetch({
      '/nodes/s1/entities': { __status: 500 },
      '/nodes/s1': { id: 's1', title: 'A', hasProse: true, content: { plainText: 'Words.' } },
      '/nodes': { nodes: [], hasMore: false },
    });
    const scene = await run('read_scene', { projectId: 'p', nodeId: 's1' });
    assert.equal(scene.prose, 'Words.');
    assert.deepEqual(scene.cast, []);
  });
});

describe('get_outline', () => {
  test('withholds prose and pages until the server stops saying there is more', async () => {
    let page = 0;
    const calls = stubFetch({
      '/nodes': () => {
        page += 1;
        return page === 1
          ? { nodes: [{ id: 'a', nodeType: 'chapter', order: 0 }], hasMore: true }
          : { nodes: [{ id: 'b', nodeType: 'chapter', order: 1 }], hasMore: false };
      },
    });

    const { outline } = await run('get_outline', { projectId: 'p' });
    assert.equal(calls[0].query.get('omitContent'), 'true');
    assert.equal(calls.length, 2, 'a second page must be fetched');
    assert.deepEqual(outline.map((n) => n.id), ['a', 'b'],
      'a project over the page cap would otherwise come back with holes in it');
  });
});

describe('get_entity', () => {
  test('resolves the profile so the writer edit wins', async () => {
    stubFetch({
      '/relations': { relations: [] },
      '/appearances': { appearances: [] },
      '/entities/e1': {
        id: 'e1', name: 'Ana', kind: 'character',
        profile: { role: 'Deckhand', authored: { role: 'Captain' } },
      },
    });
    const entity = await run('get_entity', { projectId: 'p', entityId: 'e1' });
    assert.equal(entity.profile.role, 'Captain');
    assert.ok(!('authored' in entity.profile));
  });
});

describe('list_feedback', () => {
  test('an empty-string replacement is still a suggestion', async () => {
    // It proposes CUTTING the passage. Truthiness would turn "cut this" into an
    // ordinary remark and lose the suggestion entirely.
    stubFetch({
      '/comments': {
        comments: [
          { id: 'c1', body: 'Cut it', replacement: '', anchor: { text: 'the passage' } },
          { id: 'c2', body: 'Just a note' },
        ],
      },
    });
    const { threads } = await run('list_feedback', { projectId: 'p' });
    assert.equal(threads[0].isSuggestion, true, 'replacement:"" is a suggestion');
    assert.equal(threads[0].replacement, '');
    assert.equal(threads[1].isSuggestion, false);
  });
});

describe('authentication', () => {
  test('no credential is NOT_AUTHENTICATED, before any network call', async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; };
    await assert.rejects(
      () => withRequest({}, () => tool('list_projects').handler({})),
      (err) => err.code === Code.NOT_AUTHENTICATED
    );
    assert.equal(called, false, 'must not reach the network without a credential');
  });

  test('a 403 is FORBIDDEN_SCOPE, distinct from 401', async () => {
    // Signing in again cannot fix a scope that was never granted.
    stubFetch({ '/projects': { __status: 403, message: 'read-only connection' } });
    await assert.rejects(
      () => run('list_projects', {}),
      (err) => err.code === Code.FORBIDDEN_SCOPE
    );
  });
});
