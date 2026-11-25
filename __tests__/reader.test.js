import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS } from '../src/tools/index.js';
import { withRequest } from '../src/lib/request-context.js';
import { retry } from '../src/lib/api.js';
import { Code } from '../src/lib/errors.js';

const realSleep = retry.sleep;

const tool = (name) => TOOLS.find((t) => t.name === name);
const run = (name, args) => withRequest({ token: 't' }, () => tool(name).handler(args));

/**
 * Records every request with its HOST, so a test can tell the API from the
 * web app. A route answer may be `{ status, body }` to fail.
 */
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

const runRow = (over = {}) => ({
  id: 'r1', projectId: 'p', persona: 'genre', driver: 'ezquill', model: 'claude-sonnet-5', promptVersion: 1,
  status: 'in_progress', budgetCredits: 1000, plan: [], nextSeq: 3, total: 10, spentCredits: 45,
  unpricedCalls: 0, driving: false, createdAt: 'x', updatedAt: 'x', ...over,
});

const question = (over = {}) => ({
  id: 'q-id', runId: 'r1', key: 'q1', stableKey: 's1', text: 'Who sent the letter?', kind: 'mystery',
  raisedSeq: 0, raisedNodeId: 'n1', raisedQuote: 'a letter with no name', status: 'open', salience: 0.8,
  peakSalience: 0.9, lastTouchedSeq: 1, history: [{ seq: 0, nodeId: 'n1', salience: 0.9, status: 'open', touched: true }],
  updatedAt: 'x', ...over,
});

describe('get_reader_report', () => {
  test("is read-only and reads the route's report action, passing nodeId, persona and runId", async () => {
    assert.equal(tool('get_reader_report').annotations.readOnlyHint, true);
    const sent = stub({ 'POST /api/ai/first-reader': { readings: [] } });
    const out = await run('get_reader_report', { projectId: 'p', nodeId: 'n1', persona: 'casual', runId: 'r0' });
    // The web app's route, not Go's report: only the route knows what changed since (#918).
    assert.equal(sent.length, 1);
    assert.equal(sent[0].path, '/api/ai/first-reader');
    assert.notEqual(sent[0].host, 'api.ezquill.com');
    assert.deepEqual(sent[0].body, { action: 'report', projectId: 'p', persona: 'casual', nodeId: 'n1', runId: 'r0' });
    assert.deepEqual(out.readings, []);
    assert.match(out.about, /simulated/i);
  });

  test('sends only what it was given', async () => {
    const sent = stub({ 'POST /api/ai/first-reader': { readings: [] } });
    await run('get_reader_report', { projectId: 'p' });
    assert.deepEqual(sent[0].body, { action: 'report', projectId: 'p' });
  });

  test('a section changed since it was read is marked, with a note to say so', async () => {
    stub({
      'POST /api/ai/first-reader': {
        readings: [{
          persona: 'genre',
          run: runRow({ status: 'completed', nextSeq: 2, total: 2 }),
          summary: {
            units: [
              { seq: 0, nodeId: 'n1', part: 1, wordCount: 900, engagement: 4, openQuestions: 1, stale: false },
              { seq: 1, nodeId: 'n2', part: 1, wordCount: 1200, engagement: 2, openQuestions: 2, stale: true },
            ],
            unanswered: [], dormant: [], answered: 0, abandoned: 0,
          },
        }],
      },
    });
    const r = (await run('get_reader_report', { projectId: 'p' })).readings[0];
    assert.equal(r.summary.units[0].changedSinceRead, undefined, 'an unchanged unit carries no flag');
    assert.equal(r.summary.units[1].changedSinceRead, true);
    assert.match(r.changed, /earlier draft/);
  });

  test('one changed section: flagged on the section', async () => {
    stub({
      'POST /api/ai/first-reader': {
        readings: [{
          persona: 'casual',
          run: runRow({ persona: 'casual' }),
          node: { nodeId: 'n2', stale: true, snapshots: [{ seq: 1, nodeId: 'n2', part: 1, wordCount: 10, engagement: 3 }] },
        }],
      },
    });
    const r = (await run('get_reader_report', { projectId: 'p', nodeId: 'n2' })).readings[0];
    assert.equal(r.section.changedSinceRead, true);
    assert.match(r.changed, /earlier draft/);
  });

  test('nothing changed: no flag and no note', async () => {
    stub({
      'POST /api/ai/first-reader': {
        readings: [{ persona: 'casual', run: runRow(), node: { nodeId: 'n2', stale: false, snapshots: [] } }],
      },
    });
    const r = (await run('get_reader_report', { projectId: 'p', nodeId: 'n2' })).readings[0];
    assert.equal(r.section.changedSinceRead, undefined);
    assert.equal(r.changed, undefined);
  });

  test('a throttle is RATE_LIMITED, never "not found"', async () => {
    retry.sleep = async () => {};
    try {
      stub({ 'POST /api/ai/first-reader': { __status: 429, body: { error: 'Too many requests' } } });
      await assert.rejects(run('get_reader_report', { projectId: 'p' }), (err) => {
        assert.equal(err.code, Code.RATE_LIMITED);
        assert.match(err.message, /limiting how fast/);
        assert.match(err.message, /Nothing was done/);
        return true;
      });
    } finally {
      retry.sleep = realSleep;
    }
  });

  test('says it is simulated, in the description too', () => {
    assert.match(tool('get_reader_report').description, /simulated/i);
    assert.match(tool('get_reader_report').description, /not.*facts|never present them as facts/i);
  });

  test('the whole-book summary keeps the series and questions, without the bookkeeping', async () => {
    stub({
      'POST /api/ai/first-reader': {
        readings: [{
          persona: 'genre',
          run: runRow({ status: 'completed', nextSeq: 10 }),
          summary: {
            units: [{ seq: 0, nodeId: 'n1', part: 1, wordCount: 2000, engagement: 4, openQuestions: 2 }],
            unanswered: [question()],
            dormant: [question({ status: 'dormant', text: 'What of the dog?' })],
            answered: 3,
            abandoned: 1,
          },
        }],
      },
    });
    const out = await run('get_reader_report', { projectId: 'p' });
    const r = out.readings[0];
    assert.equal(r.run.readBy, 'ezQuill');
    assert.equal(r.run.progress, '10 of 10 read');
    assert.equal(r.run.spentCredits, 45);
    assert.deepEqual(r.summary.units[0], { seq: 0, nodeId: 'n1', words: 2000, engagement: 4, openQuestions: 2 });
    assert.equal(r.summary.unanswered[0].question, 'Who sent the letter?');
    assert.equal(r.summary.unanswered[0].raisedBy, 'a letter with no name');
    // The id manage_story_thread's link_reader_question takes (#915).
    assert.equal(r.summary.unanswered[0].questionId, 'q-id');
    assert.equal(r.summary.unanswered[0].history, undefined, 'per-unit history is left out');
    assert.equal(r.summary.dormant[0].status, 'dormant');
    assert.equal(r.summary.answered, 3);
    assert.equal(r.caveat, undefined);
  });

  test('one section: parts, predictions, confusions and its questions', async () => {
    stub({
      'POST /api/ai/first-reader': {
        readings: [{
          persona: 'casual',
          run: runRow({ persona: 'casual', driver: 'agent', model: 'agent:claude-opus-5-5', budgetCredits: undefined, spentCredits: 0 }),
          node: {
            nodeId: 'n2',
            snapshots: [{
              seq: 1, nodeId: 'n2', part: 1, wordCount: 1800, engagement: 2, engagementNote: 'Nothing moved.',
              predictions: [{ text: 'She will leave', quote: 'packed a bag' }], confusions: [{ text: 'Who is Tom?' }],
              memory: 'secret memory', state: { big: true }, droppedCount: 1,
            }],
            heldComingIn: [question()],
            raised: [],
            advanced: [],
            resolved: [question({ status: 'answered', resolvedNodeId: 'n2', resolution: 'Her father', resolutionQuote: 'signed, Dad' })],
            wentDormant: [],
          },
        }],
      },
    });
    const out = await run('get_reader_report', { projectId: 'p', nodeId: 'n2' });
    const r = out.readings[0];
    assert.equal(r.run.readBy, 'your agent (claude-opus-5-5)');
    assert.equal(r.run.spentCredits, undefined, 'an agent run spends nothing and shows no credits');
    assert.match(r.caveat, /can't check what this reader already knew/);
    const part = r.section.parts[0];
    assert.equal(part.engagement, 2);
    assert.deepEqual(part.predictions, [{ text: 'She will leave', quote: 'packed a bag' }]);
    assert.equal(part.memory, undefined);
    assert.equal(part.state, undefined);
    assert.equal(part.droppedCount, 1);
    assert.equal(r.section.resolved[0].resolvedBy, 'signed, Dad');
    assert.equal(r.section.heldComingIn.length, 1);
  });
});

describe('manage_first_reader', () => {
  test('says it spends credits and needs the writer to have asked', () => {
    const d = tool('manage_first_reader').description;
    assert.match(d, /SPENDS THE WRITER'S AI CREDITS/);
    assert.match(d, /writer asked/);
    assert.equal(tool('manage_first_reader').annotations.readOnlyHint, false);
  });

  test('estimate posts to the web app route and answers in credits', async () => {
    const sent = stub({
      'POST /api/ai/first-reader': {
        unitCount: 12, reusedCount: 2, toReadCount: 10, words: 30000, defaultBudgetCredits: 1000,
        estimate: { model: 'claude-sonnet-5', inputTokens: 1, maxOutputTokens: 1, priced: true, credits: { min: 90, max: 160 }, remainingCredits: 5000, limitedBy: 'plan', fits: true },
      },
    });
    const out = await run('manage_first_reader', { projectId: 'p', action: 'estimate', persona: 'genre' });
    assert.equal(sent[0].host, 'ezquill.com');
    assert.equal(sent[0].path, '/api/ai/first-reader');
    assert.deepEqual(sent[0].body, { action: 'estimate', projectId: 'p', persona: 'genre' });
    assert.deepEqual(out.credits, { min: 90, max: 160 });
    assert.equal(out.toRead, 10);
    assert.equal(out.fits, true);
    assert.ok(!JSON.stringify(out).includes('usd'), 'no dollars');
  });

  test('an estimate with nothing to read says it spends nothing', async () => {
    stub({ 'POST /api/ai/first-reader': { unitCount: 3, reusedCount: 3, toReadCount: 0, words: 0, defaultBudgetCredits: 1000, estimate: null } });
    const out = await run('manage_first_reader', { projectId: 'p', action: 'estimate', persona: 'casual' });
    assert.deepEqual(out.credits, { min: 0, max: 0 });
    assert.match(out.note, /spends nothing/);
  });

  test('refuses an unknown persona before calling anything', async () => {
    const sent = stub({});
    await assert.rejects(run('manage_first_reader', { projectId: 'p', action: 'start', persona: 'critic' }), /persona/);
    assert.equal(sent.length, 0);
  });

  test('start sends the ezquill driver and the budget, and returns progress', async () => {
    const sent = stub({ 'POST /api/ai/first-reader': { run: runRow({ nextSeq: 2 }), read: 2, stopped: 'time' } });
    const out = await run('manage_first_reader', { projectId: 'p', action: 'start', persona: 'genre', budgetCredits: 500 });
    assert.deepEqual(sent[0].body, { action: 'start', projectId: 'p', persona: 'genre', driver: 'ezquill', budgetCredits: 500 });
    assert.equal(out.read, 2);
    assert.equal(out.run.progress, '2 of 10 read');
    assert.match(out.next, /continue/);
  });

  test('continue is one advance call for the named run', async () => {
    const sent = stub({ 'POST /api/ai/first-reader': { run: runRow({ status: 'completed', nextSeq: 10 }), read: 1, stopped: 'done' } });
    const out = await run('manage_first_reader', { projectId: 'p', action: 'continue', runId: 'r1' });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].body, { action: 'advance', projectId: 'p', runId: 'r1' });
    assert.match(out.next, /finished/);
  });

  test('continue without a runId finds the open ezQuill run', async () => {
    const sent = stub({
      'GET /reader-runs': { items: [runRow({ id: 'agent-run', driver: 'agent' }), runRow({ id: 'r7', status: 'paused', pauseReason: 'budget' }), runRow({ id: 'old', status: 'completed' })] },
      'POST /api/ai/first-reader': { run: runRow({ id: 'r7' }), read: 1, stopped: 'time' },
    });
    await run('manage_first_reader', { projectId: 'p', action: 'continue', budgetCredits: 2000 });
    assert.equal(sent[0].path, '/api/v1/projects/p/reader-runs');
    assert.deepEqual(sent[1].body, { action: 'advance', projectId: 'p', runId: 'r7', budgetCredits: 2000 });
  });

  test('a cap pause carries the refusal and says not to retry', async () => {
    stub({
      'POST /api/ai/first-reader': {
        run: runRow({ status: 'paused', pauseReason: 'cap' }), read: 0, stopped: 'cap', message: 'Over the limit',
        refusal: { code: 'plan_cap', nextReturn: '2026-12-01' },
      },
    });
    const out = await run('manage_first_reader', { projectId: 'p', action: 'continue', runId: 'r1' });
    assert.equal(out.refusal.code, 'plan_cap');
    assert.equal(out.run.pauseReason, 'cap');
    assert.match(out.next, /do not retry/);
  });

  test('cancel goes to the API, not the route', async () => {
    const sent = stub({ 'POST /cancel': runRow({ status: 'cancelled' }) });
    const out = await run('manage_first_reader', { projectId: 'p', action: 'cancel', runId: 'r1' });
    assert.equal(sent[0].path, '/api/v1/projects/p/reader-runs/r1/cancel');
    assert.equal(sent[0].host, 'api.ezquill.com');
    assert.equal(out.cancelled, true);
    assert.equal(out.run.status, 'cancelled');
  });
});

describe('read_as_first_reader', () => {
  test('the description asks for a fresh subagent, no other tools, no reading ahead, and the schema', () => {
    const d = tool('read_as_first_reader').description;
    assert.match(d, /FRESH subagent or conversation/);
    assert.match(d, /NO other ezQuill tool/);
    assert.match(d, /never read ahead/);
    assert.match(d, /schema/);
    assert.match(d, /no ezQuill credits/i);
  });

  test('start creates an agent run with the reported model and no budget', async () => {
    const sent = stub({
      'POST /api/ai/first-reader': { run: runRow({ driver: 'agent', model: 'agent:claude-opus-5-5', budgetCredits: undefined, nextSeq: 0 }), read: 0 },
    });
    const out = await run('read_as_first_reader', { projectId: 'p', action: 'start', persona: 'casual', model: 'claude-opus-5-5' });
    assert.deepEqual(sent[0].body, { action: 'start', projectId: 'p', persona: 'casual', driver: 'agent', model: 'claude-opus-5-5' });
    assert.ok(!('budgetCredits' in sent[0].body));
    assert.equal(out.run.readBy, 'your agent (claude-opus-5-5)');
    assert.match(out.next, /fresh subagent/);
    assert.match(out.caveat, /already knew/);
  });

  test('next returns exactly one unit with its instructions, schema and token', async () => {
    const sent = stub({
      'POST /api/ai/first-reader': {
        runId: 'r1', seq: 4, leaseToken: 'tok', leaseUntil: 'soon',
        reading: { instructions: 'You are a reader', reading: 'Chapter 5\n\nProse.', schema: { type: 'object' }, promptVersion: 2, progress: { seq: 4, total: 10 } },
      },
    });
    const out = await run('read_as_first_reader', { projectId: 'p', action: 'next', runId: 'r1', leaseToken: 'tok' });
    assert.deepEqual(sent[0].body, { action: 'next', projectId: 'p', runId: 'r1', leaseToken: 'tok' });
    assert.equal(out.seq, 4);
    assert.equal(out.leaseToken, 'tok');
    assert.equal(out.progress, 'section 5 of 10');
    assert.equal(out.instructions, 'You are a reader');
    assert.equal(out.reading, 'Chapter 5\n\nProse.');
    assert.deepEqual(out.schema, { type: 'object' });
  });

  test('next without a token, refused because another session holds it, takes it over once', async () => {
    const sent = stub({
      'POST /api/ai/first-reader': (body) =>
        body.takeOver
          ? { runId: 'r1', seq: 4, leaseToken: 'new', leaseUntil: 'soon', reading: { progress: { seq: 4, total: 10 } } }
          : {
              __status: 409,
              body: {
                error: 'this reading is being read right now in another session; try again in a few minutes, or take it over if that session was yours and is gone',
                code: 'conflict',
              },
            },
    });
    const out = await run('read_as_first_reader', { projectId: 'p', action: 'next', runId: 'r1' });
    assert.equal(sent.length, 2);
    assert.equal(sent[0].body.takeOver, undefined, 'the first ask does not take over');
    assert.deepEqual(sent[1].body, { action: 'next', projectId: 'p', runId: 'r1', takeOver: true });
    assert.equal(out.leaseToken, 'new');
    assert.equal(out.seq, 4);
    assert.match(out.tookOver, /yours again/);
  });

  test('next WITH a token never takes over: that session may still be alive', async () => {
    const sent = stub({
      'POST /api/ai/first-reader': { __status: 409, body: { error: 'this reading is being read right now in another session; try again in a few minutes' } },
    });
    await assert.rejects(
      run('read_as_first_reader', { projectId: 'p', action: 'next', runId: 'r1', leaseToken: 'old' }),
      (err) => err.code === Code.STALE_CONTENT && /another session/.test(err.message)
    );
    assert.equal(sent.length, 1);
  });

  test('next does not take over for any other refusal', async () => {
    const sent = stub({ 'POST /api/ai/first-reader': { __status: 409, body: { error: 'this reading is cancelled, so it cannot go on' } } });
    await assert.rejects(run('read_as_first_reader', { projectId: 'p', action: 'next', runId: 'r1' }), /cancelled/);
    assert.equal(sent.length, 1);
  });

  test("a takeover the server refuses (not the reading's starter) comes back as that refusal", async () => {
    const sent = stub({
      'POST /api/ai/first-reader': (body) =>
        body.takeOver
          ? { __status: 403, body: { error: 'only the person who started this reading can take it over from another session' } }
          : { __status: 409, body: { error: 'this reading is being read right now in another session' } },
    });
    await assert.rejects(
      run('read_as_first_reader', { projectId: 'p', action: 'next', runId: 'r1' }),
      (err) => err.code === Code.FORBIDDEN_SCOPE && /only the person who started/.test(err.message)
    );
    assert.equal(sent.length, 2);
  });

  test('next at the end says done', async () => {
    stub({ 'POST /api/ai/first-reader': { run: runRow({ driver: 'agent', status: 'completed', nextSeq: 10 }), done: true } });
    const out = await run('read_as_first_reader', { projectId: 'p', action: 'next', runId: 'r1' });
    assert.equal(out.done, true);
  });

  test('next without a runId uses the open agent run, not the ezQuill one', async () => {
    const sent = stub({
      'GET /reader-runs': { items: [runRow({ id: 'ez' }), runRow({ id: 'ag', driver: 'agent', persona: 'casual' })] },
      'POST /api/ai/first-reader': { runId: 'ag', seq: 0, leaseToken: 't', reading: { progress: { seq: 0, total: 1 } } },
    });
    await run('read_as_first_reader', { projectId: 'p', action: 'next' });
    assert.equal(sent[1].body.runId, 'ag');
  });

  test('submit sends the answer to the route and hands back the renewed token', async () => {
    const answer = { engagement: 4, engagementNote: 'Hooked.', memory: 'A letter came.' };
    const sent = stub({
      'POST /api/ai/first-reader': { run: runRow({ driver: 'agent', nextSeq: 5 }), seq: 4, droppedCount: 0, repairedCount: 1, leaseToken: 'tok' },
    });
    const out = await run('read_as_first_reader', { projectId: 'p', action: 'submit', runId: 'r1', seq: 4, leaseToken: 'tok', answer });
    assert.deepEqual(sent[0].body, { action: 'submit', projectId: 'p', runId: 'r1', seq: 4, leaseToken: 'tok', answer });
    assert.equal(out.accepted, true);
    assert.equal(out.leaseToken, 'tok');
    assert.equal(out.repairedCount, 1);
    assert.match(out.next, /next/);
  });

  test('a refused answer comes back with its errors to fix, not as a failure', async () => {
    stub({
      'POST /api/ai/first-reader': {
        __status: 422,
        body: { error: 'The answer could not be used. Fix these and submit it again.', errors: ['engagement must be a number from 1 to 5.'], leaseToken: 'tok2' },
      },
    });
    const out = await run('read_as_first_reader', { projectId: 'p', action: 'submit', runId: 'r1', seq: 4, leaseToken: 'tok', answer: {} });
    assert.equal(out.accepted, false);
    assert.deepEqual(out.errors, ['engagement must be a number from 1 to 5.']);
    assert.equal(out.leaseToken, 'tok2');
  });

  test('a submit for the wrong section is an error', async () => {
    stub({ 'POST /api/ai/first-reader': { __status: 409, body: { error: 'Section 5 is not the next one to read', leaseToken: 'tok' } } });
    await assert.rejects(
      run('read_as_first_reader', { projectId: 'p', action: 'submit', runId: 'r1', seq: 4, leaseToken: 'tok', answer: {} }),
      /not the next one/
    );
  });

  test('submit refuses a call missing its token or seq before calling anything', async () => {
    const sent = stub({});
    await assert.rejects(run('read_as_first_reader', { projectId: 'p', action: 'submit', runId: 'r1', answer: {} }), /leaseToken/);
    await assert.rejects(run('read_as_first_reader', { projectId: 'p', action: 'submit', runId: 'r1', seq: 0, leaseToken: 't' }), /answer/);
    assert.equal(sent.length, 0);
  });

  test('cancel goes to the API', async () => {
    const sent = stub({ 'POST /cancel': runRow({ driver: 'agent', status: 'cancelled' }) });
    await run('read_as_first_reader', { projectId: 'p', action: 'cancel', runId: 'r1' });
    assert.equal(sent[0].path, '/api/v1/projects/p/reader-runs/r1/cancel');
  });
});
