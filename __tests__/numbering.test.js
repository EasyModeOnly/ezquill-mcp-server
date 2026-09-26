import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS } from '../src/tools/index.js';
import { withRequest } from '../src/lib/request-context.js';
import { resetWritingTypes } from '../src/lib/writing-types.js';
import { buildTree, ordinalOf } from '../src/lib/nodes.js';

// Structural numbering (ezquill epic #37): the API derives "Ep. 3" from
// position; the connector reports it, accepts overrides, and never counts.

const tool = (name) => TOOLS.find((t) => t.name === name);
const run = (name, args) => withRequest({ token: 't' }, () => tool(name).handler(args));

function stub(routes) {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    sent.push({ path: u.pathname, method: init?.method ?? 'GET', body });
    for (const [pattern, respond] of Object.entries(routes)) {
      const [method, suffix] = pattern.includes(' ') ? pattern.split(' ') : ['*', pattern];
      if ((method === '*' || method === (init?.method ?? 'GET')) && u.pathname.endsWith(suffix)) {
        const value = typeof respond === 'function' ? respond(body, u) : respond;
        return { ok: true, status: 200, json: async () => value };
      }
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return sent;
}
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetWritingTypes();
});

const ep3 = { value: 3, number: '3', label: 'Ep.', display: 'Ep. 3', scope: 'parent' };

describe('ordinals are reported, never computed', () => {
  test('ordinalOf passes the API number through, compactly', () => {
    assert.deepEqual(ordinalOf({ ordinal: ep3 }), { display: 'Ep. 3', number: '3', label: 'Ep.', scope: 'parent' });
    assert.deepEqual(ordinalOf({ ordinal: { ...ep3, display: 'S04', number: 'S04', pinned: true } }).pinned, true);
    assert.equal(ordinalOf({}), undefined);
  });

  test('get_outline carries each node\'s ordinal, and invents none', () => {
    const [ep] = buildTree([
      { id: 'e', nodeType: 'episode', title: '', order: 0, ordinal: ep3 },
      { id: 's', parentId: 'e', nodeType: 'shot', title: 'The Grind', order: 0 },
    ]);
    assert.equal(ep.ordinal.display, 'Ep. 3');
    assert.equal(ep.children[0].ordinal, undefined, 'no number from the API means none reported');
  });

  test('read_scene reports the node\'s and its children\'s ordinals', async () => {
    stub({
      'GET /nodes/e': { id: 'e', nodeType: 'episode', title: '', ordinal: ep3 },
      '/nodes': { nodes: [{ id: 's', parentId: 'e', nodeType: 'shot', title: '', order: 0, ordinal: { ...ep3, label: 'Shot', display: 'Shot 1', number: '1' } }], hasMore: false },
      '/entities': { cast: [] },
    });
    const scene = await run('read_scene', { projectId: 'p', nodeId: 'e' });
    assert.equal(scene.ordinal.display, 'Ep. 3');
    assert.equal(scene.children[0].ordinal.display, 'Shot 1');
  });
});

describe('manage_outline set_numbering', () => {
  const node = { id: 'n1', title: '', metadata: { shot: { framing: 'wide' }, tags: ['keep'] } };

  test('split rebuilds the WHOLE metadata blob', async () => {
    const sent = stub({
      'GET /nodes/n1': node,
      'PATCH /nodes/n1': (body) => ({ ...node, ...body, ordinal: { ...ep3, display: 'Shot 2B', split: true } }),
    });
    const result = await run('manage_outline', { projectId: 'p', action: 'set_numbering', nodeId: 'n1', splitFromPrevious: true });
    const patch = sent.find((r) => r.method === 'PATCH');
    assert.deepEqual(patch.body.metadata, { shot: { framing: 'wide' }, tags: ['keep'], numbering: { splitOf: 'previous' } });
    assert.equal(result.updated.ordinal.display, 'Shot 2B');
    assert.match(result.note, /get_outline/);
  });

  test('pin is trimmed; clear drops the key', async () => {
    let sent = stub({ 'GET /nodes/n1': node, 'PATCH /nodes/n1': (b) => b });
    await run('manage_outline', { projectId: 'p', action: 'set_numbering', nodeId: 'n1', pin: ' S04 ' });
    assert.deepEqual(sent.find((r) => r.method === 'PATCH').body.metadata.numbering, { pin: 'S04' });

    sent = stub({ 'GET /nodes/n1': { ...node, metadata: { ...node.metadata, numbering: { pin: 'S04' } } }, 'PATCH /nodes/n1': (b) => b });
    await run('manage_outline', { projectId: 'p', action: 'set_numbering', nodeId: 'n1', clear: true });
    const md = sent.find((r) => r.method === 'PATCH').body.metadata;
    assert.ok(!('numbering' in md));
    assert.deepEqual(md.shot, { framing: 'wide' });
  });

  test('exactly one override, or nothing is sent', async () => {
    const sent = stub({});
    for (const args of [{}, { pin: 'S04', exclude: true }, { pin: '  ' }]) {
      await assert.rejects(
        () => run('manage_outline', { projectId: 'p', action: 'set_numbering', nodeId: 'n1', ...args }),
        /exactly one/
      );
    }
    assert.equal(sent.length, 0);
  });
});

describe('manage_outline add accepts a group', () => {
  test('group is addable in any writing type, from the served registry', async () => {
    const sent = stub({
      'GET /projects/p': { id: 'p', writingType: 'shortform-video' },
      '/writing-types': {
        writingTypes: [{ key: 'shortform-video', levels: [{ key: 'episode' }, { key: 'shot' }] }],
        universalLevels: [{ key: 'group', numbered: false }],
      },
      'POST /batch': (body) => ({ nodes: body.nodes }),
    });
    const result = await run('manage_outline', {
      projectId: 'p', action: 'add', nodes: [{ title: 'Specials', nodeType: 'group' }, { title: '', nodeType: 'episode' }],
    });
    assert.equal(result.created.length, 2);
    const batch = sent.find((r) => r.method === 'POST');
    assert.equal(batch.body.nodes[1].title, '', 'an untitled episode is sent as such, for its number to name');
  });
});
