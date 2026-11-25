/**
 * Reading a first reader's report (ezquill epic #70, task #898).
 *
 * One read over the web app's route (`report` on `/api/ai/first-reader`,
 * ezquill #918), which is Go's `GET /projects/{id}/reader-report` with a
 * `stale` flag on the section and on each chart point: the prose has changed
 * since the reader read it. The flag is the route's because a unit's text is
 * assembled and hashed by the reader's TypeScript; a copy here would drift.
 * Per persona it is the run that speaks for it (the latest closed run, or the
 * open one when nothing has closed), or the one `runId` names.
 *
 * The answer is trimmed rather than passed through: a question's per-unit
 * history and a snapshot's carried state are the driver's bookkeeping, and an
 * agent asked "what did the reader think of chapter 3" needs the reactions and
 * the quotes, not the salience of every question at every section.
 */
import { call } from '../lib/api.js';
import { AGENT_CAVEAT, PERSONAS, READER_ROUTE, runView } from '../lib/reader.js';

const SIMULATED =
  "A simulated first-time reader's reactions, not facts about the book and not the writer's notes.";

/** Said beside a reading that saw an earlier draft of some of its sections. */
const CHANGED_NOTE =
  "Sections marked changedSinceRead were edited after this reader read them: its reactions there are to an earlier draft. Say so when you report them.";

export const tools = [
  {
    name: 'get_reader_report',
    description:
      "What a simulated first reader thought while reading a story in order, seeing only the prose so far. These are a " +
      "model's (or an agent's) simulated reactions: never present them as facts about the book or as the writer's own " +
      'notes, and say which reader they came from. Without nodeId: per persona, the run and its progress, engagement (1-5) ' +
      'and open-question load per section (`units`), the questions left unanswered or gone dormant with where each was ' +
      'raised, and how many were answered or abandoned. With nodeId (a section): its engagement and note, the questions ' +
      'held coming in, raised, advanced, answered and gone dormant there, predictions and confusions, with quotes. ' +
      'A section or unit marked changedSinceRead was edited after it was read: say its reactions are to an earlier draft. ' +
      'runId: an earlier reading instead of the current one. Story projects only. Empty `readings` means nobody has read it yet.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        nodeId: { type: 'string', description: 'One section. Omit for the whole book.' },
        persona: { type: 'string', enum: PERSONAS, description: 'One reader. Omit for both.' },
        runId: { type: 'string', description: 'One reading, e.g. an earlier one. Omit for the current reading per persona.' },
      },
      required: ['projectId'],
    },
    annotations: { readOnlyHint: true },

    async handler({ projectId, nodeId, persona, runId }) {
      const body = await call(READER_ROUTE, {
        app: true,
        method: 'POST',
        body: {
          action: 'report',
          projectId,
          ...(persona ? { persona } : {}),
          ...(nodeId ? { nodeId } : {}),
          ...(runId ? { runId } : {}),
        },
      });
      return {
        about: SIMULATED,
        readings: (body?.readings ?? []).map(reading),
      };
    },
  },
];

function reading(r) {
  const out = { persona: r.persona, run: runView(r.run) };
  if (r.run?.driver === 'agent') out.caveat = AGENT_CAVEAT;
  if (r.node) out.section = section(r.node);
  if (r.summary) out.summary = summary(r.summary);
  if (r.node?.stale || (r.summary?.units ?? []).some((u) => u.stale)) out.changed = CHANGED_NOTE;
  return out;
}

function section(n) {
  return {
    nodeId: n.nodeId,
    ...(n.stale ? { changedSinceRead: true } : {}),
    // A section over 6,000 words is read in parts, each with its own snapshot.
    parts: (n.snapshots ?? []).map((s) => ({
      seq: s.seq,
      part: s.part,
      words: s.wordCount,
      engagement: s.engagement,
      engagementNote: s.engagementNote,
      predictions: s.predictions ?? [],
      confusions: s.confusions ?? [],
      ...(s.droppedCount ? { droppedCount: s.droppedCount } : {}),
    })),
    heldComingIn: (n.heldComingIn ?? []).map(question),
    raised: (n.raised ?? []).map(question),
    advanced: (n.advanced ?? []).map(question),
    resolved: (n.resolved ?? []).map(question),
    wentDormant: (n.wentDormant ?? []).map(question),
  };
}

function summary(s) {
  return {
    units: (s.units ?? []).map((u) => ({
      seq: u.seq,
      nodeId: u.nodeId,
      ...(u.part > 1 ? { part: u.part } : {}),
      words: u.wordCount,
      engagement: u.engagement,
      openQuestions: u.openQuestions,
      ...(u.stale ? { changedSinceRead: true } : {}),
    })),
    unanswered: (s.unanswered ?? []).map(question),
    dormant: (s.dormant ?? []).map(question),
    answered: s.answered ?? 0,
    abandoned: s.abandoned ?? 0,
  };
}

function question(q) {
  const out = {
    // The id manage_story_thread's link_reader_question takes.
    questionId: q.id,
    question: q.text,
    kind: q.kind,
    status: q.status,
    raisedIn: q.raisedNodeId,
    salience: q.salience,
  };
  if (q.raisedQuote) out.raisedBy = q.raisedQuote;
  if (q.resolvedNodeId) out.resolvedIn = q.resolvedNodeId;
  if (q.resolution) out.resolution = q.resolution;
  if (q.resolutionQuote) out.resolvedBy = q.resolutionQuote;
  if (q.storyThreadId) out.storyThreadId = q.storyThreadId;
  return out;
}
