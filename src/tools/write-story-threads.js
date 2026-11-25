/**
 * Changing a story's threads (ezquill epic #71, task #915; plan §9 and §10.7).
 *
 * # An agent's thread is a PROPOSAL
 *
 * "Nothing real without author approval." A thread an agent invents joins the
 * writer's map, its alerts and its load chart, and would look like something
 * the writer decided. So manage_story_thread and add_thread_touch never create
 * a row: they write proposals through the API's one door for every source,
 * `POST …/story-thread-proposals/batch`, with source `connector`. The server
 * computes the dedupe key and evidence fingerprint, so an agent cannot bring
 * back what the writer dismissed by rewording it. The writer accepts in
 * ezQuill. This is write_draft's `revise` rule, applied to threads.
 *
 * There is no proposal kind that edits or deletes an existing thread (the API
 * has new_thread, new_touch, link_reader_question and merge_threads), so this
 * tool offers no edit and no delete rather than doing either directly, which
 * would be the real write this file exists to avoid.
 *
 * # review_thread_proposal DOES change things
 *
 * Deciding a proposal is the writer's act, and this tool performs it for them.
 * It exists because a writer working through an agent may say "accept the
 * three clues in chapter 2", and the description is the only lever that keeps
 * an agent from deciding on its own: it says, in so many words, only when the
 * writer asked. Every decision is undoable (`undo`), and an Undo that would
 * throw away the writer's later edits is refused by the API with a 409.
 */
import { call } from '../lib/api.js';
import { ToolError, Code } from '../lib/errors.js';
import {
  KINDS, PROPOSAL_KINDS, PROPOSAL_SOURCES, SCOPES, TOUCH_TYPES, WEIGHTS,
  proposalView, proposedTouch, sendProposals,
} from '../lib/story-threads.js';

const TOUCH_SCHEMA = {
  type: 'object',
  properties: {
    nodeId: { type: 'string', description: 'The section (scene or chapter) the touch is in.' },
    type: { type: 'string', enum: TOUCH_TYPES, description: 'What this place does to the thread.' },
    quote: {
      type: 'string',
      description:
        'The exact words, as read_scene returned them, inside one paragraph and occurring once in the section.',
    },
    planned: { type: 'boolean', description: 'Not written yet: the writer means to put it here. No quote.' },
    note: { type: 'string' },
  },
  required: ['nodeId', 'type'],
};

/** The evidence a connector proposal stands on: its quotes and its reason. */
function evidence(quotes, rationale) {
  const out = {};
  if (quotes.length) out.quotes = quotes;
  if (rationale?.trim()) out.rationale = rationale.trim();
  return out;
}

async function placeTouches(projectId, touches) {
  const placed = [];
  const quotes = [];
  for (const t of touches ?? []) {
    const { touch, quote } = await proposedTouch(projectId, t);
    placed.push(touch);
    if (quote) quotes.push(quote);
  }
  return { placed, quotes };
}

const need = (value, message, field) => {
  if (value === undefined || value === null || value === '') {
    throw new ToolError(Code.REQUEST_FAILED, message, field ? { field } : undefined);
  }
};

const manageStoryThread = {
  name: 'manage_story_thread',
  description:
    'PROPOSE a story thread: a question the story makes the reader want answered. These are PROPOSALS the writer ' +
    'accepts or dismisses in ezQuill, never changes: nothing appears on their map until they accept. Report them as ' +
    'proposals waiting for the writer, never as threads you added. create (title, question, kind; weight, scope, ' +
    'tags, entityIds, readerQuestionIds, touches): a new thread with the places that move it. merge (storyThreadId ' +
    'into intoStoryThreadId): two threads that ask the same question. link_reader_question (storyThreadId, ' +
    "readerQuestionId from get_reader_report): a first reader's question is this thread. Give a rationale. Read the " +
    'threads first (list_story_threads), and do not re-propose what the writer dismissed. There is no edit or delete: ' +
    'those are the writer\'s, in ezQuill.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string' },
      action: { type: 'string', enum: ['create', 'merge', 'link_reader_question'] },
      title: { type: 'string', description: 'create: a short name ("The poisoned well").' },
      question: { type: 'string', description: 'create: the question itself ("Who poisoned the well?").' },
      kind: { type: 'string', enum: KINDS, description: 'create: MICE kind.' },
      weight: { type: 'string', enum: WEIGHTS, description: 'create: default minor.' },
      scope: { type: 'string', enum: SCOPES, description: 'create: how far it runs; default book.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'create: e.g. mystery, relationship.' },
      entityIds: { type: 'array', items: { type: 'string' }, description: 'create: who or what it is about.' },
      readerQuestionIds: { type: 'array', items: { type: 'string' }, description: "create: a first reader's questions it answers to." },
      touches: { type: 'array', items: TOUCH_SCHEMA, description: 'create: where it opens, turns and pays off.' },
      storyThreadId: { type: 'string', description: 'merge: the thread merged away. link_reader_question: the thread.' },
      intoStoryThreadId: { type: 'string', description: 'merge: the thread that remains.' },
      readerQuestionId: { type: 'string', description: 'link_reader_question: the question (questionId in get_reader_report).' },
      rationale: { type: 'string', description: 'Why, in a sentence or two. The writer reads it.' },
    },
    required: ['projectId', 'action'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false },

  async handler(args) {
    const { projectId, action } = args;
    switch (action) {
      case 'create': {
        need(args.title, 'create needs a title.', 'title');
        need(args.question, 'create needs the question the thread asks.', 'question');
        need(args.kind, `create needs a kind: ${KINDS.join(', ')}.`, 'kind');
        const { placed, quotes } = await placeTouches(projectId, args.touches);
        const thread = { title: args.title, question: args.question, kind: args.kind };
        if (args.weight) thread.weight = args.weight;
        if (args.scope) thread.scope = args.scope;
        if (args.tags?.length) thread.tags = args.tags;
        const payload = { thread };
        if (placed.length) payload.touches = placed;
        if (args.entityIds?.length) payload.entityIds = args.entityIds;
        if (args.readerQuestionIds?.length) payload.readerQuestionIds = args.readerQuestionIds;
        return sendProposals(projectId, [{ kind: 'new_thread', payload, evidence: evidence(quotes, args.rationale) }]);
      }
      case 'merge': {
        need(args.storyThreadId, 'merge needs storyThreadId: the thread merged away.', 'storyThreadId');
        need(args.intoStoryThreadId, 'merge needs intoStoryThreadId: the thread that remains.', 'intoStoryThreadId');
        return sendProposals(projectId, [{
          kind: 'merge_threads',
          targetStoryThreadId: args.intoStoryThreadId,
          payload: { storyThreadId: args.storyThreadId },
          evidence: evidence([], args.rationale),
        }]);
      }
      case 'link_reader_question': {
        need(args.storyThreadId, 'link_reader_question needs storyThreadId.', 'storyThreadId');
        need(args.readerQuestionId, 'link_reader_question needs readerQuestionId.', 'readerQuestionId');
        return sendProposals(projectId, [{
          kind: 'link_reader_question',
          targetStoryThreadId: args.storyThreadId,
          readerQuestionId: args.readerQuestionId,
          payload: {},
          evidence: evidence([], args.rationale),
        }]);
      }
      default:
        throw new ToolError(Code.REQUEST_FAILED, `Unknown action: ${action}`);
    }
  },
};

const addThreadTouch = {
  name: 'add_thread_touch',
  description:
    'PROPOSE a touch: a place in the manuscript that moves an existing story thread (opens it, drops a clue, ' +
    'complicates, raises the stakes, reminds, partly or fully pays it off, or subverts it). A PROPOSAL the writer ' +
    'accepts in ezQuill, not a change: report it as one. Quote the exact words (inside one paragraph, occurring once ' +
    'in the section) so the writer sees where, or mark it planned for a touch not written yet. Read the scene first.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string' },
      storyThreadId: { type: 'string' },
      ...TOUCH_SCHEMA.properties,
      rationale: { type: 'string', description: 'Why this place moves the thread. The writer reads it.' },
    },
    required: ['projectId', 'storyThreadId', 'nodeId', 'type'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false },

  async handler(args) {
    const { projectId, storyThreadId } = args;
    need(storyThreadId, 'add_thread_touch needs the storyThreadId it moves.', 'storyThreadId');
    const { touch, quote } = await proposedTouch(projectId, args);
    return sendProposals(projectId, [{
      kind: 'new_touch',
      targetStoryThreadId: storyThreadId,
      payload: { touches: [touch] },
      evidence: evidence(quote ? [quote] : [], args.rationale),
    }]);
  },
};

/** Thread fields an edit-then-accept may change. */
const THREAD_FIELDS = ['title', 'question', 'kind', 'weight', 'scope', 'tags'];

/**
 * Edit-then-accept sends a FULL payload of the proposal's kind, validated
 * whole, so the edit is applied to the payload read back from the server
 * rather than sent as a fragment: a fragment would drop every touch and link
 * the agent did not mention.
 */
async function editedProposal(projectId, proposalId, edit) {
  const p = await call(`/projects/${projectId}/story-thread-proposals/${proposalId}`);
  const payload = structuredClone(p.payload ?? {});
  const threadEdits = Object.fromEntries(THREAD_FIELDS.filter((k) => edit[k] !== undefined).map((k) => [k, edit[k]]));
  if (Object.keys(threadEdits).length) {
    if (!payload.thread) {
      throw new ToolError(Code.REQUEST_FAILED, `A ${p.kind} proposal has no thread fields to edit.`);
    }
    payload.thread = { ...payload.thread, ...threadEdits };
  }
  if (edit.touchType !== undefined || edit.touchNote !== undefined) {
    if (p.kind !== 'new_touch') {
      throw new ToolError(Code.REQUEST_FAILED, 'touchType and touchNote edit a new_touch proposal only.');
    }
    const [touch] = payload.touches ?? [];
    payload.touches = [{
      ...touch,
      ...(edit.touchType !== undefined ? { type: edit.touchType } : {}),
      ...(edit.touchNote !== undefined ? { note: edit.touchNote } : {}),
    }];
  }
  const out = { payload };
  if (edit.targetStoryThreadId) out.targetStoryThreadId = edit.targetStoryThreadId;
  return out;
}

const reviewThreadProposal = {
  name: 'review_thread_proposal',
  description:
    "Decide story-thread proposals FOR THE WRITER. Unlike the proposing tools, this CHANGES their story: an accepted " +
    'proposal becomes real threads and touches on their map. Use it ONLY when the writer has asked you to decide ' +
    'specific proposals (list_thread_proposals first, and confirm which); never accept your own proposals on your own ' +
    'initiative. accept (proposalId, or proposalIds, or a selector: source / kind / storyThreadId for every pending ' +
    'match). edit_accept (proposalId, edit): accept with the writer\'s changes. dismiss (same targets; reason). restore ' +
    '(a dismissed one back to pending). merge (proposalIds into intoStoryThreadId, or into the pending new-thread ' +
    'proposal intoProposalId). undo (proposalId or decisionBatchId from the answer): refused if the writer has since ' +
    'edited what it made.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string' },
      action: { type: 'string', enum: ['accept', 'edit_accept', 'dismiss', 'restore', 'merge', 'undo'] },
      proposalId: { type: 'string' },
      proposalIds: { type: 'array', items: { type: 'string' } },
      source: { type: 'string', enum: PROPOSAL_SOURCES, description: 'Bulk accept or dismiss: every pending proposal from this source.' },
      kind: { type: 'string', enum: PROPOSAL_KINDS, description: 'Bulk: every pending proposal of this kind.' },
      storyThreadId: { type: 'string', description: 'Bulk: every pending proposal for this thread.' },
      edit: {
        type: 'object',
        description: 'edit_accept: what to change before accepting.',
        properties: {
          title: { type: 'string' },
          question: { type: 'string' },
          kind: { type: 'string', enum: KINDS },
          weight: { type: 'string', enum: WEIGHTS },
          scope: { type: 'string', enum: SCOPES },
          tags: { type: 'array', items: { type: 'string' } },
          targetStoryThreadId: { type: 'string', description: 'Use this existing thread instead.' },
          touchType: { type: 'string', enum: TOUCH_TYPES, description: 'new_touch only.' },
          touchNote: { type: 'string', description: 'new_touch only.' },
        },
      },
      reason: { type: 'string', description: "dismiss: the writer's reason." },
      intoStoryThreadId: { type: 'string', description: 'merge: an existing thread.' },
      intoProposalId: { type: 'string', description: 'merge: a pending new-thread proposal.' },
      decisionBatchId: { type: 'string', description: 'undo: a whole earlier decision.' },
    },
    required: ['projectId', 'action'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false },

  async handler(args) {
    const { projectId, action } = args;
    const base = `/projects/${projectId}/story-thread-proposals`;

    if (action === 'undo') {
      if (!args.proposalId === !args.decisionBatchId) {
        throw new ToolError(Code.REQUEST_FAILED, 'undo needs exactly one of proposalId or decisionBatchId.');
      }
      const body = await call(`${base}/undo`, {
        method: 'POST',
        body: args.proposalId ? { proposalId: args.proposalId } : { decisionBatchId: args.decisionBatchId },
      });
      return {
        proposals: (body?.proposals ?? []).map(proposalView),
        status: 'Undone for the writer: these proposals are pending again, and anything an accept made is removed.',
      };
    }

    if (!['accept', 'edit_accept', 'dismiss', 'restore', 'merge'].includes(action)) {
      throw new ToolError(Code.REQUEST_FAILED, `Unknown action: ${action}`);
    }

    const ids = [...(args.proposalIds ?? []), ...(args.proposalId ? [args.proposalId] : [])];
    const selector = {};
    if (args.source) selector.source = args.source;
    if (args.kind) selector.kind = args.kind;
    if (args.storyThreadId) selector.storyThreadId = args.storyThreadId;
    const bulk = Object.keys(selector).length > 0;

    if (ids.length === 0 && !bulk) {
      throw new ToolError(Code.REQUEST_FAILED, `${action} needs proposalId, proposalIds, or a source / kind / storyThreadId selector.`);
    }
    if (ids.length > 0 && bulk) {
      throw new ToolError(Code.REQUEST_FAILED, 'Give either proposal ids or a selector, not both.');
    }
    if (bulk && !['accept', 'dismiss'].includes(action)) {
      throw new ToolError(Code.REQUEST_FAILED, 'A selector works for accept and dismiss only; name the proposals.');
    }

    const body = ids.length ? { proposalIds: ids } : { ...selector };
    switch (action) {
      case 'accept':
        body.action = 'accept';
        break;
      case 'edit_accept':
        if (ids.length !== 1) throw new ToolError(Code.REQUEST_FAILED, 'edit_accept takes exactly one proposalId.');
        if (!args.edit || Object.keys(args.edit).length === 0) {
          throw new ToolError(Code.REQUEST_FAILED, 'edit_accept needs edit: what to change. To accept as it is, use accept.');
        }
        body.action = 'accept';
        body.edit = await editedProposal(projectId, ids[0], args.edit);
        break;
      case 'dismiss':
        body.action = 'dismiss';
        if (args.reason?.trim()) body.reason = args.reason.trim();
        break;
      case 'restore':
        body.action = 'restore';
        break;
      case 'merge':
        if (!args.intoStoryThreadId === !args.intoProposalId) {
          throw new ToolError(Code.REQUEST_FAILED, 'merge needs exactly one of intoStoryThreadId or intoProposalId.');
        }
        body.action = 'merge';
        if (args.intoStoryThreadId) body.intoStoryThreadId = args.intoStoryThreadId;
        if (args.intoProposalId) body.intoProposalId = args.intoProposalId;
        break;
    }

    const result = await call(`${base}/decide`, { method: 'POST', body });
    return {
      decisionBatchId: result?.decisionBatchId,
      proposals: (result?.proposals ?? []).map(proposalView),
      ...(result?.skipped?.length ? { skipped: result.skipped } : {}),
      status:
        `Done for the writer (${action.replace('_', ' ')}). Tell them what you decided; ` +
        'undo with this decisionBatchId reverses the whole decision.',
    };
  },
};

export const tools = [manageStoryThread, addThreadTouch, reviewThreadProposal];
