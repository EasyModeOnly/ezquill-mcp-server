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
    const post = sent.find((r) => r.method === 'POST');
    assert.deepEqual(post.body.kind, 'cut');
    assert.equal(post.body.nodeId, 'ep1');
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

describe('the take API, from an agent (ezquill epic #40)', () => {
  const schema = () => tool('manage_production').inputSchema.properties;

  // Saltpig shorts: an agent guessed startImage.provider, then .jobId, then
  // audioChecks.floorDb, because the shape was only prose (#433).
  test('declares the take, its start image and its audio checks field by field', () => {
    const take = schema().take;
    assert.deepEqual(Object.keys(take.properties.startImage.properties).sort(),
      ['frame', 'frameSeconds', 'fromNodeId', 'fromTakeId', 'note', 'source']);
    assert.deepEqual(Object.keys(take.properties.audioChecks.properties).sort(),
      ['noiseFloorDb', 'notes', 'speechPresent', 'wrongSpeaker']);
    assert.deepEqual(take.properties.startImage.properties.source.enum, ['none', 'still', 'previous-take', 'upload']);
    assert.ok(schema().patch.properties.audioChecks, 'update_take can set audio checks');
  });

  // Mirrors versions.Take and versions.TakePatch in the API. The API refuses a
  // key not on this list, so a field added there and not here is invisible to
  // an agent, and one here and not there is a 400 waiting to happen.
  test('lists exactly the fields the API accepts', () => {
    const TAKE = ['jobId', 'tool', 'model', 'modelRequested', 'modelActual', 'aspectRatio', 'durationSeconds',
      'resolution', 'seed', 'generateAudio', 'declinedPresetId', 'credits', 'prompt', 'wasEdited', 'promptSource',
      'promptRef', 'startImage', 'assets', 'status', 'note', 'url', 'shotAt', 'review', 'verdictReason',
      'audioChecks', 'voice', 'files', 'lastFrame', 'handoffFrame'];
    // Set by the connector, never by the agent: the v1 model name and where
    // the prompt came from.
    const SET_HERE = ['model', 'promptSource'];
    assert.deepEqual(Object.keys(schema().take.properties).sort(), TAKE.filter((k) => !SET_HERE.includes(k)).sort());
    // promptSource and promptRef retract a prompt (ezquill #446); the text
    // itself is never patchable.
    const PATCH = ['status', 'note', 'verdictReason', 'review', 'audioChecks', 'voice', 'files', 'lastFrame',
      'handoffFrame', 'modelActual', 'credits', 'promptSource', 'promptRef'];
    assert.deepEqual(Object.keys(schema().patch.properties).sort(), [...PATCH].sort());
  });

  test('closes every nested object, so a validating client catches a misspelt key first', () => {
    const open = [];
    const walk = (node, path) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'object' && node.properties && node.additionalProperties !== false) open.push(path);
      for (const [k, v] of Object.entries(node.properties ?? {})) walk(v, `${path}.${k}`);
      if (node.items) walk(node.items, `${path}[]`);
    };
    walk(schema().take, 'take');
    walk(schema().patch, 'patch');
    assert.deepEqual(open, []);
  });

  // A version id is unique; asking for the shot too was one more thing to get wrong (#435).
  test('update_take needs only the version', async () => {
    const sent = stub({ 'PATCH /takes/v9': {} });
    await run('manage_production', { projectId: 'p', action: 'update_take', versionId: 'v9', patch: { status: 'accepted' } });
    const req = sent.find((r) => r.method === 'PATCH');
    assert.equal(req.path, '/api/v1/projects/p/takes/v9');
  });

  test('records the start frame the compile resolved, and that the prompt is the compile', async () => {
    const startImage = { source: 'previous-take', fromTakeId: 'v3', fromNodeId: 's0', frame: { provider: 'local', role: 'handoff_frame', path: '/f.png' } };
    const sent = stub({
      'POST /api/video/compile': { ...compiled, params: { ...compiled.params, startImage } },
      'POST /versions': (body) => ({ id: 'v9', versionNumber: 1, ...body }),
    });
    await run('manage_production', { projectId: 'p', action: 'record_take', nodeId: 's1', take: { jobId: 'j' } });
    const take = sent.find((r) => r.path.endsWith('/versions')).body.content.take;
    assert.deepEqual(take.startImage, startImage);
    assert.equal(take.promptSource, 'compiled');
  });

  test('a supplied prompt is recorded as supplied', async () => {
    const sent = stub({ 'POST /api/video/compile': compiled, 'POST /versions': (b) => ({ id: 'v', ...b }) });
    await run('manage_production', {
      projectId: 'p', action: 'record_take', nodeId: 's1', take: { jobId: 'j', prompt: 'WHAT I SENT', wasEdited: true },
    });
    const take = sent.find((r) => r.path.endsWith('/versions')).body.content.take;
    assert.equal(take.prompt, 'WHAT I SENT');
    assert.equal(take.promptSource, 'supplied');
  });

  // A take generated weeks ago was stamped with today's compile (#436).
  describe('backfill', () => {
    test('compiles nothing and records the prompt as not captured', async () => {
      const sent = stub({ 'POST /versions': (b) => ({ id: 'v1', versionNumber: 1, ...b }) });
      const out = await run('manage_production', {
        projectId: 'p', action: 'record_take', nodeId: 's1', backfill: true,
        take: { jobId: 'j', status: 'accepted', shotAt: '2026-09-12T10:00:00Z' },
      });
      assert.ok(!sent.some((r) => r.path === '/api/video/compile'), 'no compile');
      const take = sent[0].body.content.take;
      assert.equal(take.prompt, '');
      assert.equal(take.promptSource, 'not-captured');
      assert.deepEqual(take.assets, []);
      assert.equal(take.shotAt, '2026-09-12T10:00:00Z');
      assert.equal(out.recorded.promptSource, 'not-captured');
    });

    test('keeps a pointer to the job that holds the prompt', async () => {
      const sent = stub({ 'POST /versions': (b) => ({ id: 'v1', ...b }) });
      await run('manage_production', {
        projectId: 'p', action: 'record_take', nodeId: 's1', backfill: true,
        take: { jobId: 'j', shotAt: '2026-09-12T10:00:00Z', promptRef: { tool: 'higgsfield', jobId: 'j' } },
      });
      assert.equal(sent[0].body.content.take.promptSource, 'reference');
    });

    test('refuses to guess when it was shot', async () => {
      stub({});
      await assert.rejects(
        run('manage_production', { projectId: 'p', action: 'record_take', nodeId: 's1', backfill: true, take: { jobId: 'j' } }),
        /shotAt/
      );
    });
  });

  // The API names the path of a refused key; it has to reach the agent (#434).
  test('a validation error carries the field it refused', async () => {
    globalThis.fetch = async () => ({
      ok: false, status: 400, statusText: 'Bad Request',
      json: async () => ({ error: { code: 'validation_error', field: 'take.audioChecks.floorDb', message: 'unknown field "floorDb"; allowed here: noiseFloorDb, notes, speechPresent, wrongSpeaker' } }),
    });
    await assert.rejects(
      run('manage_production', { projectId: 'p', action: 'update_take', versionId: 'v9', patch: { audioChecks: { floorDb: -40 } } }),
      (err) => err.detail?.field === 'take.audioChecks.floorDb' && /noiseFloorDb/.test(err.message)
    );
  });
});

describe('shot fields, the house template and rules, from an agent (ezquill #431 #432 #439)', () => {
  test('set_shot patches only the fields sent, server-side', async () => {
    const sent = stub({ 'PATCH /nodes/s6/shot': { id: 's6', metadata: { shot: { camera: { move: 'tracking' } } } } });
    const out = await run('manage_production', {
      projectId: 'p', action: 'set_shot', nodeId: 's6', shot: { camera: { move: 'tracking' }, castOrder: null },
    });
    assert.equal(sent[0].path, '/api/v1/projects/p/nodes/s6/shot');
    assert.deepEqual(sent[0].body, { camera: { move: 'tracking' }, castOrder: null });
    assert.deepEqual(out, { nodeId: 's6', shot: { camera: { move: 'tracking' } } });
  });

  test('set_prompt_template puts the whole template', async () => {
    const sent = stub({ 'PUT /prompt-template': { style: 'House.' } });
    await run('manage_production', {
      projectId: 'p', action: 'set_prompt_template',
      template: { style: 'House.', extraBlocks: [{ name: 'NO FADES', text: 'No fades.', after: 'SHOT' }] },
    });
    assert.equal(sent[0].method, 'PUT');
    assert.equal(sent[0].path, '/api/v1/projects/p/prompt-template');
  });

  test('add_rule writes to the entity when named, and marks it as the agent\'s', async () => {
    const sent = stub({ 'POST /rules': { rules: [] } });
    await run('manage_production', {
      projectId: 'p', action: 'add_rule', entityId: 'sal', rule: { block: 'EARS', text: 'Exactly two ears.' },
    });
    assert.equal(sent[0].path, '/api/v1/projects/p/entities/sal/rules');
    assert.equal(sent[0].body.origin, 'agent');
  });

  test('remove_rule on the show says when the bible will put it back', async () => {
    const sent = stub({ 'POST /show-rules/remove': { removed: true, imported: true, rules: [] } });
    const out = await run('manage_production', {
      projectId: 'p', action: 'remove_rule', rule: { block: 'AUDIO', text: 'no music' },
    });
    assert.equal(sent[0].path, '/api/v1/projects/p/show-rules/remove');
    assert.match(out.note, /next bible import/);
  });

  // ezquill #450: an episode's wardrobe is a rule on the episode.
  test('add_rule writes to the episode when named', async () => {
    const sent = stub({ 'POST /rules': { rules: [] } });
    await run('manage_production', {
      projectId: 'p', action: 'add_rule', episodeId: 'ep5', rule: { block: 'WARDROBE', text: 'AI Slop wears the grey robe.' },
    });
    assert.equal(sent[0].path, '/api/v1/projects/p/nodes/ep5/rules');
    assert.equal(sent[0].body.entityId, undefined);
  });

  // ezquill #455: Sal's robe in this episode only is an episode rule about Sal.
  test('add_rule with an entity AND an episode writes to the episode, naming the entity', async () => {
    const sent = stub({ 'POST /rules': { rules: [] }, 'POST /rules/remove': { removed: true, rules: [] } });
    await run('manage_production', {
      projectId: 'p', action: 'add_rule', episodeId: 'ep5', entityId: 'sal', rule: { block: 'WARDROBE', text: 'wears the grey robe.' },
    });
    assert.equal(sent[0].path, '/api/v1/projects/p/nodes/ep5/rules');
    assert.equal(sent[0].body.entityId, 'sal');
    await run('manage_production', {
      projectId: 'p', action: 'remove_rule', episodeId: 'ep5', entityId: 'sal', rule: { block: 'WARDROBE', text: 'wears the grey robe.' },
    });
    assert.deepEqual(sent[1].body, { block: 'WARDROBE', text: 'wears the grey robe.', entityId: 'sal' });
  });

  test('override_rule finds an episode rule about an entity, and not the episode-wide one', async () => {
    const sent = stub({
      'GET /nodes/ep5': {
        title: 'Ep. 5',
        metadata: { bible: { rules: [{ block: 'WARDROBE', text: 'everyone in yellow' }, { block: 'WARDROBE', text: 'the grey robe', entityId: 'sal' }] } },
      },
      'POST /shot/overrides': (body) => ({ overrides: [body] }),
    });
    await run('manage_production', {
      projectId: 'p', action: 'override_rule', nodeId: 's6', episodeId: 'ep5', entityId: 'sal',
      rule: { block: 'WARDROBE' }, reason: 'robe off for the gag', replacement: 'Sal is in a towel',
    });
    assert.deepEqual(sent.at(-1).body, {
      entityId: 'sal', block: 'WARDROBE', textAtOverride: 'the grey robe', reason: 'robe off for the gag', replacement: 'Sal is in a towel',
    });
  });

  // ezquill #452.
  test('record_take carries the show resolution from the compile', async () => {
    const sent = stub({
      'POST /api/video/compile': { ...compiled, params: { ...compiled.params, resolution: '1080p' } },
      'POST /versions': (body) => ({ id: 'v1', versionNumber: 1, ...body }),
    });
    await run('manage_production', { projectId: 'p', action: 'record_take', nodeId: 's1', take: { jobId: 'j' } });
    assert.equal(sent.find((r) => r.path.endsWith('/versions')).body.content.take.resolution, '1080p');
  });

  test('set_show_settings patches the show settings', async () => {
    const sent = stub({ 'PATCH /show-settings': { settings: { dialogueSeconds: 8 } } });
    const out = await run('manage_production', {
      projectId: 'p', action: 'set_show_settings', settings: { dialogueSeconds: 8, maxClipSeconds: null },
    });
    assert.equal(sent[0].path, '/api/v1/projects/p/show-settings');
    assert.deepEqual(sent[0].body, { dialogueSeconds: 8, maxClipSeconds: null });
    assert.deepEqual(out.settings, { dialogueSeconds: 8 });
  });

  // ezquill #450: the snapshot is read from the rule, never typed by the agent.
  test('override_rule snapshots the rule it names and sends the replacement', async () => {
    const sent = stub({
      'GET /entities/sal': { id: 'sal', name: 'Sal', metadata: { bible: { rules: [{ block: 'ANATOMY', text: 'Exactly two hooves.' }] } } },
      'POST /shot/overrides': (body) => ({ overrides: [body] }),
    });
    const out = await run('manage_production', {
      projectId: 'p', action: 'override_rule', nodeId: 's6', entityId: 'sal',
      rule: { block: 'anatomy' }, reason: 'the extra-arm gag', replacement: 'a third arm grows from his side',
    });
    const req = sent.find((r) => r.path.endsWith('/shot/overrides'));
    assert.equal(req.path, '/api/v1/projects/p/nodes/s6/shot/overrides');
    assert.deepEqual(req.body, {
      entityId: 'sal', block: 'ANATOMY', textAtOverride: 'Exactly two hooves.',
      reason: 'the extra-arm gag', replacement: 'a third arm grows from his side',
    });
    assert.equal(out.note, undefined);
  });

  test('override_rule asks which rule when the block holds several, and lists them when none match', async () => {
    stub({ 'GET /projects/p': { metadata: { showBible: { rules: [{ block: 'AUDIO', text: 'no music' }, { block: 'AUDIO', text: 'no SFX' }] } } } });
    await assert.rejects(
      run('manage_production', { projectId: 'p', action: 'override_rule', nodeId: 's', rule: { block: 'AUDIO' }, reason: 'r' }),
      /2 AUDIO rules; pass rule.text/
    );
    await assert.rejects(
      run('manage_production', { projectId: 'p', action: 'override_rule', nodeId: 's', rule: { block: 'EYES' }, reason: 'r' }),
      /no EYES rule/
    );
  });

  // A validating client checks `required` before the handler runs: with text
  // required there, override_rule by block alone never reached the server.
  test('the rule schema lets override_rule name a rule by block alone, and add_rule still needs text', async () => {
    const rule = tool('manage_production').inputSchema.properties.rule;
    assert.deepEqual(rule.required, ['block']);
    stub({});
    await assert.rejects(
      run('manage_production', { projectId: 'p', action: 'add_rule', rule: { block: 'EYES' } }),
      /needs rule.text/
    );
  });

  // ezquill #451: shot 5's trim could not be added to Ep. 5's cut — a second
  // POST is refused (one live cut per episode) and nothing gave the cut's id.
  test('record_cut extends the cut already there, keeping the other shots\' trims', async () => {
    const stored = {
      trims: [{ shotNodeId: 's4', takeId: 'v4', inSeconds: 0, outSeconds: 6 }, { shotNodeId: 's5', takeId: 'old', inSeconds: 0, outSeconds: 9 }],
      publishes: [],
      notes: 'kept',
    };
    const sent = stub({
      'GET /production-records': { records: [{ id: 'cut-1', kind: 'cut', nodeId: 'ep5', data: stored }] },
      'PATCH /production-records/cut-1': (body) => ({ id: 'cut-1', kind: 'cut', nodeId: 'ep5', data: body.data }),
    });
    const out = await run('manage_production', {
      projectId: 'p', action: 'record_cut', nodeId: 'ep5',
      data: { trims: [{ shotNodeId: 's5', takeId: 'v52', inSeconds: 0, outSeconds: 10 }] },
    });
    assert.equal(sent[0].query.get('kind'), 'cut');
    assert.ok(!sent.some((r) => r.method === 'POST'), 'no second cut');
    assert.equal(out.merged, true);
    assert.deepEqual(out.trims.map((t) => [t.shotNodeId, t.takeId]), [['s4', 'v4'], ['s5', 'v52']]);
    assert.equal(sent.at(-1).body.data.notes, 'kept');
  });

  test('record_cut creates the cut when the episode has none', async () => {
    const sent = stub({
      'GET /production-records': { records: [] },
      'POST /production-records': (body) => ({ id: 'cut-9', kind: body.kind, nodeId: body.nodeId }),
    });
    const out = await run('manage_production', { projectId: 'p', action: 'record_cut', nodeId: 'ep5', data: { trims: [], publishes: [] } });
    assert.deepEqual(out.recorded, { id: 'cut-9', kind: 'cut', nodeId: 'ep5' });
    assert.equal(sent.at(-1).method, 'POST');
  });

  // ezquill #458: the inline line diagnostic asked for a quote block that no
  // tool could make.
  test('mark_dialogue splits the line into its own quote block, drops the label and quotes, links the speaker', async () => {
    const doc = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
    const text = 'He stops. SAL: "And slop needs love too." Chris crosses behind.';
    const sent = stub({
      'GET /nodes': { nodes: [
        { id: 'b0', nodeType: 'block', order: 0, hasProse: true, content: { plainText: 'Before.', document: doc('Before.') } },
        { id: 'b1', nodeType: 'block', order: 1, hasProse: true, contentVersion: 3, content: { plainText: text, document: doc(text) } },
      ], hasMore: false },
      'PUT /blocks': (body) => ({ blocks: body.blocks, refused: [] }),
      'PUT /entities/sal': { role: 'speaker' },
    });
    const out = await run('manage_production', {
      projectId: 'p', action: 'mark_dialogue', nodeId: 's6', quote: 'SAL: "And slop needs love too."', speakerId: 'sal',
    });
    const put = sent.find((r) => r.method === 'PUT' && r.path.endsWith('/blocks'));
    const [b0, kept, line, after] = put.body.blocks;
    assert.deepEqual(b0, { id: 'b0' }, 'other paragraphs are sent back unchanged');
    assert.equal(kept.id, 'b1');
    assert.equal(kept.ifContentVersion, 3);
    assert.equal(kept.content.plainText, 'He stops.');
    assert.equal(line.content.document.content[0].type, 'blockquote');
    assert.equal(line.content.plainText, 'And slop needs love too.');
    assert.equal(after.content.plainText, 'Chris crosses behind.');
    assert.ok(sent.some((r) => r.method === 'PUT' && r.path.endsWith('/nodes/s6/entities/sal') && r.body.role === 'speaker'));
    assert.equal(out.marked, true);
  });

  test('mark_dialogue refuses a line already marked, and one that is not there', async () => {
    const quoted = { type: 'doc', content: [{ type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Huh.' }] }] }] };
    stub({ 'GET /nodes': { nodes: [{ id: 'b1', nodeType: 'block', order: 0, hasProse: true, content: { plainText: 'Huh.', document: quoted } }], hasMore: false } });
    await assert.rejects(run('manage_production', { projectId: 'p', action: 'mark_dialogue', nodeId: 's', quote: 'Huh.' }), /already a quote block/);
    await assert.rejects(run('manage_production', { projectId: 'p', action: 'mark_dialogue', nodeId: 's', quote: 'Nope.' }), /not in this shot/);
  });

  test('clear_override removes by block and owner', async () => {
    const sent = stub({ 'POST /shot/overrides/remove': { removed: 1, overrides: [] } });
    const out = await run('manage_production', {
      projectId: 'p', action: 'clear_override', nodeId: 's6', entityId: 'sal', rule: { block: 'ANATOMY' },
    });
    assert.deepEqual(sent[0].body, { entityId: 'sal', block: 'ANATOMY' });
    assert.equal(out.removed, 1);
  });

  // ezquill #446: a backfilled pointer string can be put right in place.
  test('update_take passes a prompt retraction through', async () => {
    const sent = stub({ 'PATCH /takes/v1': {} });
    await run('manage_production', {
      projectId: 'p', action: 'update_take', versionId: 'v1', patch: { promptRef: { tool: 'higgsfield', jobId: 'job-9' } },
    });
    assert.deepEqual(sent[0].body, { promptRef: { tool: 'higgsfield', jobId: 'job-9' } });
  });

  test('manage_entity refuses rules inside production, where nothing reads them', async () => {
    stub({});
    await assert.rejects(
      run('manage_entity', { projectId: 'p', action: 'update', entityId: 'sal', production: { rules: [] } }),
      /add_rule/
    );
  });

  // A whole cast was imported with look lines in profile, where the compiler
  // never looks; get_entity now says so, and returns the shipped kind's fields.
  test('get_entity returns rules, the shipped kind\'s fields, and what profile shadows', async () => {
    stub({
      'GET /entities/sal': {
        id: 'sal', name: 'Sal', kind: 'character', profile: { look: 'a pink pig' },
        metadata: { bible: { elementId: 'EL', rules: [{ block: 'EYES', text: 'black dots' }, { block: 'EARS', text: 'two', origin: 'agent' }] } },
      },
      '/api/video/production': {
        scope: 'show',
        show: { entityKinds: [{ kind: 'character', label: 'Character', fields: [{ key: 'role', label: 'Role', type: 'text' }], productionFields: [{ key: 'look', label: 'Look', type: 'longtext' }] }] },
      },
    });
    const out = await run('get_entity', { projectId: 'p', entityId: 'sal' });
    assert.deepEqual(out.rules, [{ block: 'EYES', text: 'black dots' }, { block: 'EARS', text: 'two', origin: 'agent' }]);
    assert.deepEqual(out.template.productionFields.map((f) => f.key), ['look']);
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /profile\.look is set but production\.look is not/);
  });
});
