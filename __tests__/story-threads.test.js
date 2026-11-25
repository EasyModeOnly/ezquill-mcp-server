import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS } from '../src/tools/index.js';
import { withRequest } from '../src/lib/request-context.js';

const tool = (name) => TOOLS.find((t) => t.name === name);
const run = (name, args) => withRequest({ token: 't' }, () => tool(name).handler(args));

/** Records every request; a route answer of { __status, body } fails. */
function stub(routes) {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const method = init?.method ?? 'GET';
    sent.push({ path: u.pathname, query: u.searchParams, method, body });
    for (const [pattern, respond] of Object.entries(routes)) {
      const [m, suffix] = pattern.includes(' ') ? pattern.split(' ') : ['*', pattern];
      if ((m === '*' || m === method) && u.pathname.endsWith(suffix)) {
        const value = typeof respond === 'function' ? respond(body, u) : respond;
        if (value && value.__status) {
          return { ok: false, status: value.__status, statusText: 'x', headers: new Map(), json: async () => value.body };
        }
        return { ok: true, status: value === null ? 204 : 200, json: async () => value };
      }
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return sent;
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const thread = (over = {}) => ({
  id: 'st1', projectId: 'p', ownerId: 'o', title: 'The well', question: 'Who poisoned the well?', kind: 'event',
  tags: ['mystery'], scope: 'book', weight: 'major', origin: 'author', entities: [], createdAt: 'x', updatedAt: 'x',
  ...over,
});

const proposal = (over = {}) => ({
  id: 'pr1', projectId: 'p', source: 'connector', kind: 'new_thread', state: 'pending',
  payload: { thread: { title: 'The well', question: 'Who poisoned the well?', kind: 'event', weight: 'minor', scope: 'book' } },
  evidence: { rationale: 'Because.' }, dedupeKey: 'thread:poisoned well who', evidenceFingerprint: 'f', dismissCount: 0,
  unitIds: [], reopened: false, newUnitIds: [], resultTouchIds: [], createdAt: 'x', updatedAt: 'x', ...over,
});

/** A section with one written paragraph block, its document included. */
const sectionWithBlock = (text) => ({
  'GET /nodes/s': { id: 's', nodeType: 'scene', hasProse: false },
  'GET /nodes': {
    nodes: [{
      id: 'b1', nodeType: 'block', order: 1, hasProse: true,
      content: { plainText: text, document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } },
    }],
    hasMore: false,
  },
});

const batchEcho = (outcome = 'created') => (body) => ({
  items: body.proposals.map((p, index) => ({ index, outcome, proposals: [proposal({ kind: p.kind, payload: p.payload })] })),
});

describe('naming', () => {
  test('every tool says story_thread or thread_ and none is a bare "thread" tool', () => {
    for (const name of ['list_story_threads', 'get_thread_map_data', 'list_thread_proposals',
      'manage_story_thread', 'add_thread_touch', 'review_thread_proposal']) {
      assert.ok(tool(name), `${name} exists`);
    }
    assert.ok(!TOOLS.some((t) => /^(list|manage|get)_threads?$/.test(t.name)));
  });
});

describe('list_story_threads', () => {
  test('lists the threads, filtered by kind, without a status it would have to derive', async () => {
    const sent = stub({
      '/story-threads': { items: [thread(), thread({ id: 'st2', kind: 'character', seriesId: 'se' })] },
    });
    const out = await run('list_story_threads', { projectId: 'p', kind: 'event' });
    assert.equal(sent[0].path, '/api/v1/projects/p/story-threads');
    assert.deepEqual(out.storyThreads.map((t) => t.id), ['st1']);
    assert.equal(out.storyThreads[0].owner, 'project');
    assert.equal(out.storyThreads[0].status, undefined);
  });

  test('one thread comes with its touches, quotes and interchanges', async () => {
    const sent = stub({
      '/story-threads/st1': thread(),
      '/story-thread-touches': {
        items: [{
          id: 't1', projectId: 'p', nodeId: 'b1', planned: false, origin: 'author',
          anchor: { from: 1, to: 5, text: 'well' },
          storyThreads: [{ storyThreadId: 'st1', type: 'clue' }, { storyThreadId: 'st2', type: 'open' }],
        }],
      },
    });
    const out = await run('list_story_threads', { projectId: 'p', storyThreadId: 'st1' });
    const touches = sent.find((r) => r.path.endsWith('/story-thread-touches'));
    assert.equal(touches.query.get('storyThreadId'), 'st1');
    assert.equal(out.storyThread.id, 'st1');
    assert.equal(out.touches[0].quote, 'well');
    assert.equal(out.touches[0].interchange, true);
  });

  test('is read-only', () => {
    assert.equal(tool('list_story_threads').annotations.readOnlyHint, true);
  });
});

describe('get_thread_map_data', () => {
  const map = {
    version: 1, projectId: 'p',
    manuscript: { totalWords: 9000, units: [{ id: 'u1' }, { id: 'u2' }] },
    threads: [{ id: 'st1', status: 'open' }, { id: 'st2', status: 'open' }, { id: 'st3', status: 'resolved' }],
    interchanges: [{ touchId: 't1' }],
    alerts: [{ id: 'a1', severity: 'warning' }],
    proposals: { pending: 4, inPlace: [] },
  };

  test('returns the payload unchanged, with a summary that only counts', async () => {
    const sent = stub({ '/story-threads/map-data': map });
    const out = await run('get_thread_map_data', { projectId: 'p' });
    assert.equal(sent[0].path, '/api/v1/projects/p/story-threads/map-data');
    assert.deepEqual(out.mapData, map);
    assert.deepEqual(out.summary.byStatus, { open: 2, resolved: 1 });
    assert.equal(out.summary.alerts, 1);
    assert.equal(out.summary.pendingProposals, 4);
  });

  test('reads the series map for a seriesId', async () => {
    const sent = stub({ '/story-threads/map-data': map });
    await run('get_thread_map_data', { seriesId: 'se' });
    assert.equal(sent[0].path, '/api/v1/series/se/story-threads/map-data');
  });

  test('wants exactly one of projectId and seriesId', async () => {
    await assert.rejects(() => run('get_thread_map_data', {}), /exactly one/);
    await assert.rejects(() => run('get_thread_map_data', { projectId: 'p', seriesId: 's' }), /exactly one/);
  });

  test("says the statuses and alerts are the writer's own view", () => {
    assert.match(tool('get_thread_map_data').description, /writer's view/);
  });
});

describe('list_thread_proposals', () => {
  test('defaults to pending and passes the filters', async () => {
    const sent = stub({ '/story-thread-proposals': { items: [proposal()] } });
    const out = await run('list_thread_proposals', { projectId: 'p', source: 'reader' });
    assert.equal(sent[0].query.get('state'), 'pending');
    assert.equal(sent[0].query.get('source'), 'reader');
    assert.equal(out.proposals[0].id, 'pr1');
    assert.equal(out.proposals[0].dedupeKey, undefined, 'bookkeeping is trimmed');
  });

  test('state all sends no state filter', async () => {
    const sent = stub({ '/story-thread-proposals': { items: [] } });
    await run('list_thread_proposals', { projectId: 'p', state: 'all' });
    assert.equal(sent[0].query.get('state'), null);
  });
});

describe('manage_story_thread — proposes, never writes', () => {
  test('create sends one new_thread proposal through the batch, as the connector', async () => {
    const sent = stub({ 'POST /batch': batchEcho() });
    const out = await run('manage_story_thread', {
      projectId: 'p', action: 'create', title: 'The well', question: 'Who poisoned the well?', kind: 'event',
      weight: 'major', tags: ['mystery'], entityIds: ['e1'], rationale: 'It is asked in chapter 1.',
    });
    const post = sent.find((r) => r.method === 'POST');
    assert.equal(post.path, '/api/v1/projects/p/story-thread-proposals/batch');
    assert.equal(post.body.source, 'connector');
    const [p] = post.body.proposals;
    assert.equal(p.kind, 'new_thread');
    assert.deepEqual(p.payload.thread, { title: 'The well', question: 'Who poisoned the well?', kind: 'event', weight: 'major', tags: ['mystery'] });
    assert.deepEqual(p.payload.entityIds, ['e1']);
    assert.equal(p.evidence.rationale, 'It is asked in chapter 1.');
    assert.match(out.status, /Proposed, not applied/);
    assert.ok(!sent.some((r) => r.path.endsWith('/story-threads') && r.method === 'POST'), 'no thread row is written');
  });

  test("create places a touch's quote on the paragraph it is in, anchored in that block", async () => {
    const sent = stub({ ...sectionWithBlock('The water tasted of iron.'), 'POST /batch': batchEcho() });
    await run('manage_story_thread', {
      projectId: 'p', action: 'create', title: 'Well', question: 'Who poisoned the well?', kind: 'event',
      touches: [{ nodeId: 's', type: 'open', quote: 'tasted of iron' }],
    });
    const [p] = sent.find((r) => r.method === 'POST').body.proposals;
    // "The water " is 10 characters; the paragraph's first character is position 1.
    assert.deepEqual(p.payload.touches, [{ nodeId: 'b1', type: 'open', anchor: { from: 11, to: 25, text: 'tasted of iron' } }]);
    assert.deepEqual(p.evidence.quotes, [{ nodeId: 'b1', text: 'tasted of iron' }]);
  });

  test('a quote found twice is refused, not guessed', async () => {
    stub(sectionWithBlock('Iron. Iron.'));
    await assert.rejects(
      () => run('manage_story_thread', {
        projectId: 'p', action: 'create', title: 'W', question: 'Who poisoned the well?', kind: 'event',
        touches: [{ nodeId: 's', type: 'clue', quote: 'Iron.' }],
      }),
      /more than once/
    );
  });

  test('a planned touch cannot quote', async () => {
    stub({});
    await assert.rejects(
      () => run('manage_story_thread', {
        projectId: 'p', action: 'create', title: 'W', question: 'Who poisoned the well?', kind: 'event',
        touches: [{ nodeId: 's', type: 'payoff', planned: true, quote: 'x' }],
      }),
      /planned touch has no prose/
    );
  });

  test('merge proposes merge_threads with the survivor as target', async () => {
    const sent = stub({ 'POST /batch': batchEcho() });
    await run('manage_story_thread', { projectId: 'p', action: 'merge', storyThreadId: 'st2', intoStoryThreadId: 'st1' });
    const [p] = sent[0].body.proposals;
    assert.equal(p.kind, 'merge_threads');
    assert.equal(p.targetStoryThreadId, 'st1');
    assert.deepEqual(p.payload, { storyThreadId: 'st2' });
  });

  test('link_reader_question proposes the link', async () => {
    const sent = stub({ 'POST /batch': batchEcho() });
    await run('manage_story_thread', { projectId: 'p', action: 'link_reader_question', storyThreadId: 'st1', readerQuestionId: 'q-id' });
    const [p] = sent[0].body.proposals;
    assert.equal(p.kind, 'link_reader_question');
    assert.equal(p.readerQuestionId, 'q-id');
  });

  test('a still-dismissed outcome tells the agent not to propose it again', async () => {
    stub({ 'POST /batch': batchEcho('still_dismissed') });
    const out = await run('manage_story_thread', { projectId: 'p', action: 'merge', storyThreadId: 'st2', intoStoryThreadId: 'st1' });
    assert.equal(out.items[0].outcome, 'still_dismissed');
    assert.match(out.items[0].meaning, /do not propose it again/);
  });

  test('offers no edit or delete, and says proposals in its description', () => {
    const t = tool('manage_story_thread');
    assert.deepEqual(t.inputSchema.properties.action.enum, ['create', 'merge', 'link_reader_question']);
    assert.match(t.description, /PROPOSALS the writer accepts/);
  });
});

describe('add_thread_touch', () => {
  test('proposes one new_touch on the thread, quote anchored', async () => {
    const sent = stub({ ...sectionWithBlock('A crow on the well.'), 'POST /batch': batchEcho() });
    const out = await run('add_thread_touch', {
      projectId: 'p', storyThreadId: 'st1', nodeId: 's', type: 'clue', quote: 'crow', note: 'An omen.',
    });
    const [p] = sent.find((r) => r.method === 'POST').body.proposals;
    assert.equal(p.kind, 'new_touch');
    assert.equal(p.targetStoryThreadId, 'st1');
    assert.deepEqual(p.payload.touches, [{ nodeId: 'b1', type: 'clue', note: 'An omen.', anchor: { from: 3, to: 7, text: 'crow' } }]);
    assert.match(out.status, /not applied/);
  });

  test('a planned touch goes on the section, unanchored', async () => {
    const sent = stub({ 'POST /batch': batchEcho() });
    await run('add_thread_touch', { projectId: 'p', storyThreadId: 'st1', nodeId: 's', type: 'payoff', planned: true });
    assert.deepEqual(sent[0].body.proposals[0].payload.touches, [{ nodeId: 's', type: 'payoff', planned: true }]);
  });

  test('refuses an unknown touch type before calling anything', async () => {
    const sent = stub({});
    await assert.rejects(() => run('add_thread_touch', { projectId: 'p', storyThreadId: 'st1', nodeId: 's', type: 'twist' }), /type must be/);
    assert.equal(sent.length, 0);
  });
});

describe('review_thread_proposal — acts for the writer', () => {
  test('says it changes things and is for when the writer asked', () => {
    const d = tool('review_thread_proposal').description;
    assert.match(d, /FOR THE WRITER/);
    assert.match(d, /ONLY when the writer has asked/);
    assert.equal(tool('review_thread_proposal').annotations.readOnlyHint, false);
  });

  test('accept sends the ids to decide', async () => {
    const sent = stub({ 'POST /decide': { decisionBatchId: 'b1', proposals: [proposal({ state: 'accepted' })], skipped: [] } });
    const out = await run('review_thread_proposal', { projectId: 'p', action: 'accept', proposalIds: ['pr1', 'pr2'] });
    assert.equal(sent[0].path, '/api/v1/projects/p/story-thread-proposals/decide');
    assert.deepEqual(sent[0].body, { proposalIds: ['pr1', 'pr2'], action: 'accept' });
    assert.equal(out.decisionBatchId, 'b1');
    assert.equal(out.proposals[0].state, 'accepted');
  });

  test('bulk dismiss by selector, with a reason', async () => {
    const sent = stub({ 'POST /decide': { decisionBatchId: 'b', proposals: [], skipped: [] } });
    await run('review_thread_proposal', { projectId: 'p', action: 'dismiss', source: 'structural', reason: 'Not mine.' });
    assert.deepEqual(sent[0].body, { source: 'structural', action: 'dismiss', reason: 'Not mine.' });
  });

  test('refuses with no target, and a selector for anything but accept or dismiss', async () => {
    stub({});
    await assert.rejects(() => run('review_thread_proposal', { projectId: 'p', action: 'accept' }), /needs proposalId/);
    await assert.rejects(() => run('review_thread_proposal', { projectId: 'p', action: 'restore', kind: 'new_touch' }), /accept and dismiss only/);
  });

  test('edit_accept rebuilds the whole payload from the proposal read back', async () => {
    const original = proposal({
      payload: {
        thread: { title: 'Well', question: 'Who poisoned the well?', kind: 'event', weight: 'minor', scope: 'book' },
        touches: [{ nodeId: 'b1', type: 'open' }],
        entityIds: ['e1'],
      },
    });
    const sent = stub({
      'GET /story-thread-proposals/pr1': original,
      'POST /decide': { decisionBatchId: 'b', proposals: [], skipped: [] },
    });
    await run('review_thread_proposal', { projectId: 'p', action: 'edit_accept', proposalId: 'pr1', edit: { weight: 'main', title: 'The well' } });
    const decide = sent.find((r) => r.method === 'POST');
    assert.equal(decide.body.action, 'accept');
    assert.deepEqual(decide.body.edit.payload, {
      thread: { title: 'The well', question: 'Who poisoned the well?', kind: 'event', weight: 'main', scope: 'book' },
      touches: [{ nodeId: 'b1', type: 'open' }],
      entityIds: ['e1'],
    });
  });

  test("edit_accept changes a new_touch's type", async () => {
    const sent = stub({
      'GET /story-thread-proposals/pr1': proposal({ kind: 'new_touch', targetStoryThreadId: 'st1', payload: { touches: [{ nodeId: 'b1', type: 'clue' }] } }),
      'POST /decide': { decisionBatchId: 'b', proposals: [], skipped: [] },
    });
    await run('review_thread_proposal', { projectId: 'p', action: 'edit_accept', proposalId: 'pr1', edit: { touchType: 'payoff' } });
    assert.deepEqual(sent.find((r) => r.method === 'POST').body.edit.payload.touches, [{ nodeId: 'b1', type: 'payoff' }]);
  });

  test('merge needs exactly one destination', async () => {
    stub({});
    await assert.rejects(() => run('review_thread_proposal', { projectId: 'p', action: 'merge', proposalId: 'pr1' }), /exactly one/);
    const sent = stub({ 'POST /decide': { decisionBatchId: 'b', proposals: [], skipped: [] } });
    await run('review_thread_proposal', { projectId: 'p', action: 'merge', proposalId: 'pr1', intoStoryThreadId: 'st1' });
    assert.deepEqual(sent[0].body, { proposalIds: ['pr1'], action: 'merge', intoStoryThreadId: 'st1' });
  });

  test('undo by batch id; a 409 naming the edited rows reaches the agent', async () => {
    const sent = stub({ 'POST /undo': { proposals: [proposal()] } });
    const out = await run('review_thread_proposal', { projectId: 'p', action: 'undo', decisionBatchId: 'b1' });
    assert.deepEqual(sent[0].body, { decisionBatchId: 'b1' });
    assert.equal(out.proposals[0].state, 'pending');

    stub({ 'POST /undo': { __status: 409, body: { error: { message: 'changed since the proposal was accepted: The well' } } } });
    await assert.rejects(
      () => run('review_thread_proposal', { projectId: 'p', action: 'undo', proposalId: 'pr1' }),
      /changed since the proposal was accepted/
    );
  });
});
