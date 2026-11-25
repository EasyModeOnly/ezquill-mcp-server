/**
 * What the story-thread tools share (ezquill epic #71, task #915).
 *
 * Named story_thread throughout, never bare "thread": ezQuill already has
 * comment threads (list_feedback) and chat threads, and a tool called
 * list_threads would be read as either.
 *
 * The views here TRIM, they never derive. Status, load, dormancy and alerts
 * are computed once, in Go, by the map-data endpoint, and the app, the alerts
 * list and get_thread_map_data all read that one answer. Re-deriving any of it
 * here would be a second opinion that drifts from the writer's screen.
 */
import { call } from './api.js';
import { ToolError, Code } from './errors.js';
import { locateQuote } from './quote-target.js';

export const KINDS = ['milieu', 'idea', 'character', 'event'];
export const WEIGHTS = ['main', 'major', 'minor'];
export const SCOPES = ['scene', 'chapter', 'book', 'series'];
export const TOUCH_TYPES = [
  'open', 'clue', 'complicate', 'raise_stakes', 'remind', 'partial_payoff', 'payoff', 'subvert',
];
export const PROPOSAL_KINDS = ['new_thread', 'new_touch', 'link_reader_question', 'merge_threads'];
export const PROPOSAL_STATES = ['pending', 'accepted', 'merged', 'dismissed'];
export const PROPOSAL_SOURCES = ['reader', 'prose_pass', 'structural', 'connector'];

/** Every proposal this connector writes carries this source (plan §10.7). */
export const CONNECTOR_SOURCE = 'connector';

/** One thread, as an agent needs it. Status is not here: it is map-data's. */
export function threadView(t) {
  const out = {
    id: t.id,
    title: t.title,
    question: t.question,
    kind: t.kind,
    weight: t.weight,
    scope: t.scope,
    tags: t.tags ?? [],
    owner: t.seriesId ? 'series' : 'project',
    origin: t.origin,
    entities: t.entities ?? [],
  };
  if (t.parentStoryThreadId) out.parentStoryThreadId = t.parentStoryThreadId;
  if (t.mergedIntoStoryThreadId) out.mergedIntoStoryThreadId = t.mergedIntoStoryThreadId;
  if (t.statusOverride) {
    out.statusOverride = { status: t.statusOverride.status, ...(t.statusOverride.note ? { note: t.statusOverride.note } : {}) };
  }
  if (t.deletedAt) out.deleted = true;
  return out;
}

/** One touch: where, the words it quotes, and every thread it moves. */
export function touchView(t) {
  const out = {
    id: t.id,
    nodeId: t.nodeId,
    planned: t.planned,
    storyThreads: (t.storyThreads ?? []).map((l) => ({ storyThreadId: l.storyThreadId, type: l.type })),
    origin: t.origin,
  };
  if (t.anchor?.text) out.quote = t.anchor.text;
  if (t.note) out.note = t.note;
  if ((t.storyThreads ?? []).length > 1) out.interchange = true;
  if (t.deletedAt) out.deleted = true;
  return out;
}

/** One proposal, as the review list shows it, without the dedupe bookkeeping. */
export function proposalView(p) {
  const out = {
    id: p.id,
    source: p.source,
    kind: p.kind,
    state: p.state,
    payload: p.payload,
  };
  if (p.targetStoryThreadId) out.targetStoryThreadId = p.targetStoryThreadId;
  if (p.readerQuestionId) out.readerQuestionId = p.readerQuestionId;
  const e = p.evidence ?? {};
  const evidence = {};
  if (e.rationale) evidence.rationale = e.rationale;
  if (e.quotes?.length) evidence.quotes = e.quotes;
  if (e.nodeIds?.length) evidence.nodeIds = e.nodeIds;
  if (e.readerQuestionKeys?.length) evidence.readerQuestionKeys = e.readerQuestionKeys;
  if (e.confidence !== undefined && e.confidence !== null) evidence.confidence = e.confidence;
  if (Object.keys(evidence).length) out.evidence = evidence;
  if (p.dismissCount) out.dismissCount = p.dismissCount;
  if (p.dismissReason) out.dismissReason = p.dismissReason;
  if (p.reopened) out.reopened = { newUnitIds: p.newUnitIds ?? [] };
  if (p.resultStoryThreadId) out.resultStoryThreadId = p.resultStoryThreadId;
  if (p.resultTouchIds?.length) out.resultTouchIds = p.resultTouchIds;
  if (p.mergedIntoProposalId) out.mergedIntoProposalId = p.mergedIntoProposalId;
  if (p.decisionBatchId) out.decisionBatchId = p.decisionBatchId;
  if (p.decidedAt) out.decidedAt = p.decidedAt;
  return out;
}

/**
 * A touch as proposed. With a quote, the quote is placed by the one rule
 * write_draft's revise uses (exactly once in the section, inside one
 * paragraph) and the touch moves onto the paragraph it is in, since the API
 * anchors a quote only on a block. A section whose prose is not in blocks
 * cannot carry an anchor: the touch stays on the section and the quote is
 * kept as evidence, so the writer still sees the words.
 *
 * @returns {Promise<{ touch: object, quote?: {nodeId: string, text: string} }>}
 */
export async function proposedTouch(projectId, t) {
  if (!t?.nodeId) throw new ToolError(Code.REQUEST_FAILED, 'Each touch needs the nodeId of the section it is in.');
  if (!TOUCH_TYPES.includes(t.type)) {
    throw new ToolError(Code.REQUEST_FAILED, `A touch's type must be one of ${TOUCH_TYPES.join(', ')}.`, { field: 'type' });
  }
  const touch = { nodeId: t.nodeId, type: t.type };
  if (t.note?.trim()) touch.note = t.note.trim();
  if (t.planned) {
    if (t.quote) {
      throw new ToolError(
        Code.REQUEST_FAILED,
        'A planned touch has no prose to quote yet. Drop the quote, or drop planned if the words are written.'
      );
    }
    touch.planned = true;
    return { touch };
  }
  if (!t.quote) return { touch };

  const { target, anchor, inBlock } = await locateQuote(projectId, t.nodeId, t.quote);
  if (inBlock) {
    touch.nodeId = target;
    touch.anchor = anchor;
  }
  return { touch, quote: { nodeId: target, text: t.quote } };
}

/**
 * Send proposals through the one door every source uses, and report what the
 * upsert did with each, in words that cannot be mistaken for a change.
 */
export async function sendProposals(projectId, proposals) {
  const result = await call(`/projects/${projectId}/story-thread-proposals/batch`, {
    method: 'POST',
    body: { source: CONNECTOR_SOURCE, proposals },
  });
  const items = (result?.items ?? []).map((item) => ({
    outcome: item.outcome,
    meaning: OUTCOMES[item.outcome] ?? item.outcome,
    ...(item.reason ? { reason: item.reason } : {}),
    proposals: (item.proposals ?? []).map(proposalView),
  }));
  return {
    items,
    // Said plainly, for the reason write_draft's revise says it: an agent
    // reporting "added" would tell the writer their map changed when it has not.
    status:
      'Proposed, not applied. Nothing on the story-thread map changes until the writer accepts these in ezQuill. ' +
      'Tell the writer they are proposals waiting for their review.',
  };
}

const OUTCOMES = {
  created: 'A new proposal, waiting for the writer.',
  updated: 'The same proposal was already waiting; its evidence was refreshed.',
  reopened: 'The writer dismissed this before, but it now reaches new places, so it is back for review.',
  still_dismissed: 'The writer already dismissed this. It stays dismissed: do not propose it again.',
  refreshed: 'The writer already decided this one; nothing new is waiting.',
  result_deleted: 'The writer accepted this once and then deleted what it made, which counts as a dismissal.',
  folded: 'It matched another pending proposal and was folded into it.',
  converted: 'It matched an existing story thread, so it became touch or link proposals on that thread.',
  dropped: 'Nothing was proposed (see reason).',
};
