import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS } from '../src/tools/index.js';
import { withRequest } from '../src/lib/request-context.js';
import { Code } from '../src/lib/errors.js';
import { resetWritingTypes } from '../src/lib/writing-types.js';
import { MAX_NODES } from '../src/tools/write-projects.js';
import { isRemoteSafe } from '../src/lib/remote-tools.js';

const tool = (name) => TOOLS.find((t) => t.name === name);
const run = (name, args) => withRequest({ token: 't' }, () => tool(name).handler(args));

/** The contract GET /writing-types serves. */
const REGISTRY = {
  writingTypes: [
    {
      key: 'novel',
      levels: [
        { key: 'part', label: 'Part', pluralLabel: 'Parts', children: ['chapter'], carriesProse: false, numbered: true },
        { key: 'chapter', label: 'Chapter', pluralLabel: 'Chapters', children: ['scene'], carriesProse: true, numbered: true },
        { key: 'scene', label: 'Scene', pluralLabel: 'Scenes', children: [], carriesProse: true, numbered: false },
      ],
      plantedLevels: ['part', 'chapter'],
    },
    {
      key: 'blog',
      levels: [{ key: 'post', label: 'Post', pluralLabel: 'Posts', children: [], carriesProse: true, numbered: false }],
      plantedLevels: ['post'],
    },
    // A script: its levels are its shape's, plus shots with production on
    // (ezquill epic #48). The entry's own levels are the default variant's.
    (() => {
      const act = { key: 'act', label: 'Act', children: ['sequence'], carriesProse: false, numbered: true };
      const sequence = { key: 'sequence', label: 'Sequence', children: ['scene'], carriesProse: false };
      const scene = { key: 'scene', label: 'Scene', children: [], carriesProse: true, numbered: true };
      const episode = { key: 'episode', label: 'Episode', children: ['scene'], carriesProse: false, numbered: true };
      const shot = { key: 'shot', label: 'Shot', children: [], carriesProse: true, numbered: true, produced: true };
      const withShot = (levels) => [...levels.map((l) => (l.key === 'scene' ? { ...l, children: ['shot'] } : l)), shot];
      const feature = [act, sequence, scene];
      const series = [episode, scene];
      const v = (shape, production, levels, plantedLevels) => ({ shape, production, levels, plantedLevels });
      return {
        key: 'script',
        levels: feature,
        plantedLevels: ['act', 'sequence', 'scene'],
        variants: [
          v('feature', false, feature, ['act', 'sequence', 'scene']),
          v('feature', true, withShot(feature), ['act', 'sequence', 'scene']),
          v('parts', false, feature, ['act', 'sequence', 'scene']),
          v('parts', true, withShot(feature), ['act', 'sequence', 'scene']),
          v('series', false, series, ['episode', 'scene']),
          v('series', true, withShot(series), ['episode', 'scene']),
        ],
      };
    })(),
  ],
};

/**
 * Records every request. A route answering `{status}` with a non-2xx status
 * fails, so a partial failure can be staged.
 */
function stub(routes) {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    sent.push({ path: u.pathname, method, body });

    for (const [pattern, respond] of Object.entries(routes)) {
      const [m, suffix] = pattern.split(' ');
      if (m === method && u.pathname.endsWith(suffix)) {
        const value = typeof respond === 'function' ? respond(body) : respond;
        if (value?.fail) {
          return { ok: false, status: value.fail, statusText: 'Bad', json: async () => ({ error: { message: 'nope' } }) };
        }
        return { ok: true, status: 200, json: async () => value };
      }
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return sent;
}

const realFetch = globalThis.fetch;
beforeEach(() => resetWritingTypes());
afterEach(() => { globalThis.fetch = realFetch; });

const created = { id: 'p1', title: 'Harbour', writingType: 'novel', status: 'planning' };
const happy = () => ({
  'GET /writing-types': REGISTRY,
  'POST /projects': created,
  'POST /batch': (body) => ({ nodes: body.nodes }),
});

describe('create_project — refusals happen before anything exists', () => {
  test('an unknown node type is refused and NO project is created', async () => {
    // The API stores any node type, so this is the only place `fiction` or
    // `book` can be stopped. Refusing after the POST would leave an empty
    // project on the dashboard.
    const sent = stub(happy());
    await assert.rejects(
      () => run('create_project', {
        title: 'Harbour', writingType: 'novel',
        structure: [{ title: 'Part One', nodeType: 'part', children: [{ title: 'X', nodeType: 'book' }] }],
      }),
      (err) => {
        assert.equal(err.code, Code.UNKNOWN_NODE_TYPE);
        assert.deepEqual(err.detail.allowed, ['part', 'chapter', 'scene']);
        return true;
      }
    );
    assert.ok(!sent.some((r) => r.method === 'POST'), 'nothing may be created');
  });

  test('a missing node type is refused, never defaulted', async () => {
    const sent = stub(happy());
    await assert.rejects(
      () => run('create_project', { title: 'H', writingType: 'novel', structure: [{ title: 'One' }] }),
      (err) => err.code === Code.UNKNOWN_NODE_TYPE
    );
    assert.ok(!sent.some((r) => r.method === 'POST'));
  });

  test('a level from ANOTHER writing type is refused', async () => {
    stub(happy());
    await assert.rejects(
      () => run('create_project', { title: 'H', writingType: 'blog', structure: [{ title: 'C', nodeType: 'chapter' }] }),
      (err) => err.code === Code.UNKNOWN_NODE_TYPE
    );
  });

  test(`more than ${MAX_NODES} nodes is refused before the project exists`, async () => {
    const sent = stub(happy());
    const structure = Array.from({ length: MAX_NODES + 1 }, (_, i) => ({ title: `P${i}`, nodeType: 'post' }));
    await assert.rejects(
      () => run('create_project', { title: 'H', writingType: 'blog', structure }),
      (err) => err.detail?.max === MAX_NODES
    );
    assert.ok(!sent.some((r) => r.method === 'POST'));
  });

  test(`exactly ${MAX_NODES} nodes is allowed`, async () => {
    stub({ ...happy(), 'POST /projects': { ...created, writingType: 'blog' } });
    const structure = Array.from({ length: MAX_NODES }, (_, i) => ({ title: `P${i}`, nodeType: 'post' }));
    const result = await run('create_project', { title: 'H', writingType: 'blog', structure });
    assert.equal(result.created.length, MAX_NODES);
  });
});

describe('create_project — what is sent', () => {
  test('the project body carries only CreateInput fields', async () => {
    // DisallowUnknownFields: an extra key is a 400.
    const sent = stub(happy());
    await run('create_project', { title: 'Harbour', writingType: 'novel', synopsis: 'S', genre: 'G', structure: [] });
    const post = sent.find((r) => r.method === 'POST' && r.path.endsWith('/projects'));
    assert.deepEqual(Object.keys(post.body).sort(), ['genre', 'synopsis', 'title', 'writingType']);
    assert.ok(!sent.some((r) => r.path.endsWith('/batch')), 'no structure, no batch');
  });

  test('parents precede children and children name them', async () => {
    const sent = stub(happy());
    await run('create_project', {
      title: 'Harbour', writingType: 'novel',
      structure: [
        { title: 'Part One', nodeType: 'part', children: [
          { title: 'Ch 1', nodeType: 'chapter' }, { title: 'Ch 2', nodeType: 'chapter' },
        ] },
        { title: 'Part Two', nodeType: 'part', children: [{ title: 'Ch 3', nodeType: 'chapter' }] },
      ],
    });

    const nodes = sent.find((r) => r.path.endsWith('/projects/p1/nodes/batch')).body.nodes;
    assert.equal(nodes.length, 5);
    const index = new Map(nodes.map((n, i) => [n.id, i]));
    for (const [i, n] of nodes.entries()) {
      if (n.parentId) assert.ok(index.get(n.parentId) < i, `${n.title} precedes its parent`);
    }
    const byTitle = Object.fromEntries(nodes.map((n) => [n.title, n]));
    assert.equal(byTitle['Ch 1'].parentId, byTitle['Part One'].id);
    assert.equal(byTitle['Ch 3'].parentId, byTitle['Part Two'].id);
    assert.ok(!('parentId' in byTitle['Part One']));
    assert.deepEqual([byTitle['Ch 1'].order, byTitle['Ch 2'].order], [0, 1]);
  });

  // ezquill epic #37: a numbered level is named by its number until the
  // writer names it, and a typed "Chapter 3" would go stale on reorder.
  test('a numbered level may be untitled; an unnumbered one may not', async () => {
    const sent = stub(happy());
    await run('create_project', {
      title: 'Harbour', writingType: 'novel',
      structure: [{ nodeType: 'part', children: [{ nodeType: 'chapter' }, { title: '  ', nodeType: 'chapter' }] }],
    });
    const nodes = sent.find((r) => r.path.endsWith('/batch')).body.nodes;
    assert.deepEqual(nodes.map((n) => n.title), ['', '', '']);

    await assert.rejects(
      () => run('create_project', { title: 'H', writingType: 'blog', structure: [{ nodeType: 'post' }] }),
      /needs a title/
    );
  });

  test('content only on prose levels, and it is the wizard\'s empty document', async () => {
    // Its absence is what declares a container.
    const sent = stub(happy());
    await run('create_project', {
      title: 'Harbour', writingType: 'novel',
      structure: [{ title: 'Part One', nodeType: 'part', children: [{ title: 'Ch 1', nodeType: 'chapter' }] }],
    });
    const [part, chapter] = sent.find((r) => r.path.endsWith('/batch')).body.nodes;
    assert.ok(!('content' in part));
    assert.deepEqual(chapter.content, { document: { type: 'doc', content: [] }, plainText: '' });
  });

  test('the result carries levels, plantedLevels and the project URL', async () => {
    process.env.EZQUILL_APP_BASE_URL = 'https://dev.ezquill.com';
    stub(happy());
    const result = await run('create_project', { title: 'Harbour', writingType: 'novel' });
    delete process.env.EZQUILL_APP_BASE_URL;
    assert.equal(result.project.id, 'p1');
    assert.deepEqual(result.plantedLevels, ['part', 'chapter']);
    assert.deepEqual(result.levels.map((l) => l.key), ['part', 'chapter', 'scene']);
    assert.equal(result.url, 'https://dev.ezquill.com/project/p1');
  });

  test('a failed structure after the project exists carries the projectId', async () => {
    // The obvious retry makes a second project.
    stub({ ...happy(), 'POST /batch': { fail: 400 } });
    await assert.rejects(
      () => run('create_project', {
        title: 'Harbour', writingType: 'novel', structure: [{ title: 'Ch', nodeType: 'chapter' }],
      }),
      (err) => {
        assert.equal(err.code, Code.STRUCTURE_FAILED);
        assert.equal(err.toResult().projectId, 'p1');
        assert.match(err.message, /manage_outline/);
        return true;
      }
    );
  });

  test('the writing type is a closed enum in the schema', () => {
    const schema = tool('create_project').inputSchema;
    assert.equal(schema.properties.writingType.enum.length, 9);
    assert.ok(!schema.properties.writingType.enum.includes('fiction'));
    // Both became `script` (ezquill epic #48), and the API refuses them new.
    assert.ok(schema.properties.writingType.enum.includes('script'));
    assert.ok(!schema.properties.writingType.enum.includes('screenplay'));
    assert.ok(!schema.properties.writingType.enum.includes('shortform-video'));
    assert.deepEqual(schema.required.sort(), ['title', 'writingType']);
  });

  test('a failed registry fetch is not cached', async () => {
    let calls = 0;
    stub({
      'GET /writing-types': () => (++calls === 1 ? { fail: 503 } : REGISTRY),
      'POST /projects': created,
    });
    await assert.rejects(() => run('create_project', { title: 'H', writingType: 'novel' }));
    const result = await run('create_project', { title: 'H', writingType: 'novel' });
    assert.equal(result.project.id, 'p1');
  });

  test('is served remotely', () => {
    assert.ok(isRemoteSafe('create_project'));
  });
});

describe('manage_outline add — node types checked against the project', () => {
  test('an unknown type is refused before the batch', async () => {
    const sent = stub({
      'GET /writing-types': REGISTRY,
      'GET /projects/p': { id: 'p', writingType: 'blog' },
      'POST /batch': (body) => ({ nodes: body.nodes }),
    });
    await assert.rejects(
      () => run('manage_outline', { projectId: 'p', action: 'add', nodes: [{ title: 'C', nodeType: 'chapter' }] }),
      (err) => err.code === Code.UNKNOWN_NODE_TYPE && err.detail.allowed.includes('post')
    );
    assert.ok(!sent.some((r) => r.method === 'POST'));
  });

  test('a known type goes through', async () => {
    stub({
      'GET /writing-types': REGISTRY,
      'GET /projects/p': { id: 'p', writingType: 'blog' },
      'POST /batch': (body) => ({ nodes: body.nodes }),
    });
    const result = await run('manage_outline', { projectId: 'p', action: 'add', nodes: [{ title: 'P', nodeType: 'post' }] });
    assert.equal(result.created.length, 1);
  });
});

describe('create_project — a script', () => {
  test('sends the shape and the switch, and checks levels against that variant', async () => {
    const sent = stub({ ...happy(), 'POST /projects': { ...created, writingType: 'script', shape: 'series', production: true } });
    const result = await run('create_project', {
      title: 'Saltpig', writingType: 'script', shape: 'series', production: true,
      structure: [{ nodeType: 'episode', children: [{ nodeType: 'scene', children: [{ nodeType: 'shot' }] }] }],
    });
    const post = sent.find((r) => r.method === 'POST' && r.path.endsWith('/projects'));
    assert.deepEqual(
      { writingType: post.body.writingType, shape: post.body.shape, production: post.body.production },
      { writingType: 'script', shape: 'series', production: true }
    );
    assert.deepEqual(result.levels.map((l) => l.key), ['episode', 'scene', 'shot']);
    assert.equal(result.project.shape, 'series');
  });

  test('defaults a script to a written feature', async () => {
    const sent = stub({ ...happy(), 'POST /projects': { ...created, writingType: 'script', shape: 'feature' } });
    await run('create_project', { title: 'Heat', writingType: 'script' });
    const post = sent.find((r) => r.method === 'POST' && r.path.endsWith('/projects'));
    assert.equal(post.body.shape, 'feature');
    assert.equal(post.body.production, false);
  });

  test('a shot without production is not a level, and nothing is created', async () => {
    const sent = stub(happy());
    await assert.rejects(
      () => run('create_project', {
        title: 'H', writingType: 'script', shape: 'series',
        structure: [{ nodeType: 'episode', children: [{ nodeType: 'scene', children: [{ nodeType: 'shot' }] }] }],
      }),
      (err) => err.code === Code.UNKNOWN_NODE_TYPE
    );
    assert.ok(!sent.some((r) => r.method === 'POST'));
  });

  test('a shape on a type that has none is refused before anything exists', async () => {
    const sent = stub(happy());
    await assert.rejects(() => run('create_project', { title: 'H', writingType: 'novel', shape: 'series' }));
    assert.ok(!sent.some((r) => r.method === 'POST'));
  });
});

// A show is a series of season projects (ezquill epic #47).
describe('create_project for a show', () => {
  test('a new show makes its series, then Season 1 in it', async () => {
    const sent = stub({
      'GET /writing-types': REGISTRY,
      'POST /series': { id: 's1', title: 'Night Ferry' },
      'POST /projects': (b) => ({ id: 'p1', ...b, status: 'active' }),
    });
    const out = await run('create_project', { title: 'Night Ferry', writingType: 'script', shape: 'series', production: true });

    const series = sent.find((r) => r.method === 'POST' && r.path.endsWith('/series'));
    assert.deepEqual(series.body.writingType, 'script');
    const project = sent.find((r) => r.method === 'POST' && r.path.endsWith('/projects'));
    assert.equal(project.body.title, 'Night Ferry, Season 1');
    assert.equal(project.body.seriesId, 's1');
    assert.equal(project.body.seriesOrder, 1);
    assert.deepEqual(out.series, { id: 's1', title: 'Night Ferry' });
    assert.equal(out.project.seriesOrder, 1);
  });

  test('a feature stays one project, with no series', async () => {
    const sent = stub({
      'GET /writing-types': REGISTRY,
      'POST /projects': (b) => ({ id: 'p1', ...b, status: 'active' }),
    });
    await run('create_project', { title: 'Heat', writingType: 'script', shape: 'feature' });
    assert.equal(sent.some((r) => r.path.endsWith('/series')), false);
  });

  test('seriesId adds the next season, carrying shape and production over', async () => {
    const sent = stub({
      'GET /writing-types': REGISTRY,
      'GET /series/s1': { id: 's1', title: 'Tidewater', projects: [{ id: 'a', seriesOrder: 1 }, { id: 'b', seriesOrder: 2 }] },
      'GET /projects/b': { id: 'b', shape: 'series', production: true },
      'POST /projects': (b) => ({ id: 'p3', ...b, status: 'active' }),
    });
    const out = await run('create_project', { title: 'ignored', writingType: 'script', seriesId: 's1' });
    const project = sent.find((r) => r.method === 'POST' && r.path.endsWith('/projects'));
    assert.equal(project.body.title, 'Tidewater, Season 3');
    assert.equal(project.body.seriesOrder, 3);
    assert.equal(project.body.shape, 'series');
    assert.equal(project.body.production, true);
    assert.equal(sent.some((r) => r.method === 'POST' && r.path.endsWith('/series')), false);
    assert.equal(out.project.seriesId, 's1');
  });

  test('a refused first season takes its new series with it', async () => {
    const sent = stub({
      'GET /writing-types': REGISTRY,
      'POST /series': { id: 's1', title: 'Night Ferry' },
      'POST /projects': { fail: 403 },
    });
    await assert.rejects(() => run('create_project', { title: 'Night Ferry', writingType: 'script', shape: 'series' }));
    assert.ok(sent.some((r) => r.method === 'DELETE' && r.path.endsWith('/series/s1')));
  });
});
