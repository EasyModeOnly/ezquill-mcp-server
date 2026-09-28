import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS } from '../src/tools/index.js';
import { withRequest } from '../src/lib/request-context.js';

const tool = (name) => TOOLS.find((t) => t.name === name);
const run = (name, args) => withRequest({ token: 't' }, () => tool(name).handler(args));

/** Records every request, with its HOST, so a test can tell the API from the web app. */
function stub(routes) {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const method = init?.method ?? 'GET';
    sent.push({ host: u.host, path: u.pathname, query: u.searchParams, method, body });
    for (const [pattern, respond] of Object.entries(routes)) {
      const [m, suffix] = pattern.includes(' ') ? pattern.split(' ') : ['*', pattern];
      if ((m === '*' || m === method) && u.pathname.endsWith(suffix)) {
        const value = typeof respond === 'function' ? respond(body, u) : respond;
        return { ok: true, status: value === null ? 204 : 200, json: async () => value };
      }
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return sent;
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const compiled = {
  prompt: 'COMPILED PROMPT',
  wasEdited: false,
  params: { model: 'seedance_2_0', aspectRatio: '9:16', durationSeconds: 6, generateAudio: true },
  diagnostics: [],
  assets: [{ entityId: 'sal', name: 'Sal', kind: 'character', roles: ['present'], elementId: 'EL-1' }],
};

describe('compile_prompt and get_production read the WEB APP', () => {
  test('compile_prompt posts to the app route, not the API', async () => {
    const sent = stub({ 'POST /api/video/compile': compiled });
    const out = await run('compile_prompt', { projectId: 'p', nodeId: 's1' });
    assert.equal(out.prompt, 'COMPILED PROMPT');
    const req = sent[0];
    assert.equal(req.path, '/api/video/compile');
    assert.ok(!req.path.startsWith('/api/v1'), 'no API prefix on an app route');
    assert.equal(req.host, 'ezquill.com');
  });

  test('get_production passes the scope through', async () => {
    const sent = stub({ '/api/video/production': { scope: 'episode', board: {} } });
    await run('get_production', { projectId: 'p', scope: 'episode', nodeId: 'ep1' });
    assert.equal(sent[0].query.get('scope'), 'episode');
    assert.equal(sent[0].query.get('nodeId'), 'ep1');
  });
});

describe('manage_production', () => {
  test('record_take fills prompt, params and asset stamps from the compile', async () => {
    const sent = stub({
      'POST /api/video/compile': compiled,
      'POST /versions': (body) => ({ id: 'v9', versionNumber: 3, ...body }),
    });
    const out = await run('manage_production', {
      projectId: 'p', action: 'record_take', nodeId: 's1',
      take: { jobId: 'job-1', status: 'rejected', verdictReason: { code: 'eyes' }, modelActual: 'seedance_1_5' },
    });
    const take = sent.find((r) => r.method === 'POST' && r.path.endsWith('/versions')).body.content.take;
    assert.equal(take.prompt, 'COMPILED PROMPT');
    assert.equal(take.modelRequested, 'seedance_2_0');
    assert.equal(take.modelActual, 'seedance_1_5', "the agent's own fields win");
    assert.equal(take.status, 'rejected');
    assert.deepEqual(take.assets, compiled.assets);
    assert.deepEqual(out.recorded, { versionId: 'v9', number: 3, status: 'rejected' });
  });

  test('record_take refuses a take with no job id', async () => {
    stub({});
    await assert.rejects(run('manage_production', { projectId: 'p', action: 'record_take', nodeId: 's1', take: {} }), /jobId/);
  });

  test('update_take goes through the server-side take patch', async () => {
    const sent = stub({ 'PATCH /take': {} });
    await run('manage_production', {
      projectId: 'p', action: 'update_take', nodeId: 's1', versionId: 'v9', patch: { status: 'accepted' },
    });
    const req = sent.find((r) => r.method === 'PATCH');
    assert.match(req.path, /\/nodes\/s1\/versions\/v9\/take$/);
    assert.deepEqual(req.body, { status: 'accepted' });
  });

  test('update_record rebuilds data from the record, since PATCH replaces it whole', async () => {
    const sent = stub({
      'GET /production-records/r1': { id: 'r1', kind: 'cue', data: { type: 'sfx', title: 'clink', status: 'idea' } },
      'PATCH /production-records/r1': (body) => ({ id: 'r1', kind: 'cue', ...body }),
    });
    await run('manage_production', { projectId: 'p', action: 'update_record', recordId: 'r1', data: { status: 'placed' } });
    const patch = sent.find((r) => r.method === 'PATCH').body;
    assert.deepEqual(patch.data, { type: 'sfx', title: 'clink', status: 'placed' });
  });

  test('record_cut posts a cut record on the episode', async () => {
    const sent = stub({ 'POST /production-records': (body) => ({ id: 'c1', ...body }) });
    await run('manage_production', {
      projectId: 'p', action: 'record_cut', nodeId: 'ep1',
      data: { trims: [{ shotNodeId: 's1', takeId: 'v9', inSeconds: 0, outSeconds: 4.2 }] },
    });
    assert.deepEqual(sent[0].body.kind, 'cut');
    assert.equal(sent[0].body.nodeId, 'ep1');
  });

  test('set_status sends null to stop tracking', async () => {
    const sent = stub({ 'PUT /production-status': { id: 's1' } });
    const out = await run('manage_production', { projectId: 'p', action: 'set_status', nodeId: 's1', status: null });
    assert.deepEqual(sent[0].body, { status: null });
    assert.equal(out.productionStatus, null);
  });

  test('delete_record is a DELETE, which a connector needs the delete scope for', async () => {
    const sent = stub({ 'DELETE /production-records/r1': null });
    await run('manage_production', { projectId: 'p', action: 'delete_record', recordId: 'r1' });
    assert.equal(sent[0].method, 'DELETE');
  });
});

describe('read_scene on a shot', () => {
  test('adds its production at a glance', async () => {
    stub({
      '/nodes/s1': { id: 's1', title: 'The jar', nodeType: 'shot', productionStatus: 'review' },
      '/nodes': { nodes: [], hasMore: false },
      '/entities': { cast: [] },
      '/versions': {
        versions: [
          { id: 'v1', content: { take: { status: 'rejected' } } },
          { id: 'v2', content: { take: { status: 'accepted' } } },
          { id: 'v3', content: { plainText: 'a snapshot, not a take' } },
        ],
      },
    });
    const out = await run('read_scene', { projectId: 'p', nodeId: 's1' });
    assert.deepEqual(out.production, { status: 'review', takeCount: 2, lockedTakeId: 'v2' });
  });
});
