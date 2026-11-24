/**
 * Storyboard frames (ezquill epic #56, task #705): read under their scene,
 * never counted as words or as scenes to write, and written through
 * manage_storyboard with the same guards every other write has.
 */
import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS } from '../src/tools/index.js';
import { withRequest } from '../src/lib/request-context.js';
import { Code } from '../src/lib/errors.js';
import { resetWritingTypes } from '../src/lib/writing-types.js';
import { buildTree } from '../src/lib/nodes.js';
import { withFrameFields } from '../src/lib/frames.js';
import { isRemoteSafe } from '../src/lib/remote-tools.js';

const tool = (name) => TOOLS.find((t) => t.name === name);
const run = (name, args) => withRequest({ token: 't' }, () => tool(name).handler(args));

const level = (key, children = [], extra = {}) => ({ key, label: key, children, carriesProse: true, ...extra });
const storyLevels = (storyboard) => [
  level('part', ['chapter']),
  // As served since ezquill #749: a frame sits under every prose level.
  level('chapter', storyboard ? ['scene', 'frame'] : ['scene']),
  level('scene', storyboard ? ['frame'] : []),
  ...(storyboard ? [level('frame', [], { numbered: true, numberLabel: 'Frame' })] : []),
];

/** The contract GET /writing-types serves, storyboard variants included. */
const REGISTRY = {
  writingTypes: [
    {
      key: 'story',
      levels: storyLevels(false),
      plantedLevels: ['part', 'chapter'],
      variants: [
        { shape: 'novel', production: false, storyboard: false, levels: storyLevels(false), plantedLevels: ['part', 'chapter'] },
        { shape: 'novel', production: false, storyboard: true, levels: storyLevels(true), plantedLevels: ['part', 'chapter'] },
      ],
    },
  ],
  universalLevels: [],
};

const STORY = { id: 'p', title: 'Harbour', writingType: 'story', shape: 'novel', production: false, storyboard: true };

/**
 * Records every request; routes are matched on METHOD and EXACT path after
 * /api/v1, so `/projects/p/nodes/s` and `/projects/p/nodes` never collide.
 */
function stub(routes) {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const path = u.pathname.replace(/^\/api\/v1/, '');
    sent.push({ path, query: u.searchParams, method, body });
    const respond = routes[`${method} ${path}`];
    if (respond === undefined) {
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({ error: { message: `no route ${method} ${path}` } }) };
    }
    const value = typeof respond === 'function' ? respond(body, u) : respond;
    return { ok: true, status: 200, json: async () => value };
  };
  return sent;
}

const realFetch = globalThis.fetch;
beforeEach(() => resetWritingTypes());
afterEach(() => { globalThis.fetch = realFetch; });

const frame = (id, order, over = {}) => ({ id, nodeType: 'frame', parentId: 's', order, hasProse: true, title: '', ...over });

describe('get_outline — frames sit under their scene and are not counted', () => {
  test('a frame is kind "frame" with framing and line, and adds no words', () => {
    const tree = buildTree([
      { id: 'c', nodeType: 'chapter', order: 1 },
      { id: 's', nodeType: 'scene', parentId: 'c', order: 1 },
      { id: 'b1', nodeType: 'block', parentId: 's', order: 1, hasProse: true, wordCount: 12 },
      frame('f1', 2, {
        wordCount: 40,
        ordinal: { display: 'Frame 1', number: 1, label: 'Frame', scope: 'parent' },
        metadata: { frame: { framing: 'Wide', line: { kind: 'caption', text: 'Dawn.' } } },
      }),
    ]);
    const scene = tree[0].children[0];
    assert.equal(scene.kind, 'scene');
    assert.equal(scene.wordCount, 12, 'the frame description must not count as manuscript');
    assert.equal(tree[0].wordCount, 12);
    const [f] = scene.children;
    assert.equal(f.kind, 'frame');
    assert.equal(f.ordinal.display, 'Frame 1');
    assert.equal(f.framing, 'Wide');
    assert.deepEqual(f.line, { kind: 'caption', text: 'Dawn.' });
    assert.equal(f.wordCount, undefined);
  });

  test('a scene holding only frames is unwritten, not a folder', () => {
    const tree = buildTree([{ id: 's', nodeType: 'scene', order: 1 }, frame('f1', 1, { wordCount: 9 })]);
    assert.equal(tree[0].kind, 'unwritten');
    assert.equal(tree[0].wordCount, 0);
  });
});

describe('read_scene — frames are listed apart from the prose', () => {
  test('the prose is the blocks alone, and each frame has its description', async () => {
    stub({
      'GET /projects/p/nodes/s': { id: 's', nodeType: 'scene', title: 'Arrival' },
      'GET /projects/p/nodes': {
        nodes: [
          { id: 'b1', nodeType: 'block', parentId: 's', order: 1, hasProse: true, wordCount: 2, content: { plainText: 'She arrived.' } },
          frame('f2', 3, { content: { plainText: 'Close on the ticket.' } }),
          frame('f1', 2, { content: { plainText: 'The quay at dawn.' }, metadata: { frame: { framing: 'Wide' } } }),
        ],
        hasMore: false,
      },
      'GET /projects/p/nodes/s/entities': { cast: [] },
    });

    const out = await run('read_scene', { projectId: 'p', nodeId: 's' });
    assert.equal(out.prose, 'She arrived.');
    assert.equal(out.wordCount, 2);
    assert.deepEqual(out.children, [], 'frames are not child sections');
    assert.deepEqual(out.frames.map((f) => f.id), ['f1', 'f2'], 'in board order');
    assert.equal(out.frames[0].description, 'The quay at dawn.');
    assert.equal(out.frames[0].framing, 'Wide');
  });

  test('read on a frame returns that frame', async () => {
    stub({
      'GET /projects/p/nodes/f1': frame('f1', 1, { contentVersion: 3, content: { plainText: 'The quay.' } }),
      'GET /projects/p/nodes': { nodes: [], hasMore: false },
      'GET /projects/p/nodes/f1/entities': { cast: [] },
    });
    const out = await run('read_scene', { projectId: 'p', nodeId: 'f1' });
    assert.equal(out.kind, 'frame');
    assert.equal(out.description, 'The quay.');
    assert.equal(out.prose, undefined);
  });
});

describe('manage_storyboard add_frames', () => {
  test('plants frames under the scene with description, framing and line, in one batch', async () => {
    const sent = stub({
      'GET /projects/p': STORY,
      'GET /writing-types': REGISTRY,
      'GET /projects/p/nodes/s': { id: 's', nodeType: 'scene' },
      'GET /projects/p/nodes': { nodes: [{ id: 'b1', nodeType: 'block', parentId: 's', order: 1 }], hasMore: false },
      'POST /projects/p/nodes/batch': (body) => ({ nodes: body.nodes }),
    });

    const out = await run('manage_storyboard', {
      projectId: 'p',
      action: 'add_frames',
      nodeId: 's',
      frames: [
        { description: 'The quay at dawn.\nGulls.', framing: 'Wide', line: { kind: 'caption', text: 'Monday.' } },
        { description: 'Close on the ticket.', line: { text: 'Wrong date.' } },
      ],
    });

    const post = sent.find((r) => r.method === 'POST');
    assert.equal(post.body.nodes.length, 2);
    for (const n of post.body.nodes) {
      assert.equal(n.nodeType, 'frame');
      assert.equal(n.parentId, 's');
      assert.equal(n.title, '', 'a frame is called by its number');
      assert.ok(!('order' in n), 'absent order appends');
      assert.equal(n.content.document.type, 'doc');
    }
    assert.equal(post.body.nodes[0].content.plainText, 'The quay at dawn.\nGulls.');
    assert.equal(post.body.nodes[0].content.document.content.length, 2, 'one paragraph per line');
    assert.deepEqual(post.body.nodes[0].metadata, { frame: { framing: 'Wide', line: { kind: 'caption', text: 'Monday.' } } });
    assert.deepEqual(post.body.nodes[1].metadata.frame.line, { kind: 'dialogue', text: 'Wrong date.' });
    assert.equal(out.created.length, 2);
  });

  test('afterFrameId places the new frames between it and the next', async () => {
    const sent = stub({
      'GET /projects/p': STORY,
      'GET /writing-types': REGISTRY,
      'GET /projects/p/nodes/s': { id: 's', nodeType: 'scene' },
      'GET /projects/p/nodes': { nodes: [frame('f1', 1), frame('f2', 2)], hasMore: false },
      'POST /projects/p/nodes/batch': (body) => ({ nodes: body.nodes }),
    });
    await run('manage_storyboard', {
      projectId: 'p', action: 'add_frames', nodeId: 's', afterFrameId: 'f1',
      frames: [{ description: 'a' }, { description: 'b' }],
    });
    const orders = sent.find((r) => r.method === 'POST').body.nodes.map((n) => n.order);
    assert.ok(orders[0] > 1 && orders[0] < orders[1] && orders[1] < 2, `got ${orders}`);
  });

  test('refused, with nothing sent, when the storyboard is off', async () => {
    const sent = stub({ 'GET /projects/p': { ...STORY, storyboard: false } });
    await assert.rejects(
      () => run('manage_storyboard', { projectId: 'p', action: 'add_frames', nodeId: 's', frames: [{ description: 'x' }] }),
      (err) => err.code === Code.STORYBOARD_OFF && /settings/.test(err.message)
    );
    assert.ok(sent.every((r) => r.method === 'GET'));
  });

  test('a script is pointed at its shots', async () => {
    const sent = stub({ 'GET /projects/p': { ...STORY, writingType: 'script', storyboard: true } });
    await assert.rejects(
      () => run('manage_storyboard', { projectId: 'p', action: 'add_frames', nodeId: 's', frames: [{ description: 'x' }] }),
      (err) => /shots/.test(err.message) && /set_shot/.test(err.message)
    );
    assert.ok(sent.every((r) => r.method === 'GET'));
  });

  test('frames go under a prose level, not a part', async () => {
    const sent = stub({
      'GET /projects/p': STORY,
      'GET /writing-types': REGISTRY,
      'GET /projects/p/nodes/pt': { id: 'pt', nodeType: 'part' },
    });
    await assert.rejects(
      () => run('manage_storyboard', { projectId: 'p', action: 'add_frames', nodeId: 'pt', frames: [{ description: 'x' }] }),
      (err) => /under a chapter or scene/.test(err.message) && /lowest level that carries prose/.test(err.message)
    );
    assert.ok(sent.every((r) => r.method === 'GET'));
  });

  test('a chapter that has scenes is refused, naming its scenes, with nothing sent', async () => {
    const sent = stub({
      'GET /projects/p': STORY,
      'GET /writing-types': REGISTRY,
      'GET /projects/p/nodes/c': { id: 'c', nodeType: 'chapter', title: 'The Crossing' },
      'GET /projects/p/nodes': (_body, u) => {
        assert.equal(u.searchParams.get('parentId'), 'c');
        return {
          nodes: [
            { id: 's2', nodeType: 'scene', parentId: 'c', order: 2, title: '', ordinal: { display: 'Scene 2' } },
            { id: 'b1', nodeType: 'block', parentId: 'c', order: 0 },
            { id: 's1', nodeType: 'scene', parentId: 'c', order: 1, title: 'The quay' },
            frame('f-old', 3, { parentId: 'c' }),
          ],
          hasMore: false,
        };
      },
    });
    await assert.rejects(
      () => run('manage_storyboard', { projectId: 'p', action: 'add_frames', nodeId: 'c', frames: [{ description: 'x' }] }),
      (err) => {
        assert.equal(err.code, Code.REQUEST_FAILED);
        assert.match(err.message, /The chapter "The Crossing" has 2 scenes beneath it/);
        assert.match(err.message, /a scene, or a chapter written with no scenes/);
        // In manuscript order, each with the id to pass back.
        assert.match(err.message, /scene "The quay" \(nodeId s1\); Scene 2 \(nodeId s2\)/);
        assert.deepEqual(err.detail.sections.map((n) => n.id), ['s1', 's2']);
        return true;
      }
    );
    assert.ok(sent.every((r) => r.method === 'GET'), 'nothing is written');
  });

  test('a chapter written with no scenes takes frames itself', async () => {
    const sent = stub({
      'GET /projects/p': STORY,
      'GET /writing-types': REGISTRY,
      'GET /projects/p/nodes/c': { id: 'c', nodeType: 'chapter' },
      // Its paragraphs and an existing frame are not sections.
      'GET /projects/p/nodes': {
        nodes: [{ id: 'b1', nodeType: 'block', parentId: 'c', order: 1 }, frame('f1', 2, { parentId: 'c' })],
        hasMore: false,
      },
      'POST /projects/p/nodes/batch': (body) => ({ nodes: body.nodes }),
    });
    const out = await run('manage_storyboard', {
      projectId: 'p', action: 'add_frames', nodeId: 'c', afterFrameId: 'f1', frames: [{ description: 'The deck.' }],
    });
    const post = sent.find((r) => r.method === 'POST');
    assert.equal(post.body.nodes[0].parentId, 'c');
    assert.equal(post.body.nodes[0].order, 3, 'after the last frame');
    assert.equal(out.created.length, 1);
  });

  test('the description says where frames go', () => {
    assert.match(tool('manage_storyboard').description, /lowest level that carries prose: a scene, or a chapter written with no scenes/);
  });

  test('an API with no frame level in the served registry is refused', async () => {
    stub({
      'GET /projects/p': STORY,
      // A registry from before the storyboard: no storyboard variants at all.
      'GET /writing-types': { writingTypes: [{ ...REGISTRY.writingTypes[0], variants: [REGISTRY.writingTypes[0].variants[0]] }] },
    });
    await assert.rejects(
      () => run('manage_storyboard', { projectId: 'p', action: 'add_frames', nodeId: 's', frames: [{ description: 'x' }] }),
      (err) => err.code === Code.STORYBOARD_OFF
    );
  });
});

describe('manage_outline add reads the storyboard variant of the served registry', () => {
  test('a frame is a known level with the storyboard on, planted with a document', async () => {
    const sent = stub({
      'GET /projects/p': STORY,
      'GET /writing-types': REGISTRY,
      'POST /projects/p/nodes/batch': (body) => ({ nodes: body.nodes }),
    });
    await run('manage_outline', { projectId: 'p', action: 'add', nodes: [{ title: '', nodeType: 'frame', parentId: 's' }] });
    const node = sent.find((r) => r.method === 'POST').body.nodes[0];
    assert.equal(node.nodeType, 'frame');
    assert.equal(node.content.document.type, 'doc');
  });

  test('and unknown with it off', async () => {
    stub({ 'GET /projects/p': { ...STORY, storyboard: false }, 'GET /writing-types': REGISTRY });
    await assert.rejects(
      () => run('manage_outline', { projectId: 'p', action: 'add', nodes: [{ title: '', nodeType: 'frame', parentId: 's' }] }),
      (err) => err.code === Code.UNKNOWN_NODE_TYPE
    );
  });
});

describe('manage_storyboard set_description', () => {
  test('an empty frame is written directly, guarded by its content version', async () => {
    const sent = stub({
      'GET /projects/p': STORY,
      'GET /writing-types': REGISTRY,
      'GET /projects/p/nodes/f1': frame('f1', 1, { contentVersion: 4, content: { plainText: '' } }),
      'PUT /projects/p/nodes/f1/content': (body) => ({ ...frame('f1', 1), content: body }),
    });
    const out = await run('manage_storyboard', { projectId: 'p', action: 'set_description', nodeId: 'f1', description: 'The quay.' });
    const put = sent.find((r) => r.method === 'PUT');
    assert.equal(put.body.ifContentVersion, 4);
    assert.equal(put.body.plainText, 'The quay.');
    assert.ok(!sent.some((r) => r.path.endsWith('/versions')), 'nothing to keep');
    assert.equal(out.updated.description, 'The quay.');
  });

  test('replacing a description keeps the old one as a version FIRST', async () => {
    const sent = stub({
      'GET /projects/p': STORY,
      'GET /writing-types': REGISTRY,
      'GET /projects/p/nodes/f1': frame('f1', 1, { contentVersion: 7, content: { plainText: 'Old words.' } }),
      'POST /projects/p/nodes/f1/versions': { id: 'v9' },
      'PUT /projects/p/nodes/f1/content': (body) => ({ ...frame('f1', 1), content: body }),
    });
    const out = await run('manage_storyboard', { projectId: 'p', action: 'set_description', nodeId: 'f1', description: 'New words.' });
    const writes = sent.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`);
    assert.deepEqual(writes, ['POST /projects/p/nodes/f1/versions', 'PUT /projects/p/nodes/f1/content']);
    assert.ok(!('content' in sent.find((r) => r.method === 'POST').body), 'the API snapshots what is stored');
    assert.equal(sent.find((r) => r.method === 'PUT').body.ifContentVersion, 7);
    assert.equal(out.previousDescription, 'Old words.');
    assert.equal(out.keptAsVersion, 'v9');
  });

  test('a scene is not a frame', async () => {
    const sent = stub({
      'GET /projects/p': STORY,
      'GET /writing-types': REGISTRY,
      'GET /projects/p/nodes/s': { id: 's', nodeType: 'scene' },
    });
    await assert.rejects(
      () => run('manage_storyboard', { projectId: 'p', action: 'set_description', nodeId: 's', description: 'x' }),
      (err) => /not a storyboard frame/.test(err.message)
    );
    assert.ok(sent.every((r) => r.method === 'GET'));
  });
});

describe('manage_storyboard set_frame', () => {
  test('rebuilds the WHOLE metadata, since PATCH assigns it', async () => {
    const sent = stub({
      'GET /projects/p': STORY,
      'GET /writing-types': REGISTRY,
      'GET /projects/p/nodes/f1': frame('f1', 1, {
        metadata: { tags: ['x'], numbering: { pin: '0' }, frame: { framing: 'Wide', line: { kind: 'dialogue', text: 'Hi.' } } },
      }),
      'PATCH /projects/p/nodes/f1': (body) => ({ ...frame('f1', 1), metadata: body.metadata }),
    });
    const out = await run('manage_storyboard', { projectId: 'p', action: 'set_frame', nodeId: 'f1', framing: 'Close-up', line: null });
    const patch = sent.find((r) => r.method === 'PATCH').body;
    assert.deepEqual(patch.metadata, { tags: ['x'], numbering: { pin: '0' }, frame: { framing: 'Close-up' } });
    assert.equal(out.updated.framing, 'Close-up');
    assert.equal(out.updated.line, undefined);
  });

  test('a bad line kind is refused before anything is written', async () => {
    const sent = stub({
      'GET /projects/p': STORY,
      'GET /writing-types': REGISTRY,
    });
    await assert.rejects(
      () => run('manage_storyboard', { projectId: 'p', action: 'set_frame', nodeId: 'f1', line: { kind: 'thought', text: 'x' } }),
      (err) => /dialogue" or "caption/.test(err.message)
    );
    assert.ok(sent.every((r) => r.method === 'GET'));
  });

  test('withFrameFields leaves fields it was not given alone', () => {
    const next = withFrameFields({ frame: { framing: 'Wide', extra: 1 } }, { line: { kind: 'caption', text: 'c' } });
    assert.deepEqual(next, { frame: { framing: 'Wide', extra: 1, line: { kind: 'caption', text: 'c' } } });
  });
});

describe('prose never goes in a frame', () => {
  test('write_draft append on a frame is refused with the storyboard tool named', async () => {
    const sent = stub({
      'GET /projects/p/nodes': { nodes: [], hasMore: false },
      'GET /projects/p/nodes/f1': frame('f1', 1, { content: { document: { type: 'doc', content: [] }, plainText: '' } }),
    });
    await assert.rejects(
      () => run('write_draft', { projectId: 'p', nodeId: 'f1', action: 'append', paragraphs: ['Words.'] }),
      (err) => /manage_storyboard set_description/.test(err.message)
    );
    assert.ok(!sent.some((r) => r.method === 'PUT'));
  });
});

test('manage_storyboard is served remotely', () => {
  assert.ok(isRemoteSafe('manage_storyboard'));
});
