/**
 * A comic (ezquill epic #57, task #710): created with a required form, read as
 * pages of panels, and written through manage_comic — lettering ONLY through
 * the panel lettering route with ifRevision, boxes ONLY through panel-boxes,
 * and a speaker always a character in the cast.
 */
import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS } from '../src/tools/index.js';
import { withRequest } from '../src/lib/request-context.js';
import { Code } from '../src/lib/errors.js';
import { resetWritingTypes } from '../src/lib/writing-types.js';
import { buildTree } from '../src/lib/nodes.js';
import { resolveLettering, normaliseBoxChange } from '../src/lib/panels.js';
import { isRemoteSafe } from '../src/lib/remote-tools.js';

const tool = (name) => TOOLS.find((t) => t.name === name);
const run = (name, args) => withRequest({ token: 't' }, () => tool(name).handler(args));

const level = (key, children, carriesProse, extra = {}) => ({ key, label: key, children, carriesProse, numbered: true, ...extra });
const paged = (top) => [...top, level('page', ['panel'], true), level('panel', [], true)];
const variant = (shape, levels, plantedLevels) => ({ shape, production: false, storyboard: false, levels, plantedLevels });

/** The comic entry GET /writing-types serves (#707/#708), forms as variants. */
const REGISTRY = {
  writingTypes: [
    {
      key: 'comic',
      levels: paged([level('volume', ['chapter'], false), level('chapter', ['page'], false)]),
      plantedLevels: ['volume', 'chapter', 'page'],
      variants: [
        variant('manga', paged([level('volume', ['chapter'], false), level('chapter', ['page'], false)]), ['volume', 'chapter', 'page']),
        variant('webtoon', [level('episode', ['panel'], true), level('panel', [], true)], ['episode']),
        variant('graphic-novel', paged([level('chapter', ['page'], false)]), ['chapter', 'page']),
        variant('comic-book', paged([level('issue', ['page'], false)]), ['issue', 'page']),
      ],
    },
    { key: 'story', levels: [level('scene', [], true)], plantedLevels: ['scene'] },
  ],
  universalLevels: [],
};

const COMIC = { id: 'p', title: 'Night Market', writingType: 'comic', shape: 'graphic-novel', production: false };
const CAST = [
  { id: 'e-mira', name: 'Mira', kind: 'character' },
  { id: 'e-tok', name: 'Tok', kind: 'character' },
];

/** Records every request; a route may answer `{ status, error }` to fail. */
function stub(routes) {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const path = u.pathname.replace(/^\/api\/v1/, '');
    sent.push({ path, query: u.searchParams, method, body });
    // `match` answers what no exact route does: a route per freshly minted id.
    const respond = routes[`${method} ${path}`] ?? routes.match?.(method, path);
    if (respond === undefined) {
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({ error: { message: `no route ${method} ${path}` } }) };
    }
    const value = typeof respond === 'function' ? respond(body, u) : respond;
    if (value && value.__status) {
      return { ok: false, status: value.__status, statusText: 'x', json: async () => ({ error: { message: value.message } }) };
    }
    return { ok: true, status: 200, json: async () => value };
  };
  return sent;
}

const realFetch = globalThis.fetch;
beforeEach(() => resetWritingTypes());
afterEach(() => { globalThis.fetch = realFetch; });

const panel = (id, order, over = {}) => ({ id, nodeType: 'panel', parentId: 'pg', order, hasProse: true, title: '', ...over });
const lettered = (items, rev = 3) => ({ panel: { lettering: items, letteringRevision: rev, box: { x: 0.05, y: 0.04, w: 0.9, h: 0.3 }, z: 1 } });

const base = (over = {}) => ({
  'GET /projects/p': COMIC,
  'GET /writing-types': REGISTRY,
  'GET /projects/p/entities': { entities: CAST, hasMore: false },
  ...over,
});

describe('get_outline — panels sit under their page, as pictures', () => {
  test('a panel is kind "panel" with box, z and a lettering count, and no words', () => {
    const tree = buildTree([
      { id: 'c', nodeType: 'chapter', order: 1 },
      { id: 'pg', nodeType: 'page', parentId: 'c', order: 1, hasProse: true, wordCount: 0 },
      panel('pn1', 1, {
        wordCount: 30,
        ordinal: { display: 'Panel 1', number: 1, label: 'Panel', scope: 'parent' },
        metadata: {
          frame: { framing: 'Wide' },
          ...lettered([
            { id: 'a', kind: 'balloon', speakerId: 'e-mira', text: 'Run!' },
            { id: 'b', kind: 'sfx', text: 'KRAK' },
          ]),
        },
      }),
    ]);
    const page = tree[0].children[0];
    assert.equal(page.kind, 'unwritten', 'panels alone do not make a page written or a folder');
    assert.equal(page.wordCount, 0, 'a panel adds no words');
    const [p] = page.children;
    assert.equal(p.kind, 'panel');
    assert.equal(p.framing, 'Wide');
    assert.deepEqual(p.box, { x: 0.05, y: 0.04, w: 0.9, h: 0.3 });
    assert.equal(p.z, 1);
    assert.deepEqual(p.lettering, { items: 2, balloon: 1, thought: 0, caption: 0, sfx: 1, speakers: 1 });
    assert.ok(!JSON.stringify(p).includes('Run!'), 'the outline carries no lettering words');
    assert.equal(p.wordCount, undefined);
  });
});

describe('read_scene — a page lists its panels with lettering, speakers named', () => {
  test('on a page', async () => {
    stub(base({
      'GET /projects/p/nodes/pg': { id: 'pg', nodeType: 'page', title: '', hasProse: true, content: { plainText: 'Night.' } },
      'GET /projects/p/nodes': {
        nodes: [
          panel('pn1', 1, {
            content: { plainText: 'Mira at the stall.' },
            metadata: lettered([{ id: 'a', kind: 'balloon', speakerId: 'e-mira', text: 'Run!' }, { id: 'b', kind: 'caption', captionKind: 'time', text: 'Midnight.' }]),
          }),
        ],
        hasMore: false,
      },
      'GET /projects/p/nodes/pg/entities': { cast: [] },
    }));
    const page = await run('read_scene', { projectId: 'p', nodeId: 'pg' });
    assert.equal(page.children.length, 0, 'panels are not structural children');
    assert.equal(page.panels.length, 1);
    const [p] = page.panels;
    assert.equal(p.description, 'Mira at the stall.');
    assert.equal(p.letteringRevision, 3);
    assert.deepEqual(p.lettering[0], { id: 'a', kind: 'balloon', speakerId: 'e-mira', text: 'Run!', speaker: 'Mira' });
    assert.equal(p.lettering[1].captionKind, 'time');
    assert.ok(!page.prose.includes('Mira at the stall'), 'a panel description is not the page\'s text');
  });

  test('on a panel, returns that panel', async () => {
    stub(base({
      'GET /projects/p/nodes/pn1': panel('pn1', 1, { contentVersion: 2, metadata: lettered([{ id: 'a', kind: 'thought', speakerId: 'e-gone', text: '…' }]) }),
      'GET /projects/p/nodes': { nodes: [], hasMore: false },
      'GET /projects/p/nodes/pn1/entities': { cast: [] },
    }));
    const p = await run('read_scene', { projectId: 'p', nodeId: 'pn1' });
    assert.equal(p.kind, 'panel');
    assert.equal(p.parentId, 'pg');
    assert.equal(p.lettering[0].speaker, 'Unknown speaker', 'a deleted character never shows as a raw id');
  });
});

describe('create_project — a comic needs a form', () => {
  test('refused without one, before anything is created', async () => {
    const sent = stub({ 'GET /writing-types': REGISTRY });
    await assert.rejects(
      run('create_project', { title: 'Night Market', writingType: 'comic' }),
      (err) => err.code === Code.REQUEST_FAILED && /comic needs a form/.test(err.message) && /webtoon/.test(err.message)
    );
    assert.ok(!sent.some((r) => r.method === 'POST'));
  });

  test('a form the served registry lacks is refused', async () => {
    stub({ 'GET /writing-types': { ...REGISTRY, writingTypes: [{ ...REGISTRY.writingTypes[0], variants: REGISTRY.writingTypes[0].variants.slice(0, 1) }] } });
    await assert.rejects(
      run('create_project', { title: 'X', writingType: 'comic', shape: 'webtoon' }),
      (err) => /shape must be one of manga/.test(err.message)
    );
  });

  test('a webtoon is created with its form, and its levels are the registry\'s', async () => {
    const sent = stub({
      'GET /writing-types': REGISTRY,
      'POST /projects': (body) => ({ id: 'p2', title: body.title, writingType: body.writingType, shape: body.shape, production: false, status: 'active' }),
      'POST /projects/p2/nodes/batch': (body) => ({ nodes: body.nodes }),
    });
    const out = await run('create_project', {
      title: 'Strip', writingType: 'comic', shape: 'webtoon', structure: [{ nodeType: 'episode' }],
    });
    const create = sent.find((r) => r.method === 'POST' && r.path === '/projects');
    assert.equal(create.body.shape, 'webtoon');
    assert.equal(create.body.production, undefined, 'a comic has no production switch to send');
    assert.deepEqual(out.levels.map((l) => l.key), ['episode', 'panel']);
    assert.deepEqual(out.plantedLevels, ['episode']);
  });
});

describe('manage_comic — refused on anything but a comic', () => {
  test('a story is told to use manage_storyboard', async () => {
    const sent = stub(base({ 'GET /projects/p': { ...COMIC, writingType: 'story', shape: 'novel' } }));
    await assert.rejects(
      run('manage_comic', { projectId: 'p', action: 'set_lettering', nodeId: 'pn1', items: [] }),
      (err) => err.code === Code.NOT_A_COMIC && /manage_storyboard/.test(err.message)
    );
    assert.ok(!sent.some((r) => r.method !== 'GET'));
  });

  test('a panel id that is not a panel is refused', async () => {
    stub(base({ 'GET /projects/p/nodes/pg': { id: 'pg', nodeType: 'page' } }));
    await assert.rejects(
      run('manage_comic', { projectId: 'p', action: 'set_lettering', nodeId: 'pg', items: [] }),
      (err) => /not a panel/.test(err.message)
    );
  });

  test('is remote-safe and a write', () => {
    assert.ok(isRemoteSafe('manage_comic'));
    assert.equal(tool('manage_comic').annotations.readOnlyHint, false);
  });
});

describe('manage_comic set_lettering — only through the lettering route', () => {
  const routes = (over = {}) =>
    base({
      'GET /projects/p/nodes/pn1': panel('pn1', 1, { metadata: { tags: ['x'], ...lettered([{ id: 'old', kind: 'caption', text: 'Before.' }], 3) } }),
      'PUT /projects/p/nodes/pn1/panel/lettering': (body) =>
        panel('pn1', 1, { metadata: { panel: { lettering: body.items.map((i, n) => ({ id: i.id ?? `m${n}`, ...i })), letteringRevision: 4 } } }),
      ...over,
    });

  test('a speaker named resolves to the character id; sent with the revision read', async () => {
    const sent = stub(routes());
    const out = await run('manage_comic', {
      projectId: 'p', action: 'set_lettering', nodeId: 'pn1',
      items: [
        { kind: 'balloon', speaker: ' mira ', text: 'Run!', offPanel: true },
        { kind: 'thought', speakerId: 'e-tok', text: 'Too late.' },
        { kind: 'sfx', text: 'KRAK' },
      ],
    });
    const put = sent.find((r) => r.method === 'PUT');
    assert.equal(put.path, '/projects/p/nodes/pn1/panel/lettering');
    assert.equal(put.body.ifRevision, 3);
    assert.deepEqual(put.body.items, [
      { kind: 'balloon', speakerId: 'e-mira', text: 'Run!', offPanel: true },
      { kind: 'thought', speakerId: 'e-tok', text: 'Too late.' },
      { kind: 'sfx', text: 'KRAK' },
    ]);
    assert.ok(!sent.some((r) => r.method === 'PATCH'), 'lettering never goes through PATCH');
    assert.equal(out.updated.letteringRevision, 4);
    assert.equal(out.updated.lettering[0].speaker, 'Mira');
    assert.equal(out.previousLettering[0].text, 'Before.', 'the previous list comes back, so it can be restored');
  });

  test('an unknown name is refused, nothing is sent, and the cast is offered', async () => {
    const sent = stub(routes());
    await assert.rejects(
      run('manage_comic', { projectId: 'p', action: 'set_lettering', nodeId: 'pn1', items: [{ kind: 'balloon', speaker: 'Zed', text: 'Hi' }] }),
      (err) => err.code === Code.REQUEST_FAILED && /no character in this project is called "Zed"/.test(err.message) && err.detail.characters.length === 2
    );
    assert.ok(!sent.some((r) => r.method === 'PUT'));
  });

  test('an id outside the cast is refused', async () => {
    const sent = stub(routes());
    await assert.rejects(
      run('manage_comic', { projectId: 'p', action: 'set_lettering', nodeId: 'pn1', items: [{ kind: 'thought', speakerId: 'e-x', text: '' }] }),
      (err) => /not a character in this project's cast/.test(err.message)
    );
    assert.ok(!sent.some((r) => r.method === 'PUT'));
  });

  test('a stale ifRevision is refused before sending, with what is there now', async () => {
    const sent = stub(routes());
    await assert.rejects(
      run('manage_comic', { projectId: 'p', action: 'set_lettering', nodeId: 'pn1', items: [], ifRevision: 2 }),
      (err) => err.code === Code.STALE_CONTENT && err.detail.letteringRevision === 3 && err.detail.lettering[0].text === 'Before.'
    );
    assert.ok(!sent.some((r) => r.method === 'PUT'));
  });

  test('the API\'s own 409 (a write in between) reads as STALE_CONTENT', async () => {
    stub(routes({ 'PUT /projects/p/nodes/pn1/panel/lettering': { __status: 409, message: 'lettering changed' } }));
    await assert.rejects(
      run('manage_comic', { projectId: 'p', action: 'set_lettering', nodeId: 'pn1', items: [], ifRevision: 3 }),
      (err) => err.code === Code.STALE_CONTENT
    );
  });
});

describe('manage_comic add_panels', () => {
  test('plants panels on a page with description and framing, then their lettering through its route', async () => {
    const sent = stub(base({
      'GET /projects/p/nodes/pg': { id: 'pg', nodeType: 'page' },
      'POST /projects/p/nodes/batch': (body) => ({ nodes: body.nodes.map((n) => ({ ...n })) }),
      match: (method, path) =>
        method === 'PUT' && /\/panel\/lettering$/.test(path)
          ? (body) => ({ metadata: { panel: { lettering: body.items.map((i, n) => ({ id: `m${n}`, ...i })), letteringRevision: 1 } } })
          : undefined,
    }));
    const out = await run('manage_comic', {
      projectId: 'p', action: 'add_panels', nodeId: 'pg',
      panels: [
        { description: 'Mira at the stall.\nLanterns.', framing: 'Wide', lettering: [{ kind: 'balloon', speaker: 'Mira', text: 'Two, please.' }] },
        { description: 'Close on the coin.' },
      ],
    });
    const batch = sent.find((r) => r.method === 'POST');
    assert.equal(batch.body.nodes.length, 2);
    for (const n of batch.body.nodes) {
      assert.equal(n.nodeType, 'panel');
      assert.equal(n.parentId, 'pg');
      assert.equal(n.title, '');
      assert.equal(n.metadata?.panel, undefined, 'a create never names metadata.panel');
    }
    assert.equal(batch.body.nodes[0].metadata.frame.framing, 'Wide');
    assert.equal(batch.body.nodes[0].content.plainText, 'Mira at the stall.\nLanterns.');
    const puts = sent.filter((r) => r.method === 'PUT');
    assert.equal(puts.length, 1, 'only the panel with lettering gets a lettering write');
    assert.equal(puts[0].path, `/projects/p/nodes/${batch.body.nodes[0].id}/panel/lettering`);
    assert.deepEqual(puts[0].body, { items: [{ kind: 'balloon', speakerId: 'e-mira', text: 'Two, please.' }], ifRevision: 0 });
    assert.equal(out.created[0].lettering[0].speaker, 'Mira');
  });

  test('a bad speaker in the second panel plants nothing', async () => {
    const sent = stub(base({ 'GET /projects/p/nodes/pg': { id: 'pg', nodeType: 'page' } }));
    await assert.rejects(
      run('manage_comic', {
        projectId: 'p', action: 'add_panels', nodeId: 'pg',
        panels: [{ description: 'a' }, { description: 'b', lettering: [{ kind: 'balloon', speaker: 'Nobody', text: 'x' }] }],
      }),
      (err) => /panels\[1\]\.items\[0\]/.test(err.message)
    );
    assert.ok(!sent.some((r) => r.method === 'POST'));
  });

  test('panels go on a page, not a chapter', async () => {
    stub(base({ 'GET /projects/p/nodes/c': { id: 'c', nodeType: 'chapter' } }));
    await assert.rejects(
      run('manage_comic', { projectId: 'p', action: 'add_panels', nodeId: 'c', panels: [{ description: 'a' }] }),
      (err) => /Panels go on a page/.test(err.message)
    );
  });
});

describe('manage_comic set_boxes — only through panel-boxes, all or none', () => {
  test('sends every box in one PUT and returns the previous layout', async () => {
    const sent = stub(base({
      'GET /projects/p/nodes': { nodes: [panel('pn1', 1, { metadata: lettered([], 0) }), panel('pn2', 2)], hasMore: false },
      'PUT /projects/p/nodes/panel-boxes': (body) => ({ nodes: body.items.map((i) => ({ id: i.nodeId, nodeType: 'panel', metadata: { panel: { ...(i.box ? { box: i.box } : {}), z: i.z ?? 0 } } })) }),
    }));
    const out = await run('manage_comic', {
      projectId: 'p', action: 'set_boxes',
      boxes: [
        { nodeId: 'pn1', box: { x: 0, y: 0, w: 1, h: 0.5 }, z: 2 },
        { nodeId: 'pn2', box: null },
      ],
    });
    const puts = sent.filter((r) => r.method === 'PUT');
    assert.equal(puts.length, 1);
    assert.equal(puts[0].path, '/projects/p/nodes/panel-boxes');
    assert.deepEqual(puts[0].body.items, [
      { nodeId: 'pn1', box: { x: 0, y: 0, w: 1, h: 0.5 }, z: 2 },
      { nodeId: 'pn2', box: null },
    ]);
    assert.ok(!sent.some((r) => r.method === 'PATCH'));
    assert.deepEqual(out.updated[0].box, { x: 0, y: 0, w: 1, h: 0.5 });
    assert.deepEqual(out.previous.find((p) => p.nodeId === 'pn1').box, { x: 0.05, y: 0.04, w: 0.9, h: 0.3 });
  });

  test('a malformed box is refused before anything is sent', async () => {
    const sent = stub(base());
    await assert.rejects(
      run('manage_comic', { projectId: 'p', action: 'set_boxes', boxes: [{ nodeId: 'pn1', box: { x: 0, y: 0, w: 0, h: 1 } }] }),
      (err) => /w and h above 0/.test(err.message)
    );
    assert.ok(!sent.some((r) => r.method === 'PUT'));
  });
});

describe('manage_comic set_framing', () => {
  test('rebuilds the metadata from the row, without the API-owned panel key', async () => {
    const sent = stub(base({
      'GET /projects/p/nodes/pn1': panel('pn1', 1, { metadata: { tags: ['t'], frame: { framing: 'Wide' }, ...lettered([]) } }),
      'PATCH /projects/p/nodes/pn1': (body) => panel('pn1', 1, { metadata: body.metadata }),
    }));
    await run('manage_comic', { projectId: 'p', action: 'set_framing', nodeId: 'pn1', framing: 'Close-up' });
    const patch = sent.find((r) => r.method === 'PATCH');
    assert.deepEqual(patch.body.metadata, { tags: ['t'], frame: { framing: 'Close-up' } });
  });
});

describe('write_draft refuses a panel', () => {
  test('a panel holds a description and lettering, not paragraphs', async () => {
    stub(base({ 'GET /projects/p/nodes/pn1': panel('pn1', 1), 'GET /projects/p/nodes': { nodes: [], hasMore: false } }));
    await assert.rejects(
      run('write_draft', { projectId: 'p', nodeId: 'pn1', action: 'append', paragraphs: ['Prose.'] }),
      (err) => /comic panel/.test(err.message) && /manage_comic/.test(err.message)
    );
  });
});

describe('resolveLettering / normaliseBoxChange', () => {
  test('a caption or sfx with a speaker is refused', () => {
    assert.throws(() => resolveLettering([{ kind: 'caption', speaker: 'Mira', text: 'x' }], CAST), /caption has no speaker/);
    assert.throws(() => resolveLettering([{ kind: 'sfx', speakerId: 'e-mira', text: 'x' }], CAST), /no speaker/);
  });

  test('a name shared by two characters needs an id', () => {
    assert.throws(
      () => resolveLettering([{ kind: 'balloon', speaker: 'Mira', text: 'x' }], [...CAST, { id: 'e-m2', name: 'mira' }]),
      /names 2 characters/
    );
  });

  test('a balloon without a speaker is refused; ids are kept', () => {
    assert.throws(() => resolveLettering([{ kind: 'balloon', text: 'x' }], CAST), /always someone's/);
    assert.deepEqual(resolveLettering([{ id: 'keep', kind: 'caption', text: ' x ' }], CAST), [{ id: 'keep', kind: 'caption', text: 'x' }]);
  });

  test('over the limits', () => {
    assert.throws(() => resolveLettering(Array.from({ length: 41 }, () => ({ kind: 'sfx', text: 'x' })), CAST), /at most 40/);
    assert.throws(() => resolveLettering([{ kind: 'sfx', text: 'x'.repeat(201) }], CAST), /at most 200/);
  });

  test('a box change needs something to change', () => {
    assert.throws(() => normaliseBoxChange({ nodeId: 'a' }, 0), /send a box/);
    assert.throws(() => normaliseBoxChange({ nodeId: 'a', z: 1.5 }, 0), /whole number/);
    assert.deepEqual(normaliseBoxChange({ nodeId: 'a', z: -1 }, 0), { nodeId: 'a', z: -1 });
  });
});
