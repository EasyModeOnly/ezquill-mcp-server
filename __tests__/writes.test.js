import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS } from '../src/tools/index.js';
import { withRequest } from '../src/lib/request-context.js';

const tool = (name) => TOOLS.find((t) => t.name === name);
const run = (name, args) => withRequest({ token: 't' }, () => tool(name).handler(args));

/** Records every request so a test can assert what was SENT, not just returned. */
function stub(routes) {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    sent.push({ path: u.pathname, query: u.searchParams, method: init?.method ?? 'GET', body });

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
afterEach(() => { globalThis.fetch = realFetch; });

const block = (id, over = {}) => ({ id, nodeType: 'block', order: 0, hasProse: false, ...over });
const written = (id, text, order, version) =>
  block(id, { order, hasProse: true, contentVersion: version, content: { plainText: text } });

describe('write_draft append — the reconcile is composed, never exposed', () => {
  test('every existing block is sent back, so none is deleted', async () => {
    // PUT /blocks REMOVES anything absent from the list. An agent sending only
    // its new paragraph would soft-delete the entire scene.
    const sent = stub({
      '/nodes': { nodes: [written('b1', 'One.', 1, 4), written('b2', 'Two.', 2, 7)], hasMore: false },
      'PUT /blocks': (body) => ({ blocks: body.blocks, refused: [], removed: [] }),
    });

    await run('write_draft', { projectId: 'p', nodeId: 's', action: 'append', paragraphs: ['Three.'] });

    const put = sent.find((r) => r.method === 'PUT');
    assert.equal(put.body.blocks.length, 3, 'the two existing blocks must be resent');
    assert.deepEqual(put.body.blocks.slice(0, 2).map((b) => b.id), ['b1', 'b2']);
  });

  test('unchanged blocks are sent WITHOUT content', async () => {
    // Content omitted means "unchanged". Resending it would make the request
    // scale with the section rather than the edit, and re-save words nobody
    // touched — bumping their content versions under a collaborator.
    const sent = stub({
      '/nodes': { nodes: [written('b1', 'One.', 1, 4)], hasMore: false },
      'PUT /blocks': (body) => ({ blocks: body.blocks, refused: [], removed: [] }),
    });

    await run('write_draft', { projectId: 'p', nodeId: 's', action: 'append', paragraphs: ['Two.'] });

    const put = sent.find((r) => r.method === 'PUT');
    assert.ok(!('content' in put.body.blocks[0]), 'an untouched block must carry no content');
    assert.ok(put.body.blocks[1].content, 'the new paragraph must carry content');
  });

  test('a new paragraph is a Tiptap document object, never a string', async () => {
    const sent = stub({
      '/nodes': { nodes: [], hasMore: false },
      '/nodes/s': { id: 's', hasProse: false },
      'PUT /blocks': (body) => ({ blocks: body.blocks, refused: [], removed: [] }),
    });

    await run('write_draft', { projectId: 'p', nodeId: 's', action: 'append', paragraphs: ['Hello.'] });

    const doc = sent.find((r) => r.method === 'PUT').body.blocks[0].content;
    assert.equal(doc.document.type, 'doc');
    assert.equal(doc.document.content[0].type, 'paragraph');
    assert.equal(doc.plainText, 'Hello.');
  });

  test('refusals are reported, not swallowed', async () => {
    // A reconcile can partly succeed. Claiming a clean result would tell the
    // writer words landed that did not.
    stub({
      '/nodes': { nodes: [written('b1', 'One.', 1, 4)], hasMore: false },
      'PUT /blocks': { blocks: [], refused: [{ id: 'b1', currentVersion: 9, draftKept: true }], removed: [] },
    });

    const result = await run('write_draft', {
      projectId: 'p', nodeId: 's', action: 'append', paragraphs: ['Two.'],
    });
    assert.equal(result.refused.length, 1);
    assert.match(result.warning, /somebody else changed them/i);
  });

  test('a scene whose prose is not yet in blocks is REFUSED, not restructured', async () => {
    // Appending would need adoptSectionProse, which nulls the section's own
    // document — a migration, not an append. Splitting existing prose is the
    // editor's job and getting it wrong reshapes a manuscript silently.
    stub({
      '/nodes': { nodes: [], hasMore: false },
      '/nodes/s': {
        id: 's',
        hasProse: true,
        content: {
          document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'All of it in one lump.' }] }] },
          plainText: 'All of it in one lump.',
        },
      },
    });

    await assert.rejects(
      () => run('write_draft', { projectId: 'p', nodeId: 's', action: 'append', paragraphs: ['More.'] }),
      (err) => /not split into paragraphs/i.test(err.message)
    );
  });

  test('a freshly planted chapter — an EMPTY document — is adopted and written', async () => {
    // The wizard, the kickoff and create_project all plant prose levels with an
    // empty document. Refusing those left every new chapter unwritable from the
    // connector; found by creating a project and writing in it.
    const sent = stub({
      '/nodes': { nodes: [], hasMore: false },
      '/nodes/s': { id: 's', hasProse: true, content: { document: { type: 'doc', content: [] }, plainText: '' } },
      'PUT /blocks': (body) => ({ blocks: body.blocks, refused: [], removed: [] }),
    });

    await run('write_draft', { projectId: 'p', nodeId: 's', action: 'append', paragraphs: ['First.'] });

    const put = sent.find((r) => r.method === 'PUT');
    assert.equal(put.body.adoptSectionProse, true);
    assert.equal(put.body.blocks.length, 1);
  });

  test('a document holding only an image has no text and is still REFUSED', async () => {
    // Adopting nulls the document; "no plain text" would delete the image.
    const sent = stub({
      '/nodes': { nodes: [], hasMore: false },
      '/nodes/s': {
        id: 's',
        hasProse: true,
        content: { document: { type: 'doc', content: [{ type: 'image', attrs: { src: 'x' } }] }, plainText: '' },
      },
    });

    await assert.rejects(
      () => run('write_draft', { projectId: 'p', nodeId: 's', action: 'append', paragraphs: ['More.'] }),
      (err) => /not split into paragraphs/i.test(err.message)
    );
    assert.equal(sent.some((r) => r.method === 'PUT'), false);
  });

  test('a scene that already has blocks never asks to adopt', async () => {
    const sent = stub({
      '/nodes': { nodes: [written('b1', 'One.', 1, 4)], hasMore: false },
      'PUT /blocks': (body) => ({ blocks: body.blocks, refused: [], removed: [] }),
    });

    await run('write_draft', { projectId: 'p', nodeId: 's', action: 'append', paragraphs: ['Two.'] });

    assert.equal(sent.find((r) => r.method === 'PUT').body.adoptSectionProse, undefined);
  });
});

describe('write_draft fill_plan', () => {
  test('writes into a planned block and guards it with its own version', async () => {
    const sent = stub({
      '/nodes': { nodes: [block('b1', { order: 1, contentVersion: 3 }), written('b2', 'Two.', 2, 5)], hasMore: false },
      'PUT /blocks': (body) => ({ blocks: body.blocks, refused: [], removed: [] }),
    });

    await run('write_draft', {
      projectId: 'p', nodeId: 's', action: 'fill_plan', blockId: 'b1', text: 'Written at last.',
    });

    const blocks = sent.find((r) => r.method === 'PUT').body.blocks;
    const target = blocks.find((b) => b.id === 'b1');
    assert.equal(target.ifContentVersion, 3, 'the target must be guarded');
    assert.equal(target.content.plainText, 'Written at last.');
    assert.ok(!('content' in blocks.find((b) => b.id === 'b2')), 'the other block is untouched');
  });

  test('refuses a block that is already written', async () => {
    // The line between additive and overwriting, enforced rather than trusted.
    stub({ '/nodes': { nodes: [written('b1', 'Already here.', 1, 2)], hasMore: false } });

    await assert.rejects(
      () => run('write_draft', { projectId: 'p', nodeId: 's', action: 'fill_plan', blockId: 'b1', text: 'x' }),
      (err) => /already written/i.test(err.message) && /revise/.test(err.message)
    );
  });
});

describe('write_draft revise — proposes, never writes', () => {
  const scene = {
    '/nodes/s': { id: 's', hasProse: false },
    '/nodes': { nodes: [written('b1', 'The tide went out.', 1, 1)], hasMore: false },
  };

  test('creates a suggestion and says it was not applied', async () => {
    const sent = stub({ ...scene, 'POST /comments': { id: 'c1' } });

    const result = await run('write_draft', {
      projectId: 'p', nodeId: 's', action: 'revise',
      quote: 'The tide went out.', replacement: 'The tide fled.',
    });

    const post = sent.find((r) => r.method === 'POST');
    assert.equal(post.body.replacement, 'The tide fled.');
    assert.equal(post.body.anchor.text, 'The tide went out.');
    assert.match(result.status, /not applied/i);

    // No write to the manuscript itself.
    assert.ok(!sent.some((r) => r.method === 'PUT'), 'revise must not write prose');
  });

  test('an EMPTY replacement is a valid proposal to cut the passage', async () => {
    // It is also falsy, which is exactly how this gets silently dropped.
    const sent = stub({ ...scene, 'POST /comments': { id: 'c2' } });

    await run('write_draft', {
      projectId: 'p', nodeId: 's', action: 'revise', quote: 'The tide went out.', replacement: '',
    });
    assert.equal(sent.find((r) => r.method === 'POST').body.replacement, '');
  });

  test('a missing replacement is refused, and an empty one is not', async () => {
    stub(scene);
    await assert.rejects(
      () => run('write_draft', { projectId: 'p', nodeId: 's', action: 'revise', quote: 'The tide went out.' }),
      (err) => /empty string to propose cutting/i.test(err.message)
    );
  });

  test('an ambiguous quote is refused rather than guessed', async () => {
    stub({
      '/nodes/s': { id: 's', hasProse: false },
      '/nodes': { nodes: [written('b1', 'She waited.', 1, 1), written('b2', 'She waited.', 2, 1)], hasMore: false },
    });

    await assert.rejects(
      () => run('write_draft', {
        projectId: 'p', nodeId: 's', action: 'revise', quote: 'She waited.', replacement: 'She stayed.',
      }),
      (err) => /more than once/i.test(err.message)
    );
  });
});

describe('manage_outline', () => {
  test('set_plan rebuilds the WHOLE metadata blob', async () => {
    // nodes.metadata is ASSIGNED, not merged. A partial write replaces
    // everything — tags, writingType, every view's block.
    const sent = stub({
      'GET /nodes/n1': { id: 'n1', nodeType: 'block', metadata: { tags: ['keep'], writingType: 'fiction', plan: 'old' } },
      'PATCH /nodes/n1': (body) => ({ id: 'n1', ...body }),
    });

    await run('manage_outline', { projectId: 'p', action: 'set_plan', nodeId: 'n1', plan: 'new' });

    const patch = sent.find((r) => r.method === 'PATCH');
    assert.deepEqual(patch.body.metadata, { tags: ['keep'], writingType: 'fiction', plan: 'new' });
  });

  test('add_lines plans paragraphs through the reconcile, keeping every existing block', async () => {
    // The outline half of a section. Before this, an agent's only way to make
    // a paragraph was write_draft append, so outlines arrived as prose.
    const sent = stub({
      '/nodes': { nodes: [written('b1', 'One.', 1, 4)], hasMore: false },
      'PUT /blocks': (body) => ({
        blocks: body.blocks.map((b) => (b.plan ? { id: b.id, metadata: { plan: b.plan } } : { id: b.id })),
        refused: [],
        removed: [],
      }),
    });

    const result = await run('manage_outline', {
      projectId: 'p', action: 'add_lines', nodeId: 's',
      lines: ['  Open on the wrong ticket. ', '', 'Say what a session loses.'],
    });

    const put = sent.find((r) => r.method === 'PUT');
    assert.equal(put.body.blocks[0].id, 'b1', 'the existing block must be resent or it is deleted');
    assert.equal(Object.keys(put.body.blocks[0]).length, 1, 'and resent without content');

    const added = put.body.blocks.slice(1);
    assert.deepEqual(added.map((b) => b.plan), ['Open on the wrong ticket.', 'Say what a session loses.']);
    assert.ok(added.every((b) => b.id && !('content' in b)), 'a planned line carries no prose');
    assert.deepEqual(result.planned.map((l) => l.plan), ['Open on the wrong ticket.', 'Say what a session loses.']);
  });

  test('add_lines sends a line with its points in the same block', async () => {
    const sent = stub({
      '/nodes': { nodes: [], hasMore: false },
      'GET /nodes/s': { id: 's', nodeType: 'section', hasProse: false },
      'PUT /blocks': (body) => ({ blocks: body.blocks.map((b) => ({ id: b.id, metadata: { plan: b.plan, planPoints: b.planPoints } })), refused: [], removed: [] }),
    });

    const result = await run('manage_outline', {
      projectId: 'p', action: 'add_lines', nodeId: 's',
      lines: ['Hook.', { line: 'The four layers.', points: [' Instructions ', '', 'Task memory'] }],
    });

    const blocks = sent.find((r) => r.method === 'PUT').body.blocks;
    assert.equal(blocks[0].plan, 'Hook.');
    assert.ok(!('planPoints' in blocks[0]), 'no empty points key');
    assert.deepEqual(blocks[1].planPoints, ['Instructions', 'Task memory']);
    assert.deepEqual(result.planned[1].points, ['Instructions', 'Task memory']);
  });

  test('set_plan replaces points when given, and leaves them alone when not', async () => {
    let sent = stub({
      'GET /nodes/n1': { id: 'n1', nodeType: 'block', metadata: { plan: 'old', planPoints: ['keep'] } },
      'PATCH /nodes/n1': (body) => ({ id: 'n1', ...body }),
    });
    await run('manage_outline', { projectId: 'p', action: 'set_plan', nodeId: 'n1', plan: 'new' });
    assert.deepEqual(sent.find((r) => r.method === 'PATCH').body.metadata, { plan: 'new', planPoints: ['keep'] });

    sent = stub({
      'GET /nodes/n1': { id: 'n1', nodeType: 'block', metadata: { plan: 'old', planPoints: ['keep'] } },
      'PATCH /nodes/n1': (body) => ({ id: 'n1', ...body }),
    });
    await run('manage_outline', { projectId: 'p', action: 'set_plan', nodeId: 'n1', plan: 'new', points: [] });
    assert.deepEqual(sent.find((r) => r.method === 'PATCH').body.metadata, { plan: 'new' });
  });

  test('set_plan refuses a section, and names what to use instead', async () => {
    // The mirror of the add_lines guard below. A plan is a PARAGRAPH's outline
    // line; on a section it is a key nothing reads, and the write SUCCEEDED —
    // observed on 2026-09-15 writing metadata.plan onto a post without
    // complaint, which later looks like data somebody meant.
    const sent = stub({
      'GET /nodes/s1': { id: 's1', nodeType: 'post', metadata: { tags: ['keep'] } },
      'PATCH /nodes/s1': (body) => ({ id: 's1', ...body }),
    });

    await assert.rejects(
      () => run('manage_outline', { projectId: 'p', action: 'set_plan', nodeId: 's1', plan: 'nope' }),
      /section, not a paragraph/
    );
    // Named, because "that is wrong" without "do this instead" just gets retried.
    await assert.rejects(
      () => run('manage_outline', { projectId: 'p', action: 'set_plan', nodeId: 's1', plan: 'nope' }),
      /set_aim/
    );
    // Nothing was written. A refusal that arrives after the PATCH is a lie.
    assert.ok(!sent.some((r) => r.method === 'PATCH'), 'set_plan must not write to a section');
  });

  test('add_lines refuses a paragraph as the section', async () => {
    const sent = stub({
      '/nodes': { nodes: [], hasMore: false },
      'GET /nodes/b1': { id: 'b1', nodeType: 'block', hasProse: true },
    });
    await assert.rejects(
      () => run('manage_outline', { projectId: 'p', action: 'add_lines', nodeId: 'b1', lines: ['x'] }),
      /paragraph, not a section/
    );
    assert.ok(!sent.some((r) => r.method === 'PUT'));
  });

  test('add_lines adopts an empty section document, as append does', async () => {
    const sent = stub({
      '/nodes': { nodes: [], hasMore: false },
      'GET /nodes/s': { id: 's', nodeType: 'post', hasProse: true, content: { document: { type: 'doc', content: [] } } },
      'PUT /blocks': (body) => ({ blocks: body.blocks, refused: [], removed: [] }),
    });
    await run('manage_outline', { projectId: 'p', action: 'add_lines', nodeId: 's', lines: ['Hook.'] });
    assert.equal(sent.find((r) => r.method === 'PUT').body.adoptSectionProse, true);
  });

  test('add_lines with no usable lines sends nothing', async () => {
    const sent = stub({});
    await assert.rejects(
      () => run('manage_outline', { projectId: 'p', action: 'add_lines', nodeId: 's', lines: ['  '] }),
      /at least one/
    );
    assert.equal(sent.length, 0);
  });

  test('set_aim rebuilds the WHOLE metadata blob and trims', async () => {
    const sent = stub({
      'GET /nodes/n1': { id: 'n1', metadata: { tags: ['keep'], description: 'A synopsis.' } },
      'PATCH /nodes/n1': (body) => ({ id: 'n1', ...body }),
    });

    const result = await run('manage_outline', {
      projectId: 'p', action: 'set_aim', nodeId: 'n1', aim: '  A context window is not memory. ',
    });

    const patch = sent.find((r) => r.method === 'PATCH');
    // The synopsis is a different field and must survive.
    assert.deepEqual(patch.body.metadata, {
      tags: ['keep'], description: 'A synopsis.', aim: 'A context window is not memory.',
    });
    assert.equal(result.updated.aim, 'A context window is not memory.');
  });

  test('set_aim with an empty string clears the key', async () => {
    const sent = stub({
      'GET /nodes/n1': { id: 'n1', metadata: { tags: [], aim: 'old' } },
      'PATCH /nodes/n1': (body) => ({ id: 'n1', ...body }),
    });
    await run('manage_outline', { projectId: 'p', action: 'set_aim', nodeId: 'n1', aim: '' });
    assert.ok(!('aim' in sent.find((r) => r.method === 'PATCH').body.metadata));
  });

  test('set_alternate_titles replaces the list, keeps other metadata, and never lists the title', async () => {
    const sent = stub({
      'GET /nodes/n1': { id: 'n1', title: 'Amnesia', metadata: { aim: 'keep', alternateTitles: ['old'] } },
      'PATCH /nodes/n1': (body) => ({ id: 'n1', ...body }),
    });

    await run('manage_outline', {
      projectId: 'p', action: 'set_alternate_titles', nodeId: 'n1',
      alternateTitles: [' Four Layers ', 'four layers', '', 'amnesia', 'The Hard Part'],
    });

    assert.deepEqual(sent.find((r) => r.method === 'PATCH').body.metadata, {
      aim: 'keep', alternateTitles: ['Four Layers', 'The Hard Part'],
    });
  });

  test('set_alternate_titles with an empty array clears the key', async () => {
    const sent = stub({
      'GET /nodes/n1': { id: 'n1', title: 'T', metadata: { alternateTitles: ['x'] } },
      'PATCH /nodes/n1': (body) => ({ id: 'n1', ...body }),
    });
    await run('manage_outline', { projectId: 'p', action: 'set_alternate_titles', nodeId: 'n1', alternateTitles: [] });
    assert.ok(!('alternateTitles' in sent.find((r) => r.method === 'PATCH').body.metadata));
  });

  test('move uses the parent endpoint, never PATCH', async () => {
    // Reparenting is the one mutation that can corrupt the tree, and only that
    // endpoint rejects a destination inside the node's own subtree.
    const sent = stub({ 'PUT /parent': { id: 'n1', title: 'x' } });
    await run('manage_outline', { projectId: 'p', action: 'move', nodeId: 'n1', parentId: 'n2' });

    assert.ok(sent.some((r) => r.method === 'PUT' && r.path.endsWith('/parent')));
    assert.ok(!sent.some((r) => r.method === 'PATCH'), 'PATCH has no parentId field for a reason');
  });

  test('add never sends an order, so nodes append instead of stacking in reverse', async () => {
    const sent = stub({ 'POST /batch': (body) => ({ nodes: body.nodes }) });
    await run('manage_outline', {
      projectId: 'p', action: 'add',
      nodes: [{ title: 'One' }, { title: 'Two' }],
    });

    const posted = sent.find((r) => r.method === 'POST').body.nodes;
    assert.equal(posted.length, 2);
    assert.ok(posted.every((n) => n.id), 'the client mints the ids');
    assert.ok(posted.every((n) => !('order' in n)), 'an explicit 0 would put every one first');
  });

  test('there is no way to write prose through it', () => {
    // PATCH /nodes carries no ifContentVersion, so prose through it replaces a
    // collaborator's work unguarded. The schema simply has no field for it.
    const props = tool('manage_outline').inputSchema.properties;
    for (const banned of ['content', 'document', 'prose', 'text', 'plainText']) {
      assert.ok(!(banned in props), `manage_outline exposes ${banned}`);
    }
  });
});

describe('manage_entity', () => {
  test('update rebuilds profile from the row, keeping both layers', async () => {
    // PATCH REPLACES profile. Sending only the new keys erases the engine's
    // values and the writer's other edits.
    const sent = stub({
      'GET /entities/e1': {
        id: 'e1', name: 'Ana',
        profile: { role: 'imported', personality: { openness: 1 }, authored: { age: '40' } },
      },
      'PATCH /entities/e1': (body) => ({ id: 'e1', name: 'Ana', ...body }),
    });

    await run('manage_entity', { projectId: 'p', action: 'update', entityId: 'e1', profile: { role: 'Captain' } });

    const profile = sent.find((r) => r.method === 'PATCH').body.profile;
    assert.deepEqual(profile.personality, { openness: 1 }, "the engine's keys survive");
    assert.equal(profile.role, 'imported', 'the engine layer is not overwritten');
    assert.equal(profile.authored.age, '40', 'other authored values survive');
    assert.equal(profile.authored.role, 'Captain', 'the change lands in the authored layer');
  });

  test('create puts a profile under authored, not at the top level', async () => {
    const sent = stub({ 'POST /entities': (body) => ({ id: 'e9', ...body }) });
    await run('manage_entity', {
      projectId: 'p', action: 'create', kind: 'character', name: 'Bea', profile: { role: 'Mate' },
    });

    const body = sent.find((r) => r.method === 'POST').body;
    assert.deepEqual(body.profile, { authored: { role: 'Mate' } });
  });
});

describe('manage_cast', () => {
  test('links additively, never through the collection replace', async () => {
    // The collection PUT replaces the whole cast, silently dropping roles the
    // caller did not know to send back — `mentioned` and `cited` are the ones
    // that would go.
    const sent = stub({ 'PUT /entities/e1': { role: 'pov' } });
    await run('manage_cast', { projectId: 'p', action: 'link', nodeId: 'n1', entityId: 'e1', role: 'pov' });

    const put = sent.find((r) => r.method === 'PUT');
    assert.match(put.path, /\/nodes\/n1\/entities\/e1$/, 'must target the single-entity endpoint');
    assert.ok(!('links' in (put.body ?? {})), 'a links array would be the replacing shape');
  });

  test('unlink carries the role, which is part of the key', async () => {
    const sent = stub({ 'DELETE /entities/e1': {} });
    await run('manage_cast', { projectId: 'p', action: 'unlink', nodeId: 'n1', entityId: 'e1', role: 'present' });
    assert.equal(sent.find((r) => r.method === 'DELETE').query.get('role'), 'present');
  });

  test('does not expose the link data field', () => {
    // The handler types it []byte, so on the wire it is base64 rather than an
    // object — a trap for any JSON-shaped caller.
    assert.ok(!('data' in tool('manage_cast').inputSchema.properties));
  });
});

describe('manage_timeline', () => {
  test('update rebuilds the story sub-object rather than replacing it', async () => {
    // `data = data || $n` merges KEYS, not trees. A payload naming `story`
    // replaces the whole thing — which is how editing a title once deleted an
    // imported event's entire cast.
    const sent = stub({
      'GET /timeline-events': {
        events: [{
          id: 'ev1',
          data: { title: 'Old', type: 'scene', story: { characters: ['c1'], locations: ['l1'] } },
        }],
      },
      'PATCH /timeline-events/ev1': (body) => ({ id: 'ev1', ...body }),
    });

    await run('manage_timeline', { projectId: 'p', action: 'update', eventId: 'ev1', title: 'New' });

    const data = sent.find((r) => r.method === 'PATCH').body.data;
    assert.equal(data.title, 'New');
    assert.deepEqual(data.story.characters, ['c1'], 'the cast must survive a title edit');
    assert.deepEqual(data.story.locations, ['l1']);
    assert.equal(data.type, 'scene', 'sibling keys survive too');
  });

  test('character ids replace cleanly when given', async () => {
    const sent = stub({
      'GET /timeline-events': { events: [{ id: 'ev1', data: { story: { characters: ['c1'], locations: ['l1'] } } }] },
      'PATCH /timeline-events/ev1': (body) => ({ id: 'ev1', ...body }),
    });
    await run('manage_timeline', { projectId: 'p', action: 'update', eventId: 'ev1', characterIds: ['c2'] });

    const story = sent.find((r) => r.method === 'PATCH').body.data.story;
    assert.deepEqual(story.characters, ['c2']);
    assert.deepEqual(story.locations, ['l1'], 'locations are not collateral');
  });
});
