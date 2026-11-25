/**
 * Reading a story's threads (ezquill epic #71, task #915).
 *
 * A story thread is a question the story makes the reader want answered; a
 * touch is a place in the manuscript that moves one or more of them. Three
 * reads:
 *
 * - list_story_threads: the threads, or one thread with its touches and the
 *   words they quote. Rows only.
 * - get_thread_map_data: the map-data endpoint's JSON, as it is. Status, load,
 *   dormancy, nesting and alerts live there and nowhere else, derived once in
 *   Go so the app's map, its alerts list and this tool read the same answer.
 * - list_thread_proposals: what is waiting for the writer's review.
 */
import { call } from '../lib/api.js';
import { ToolError, Code } from '../lib/errors.js';
import {
  KINDS, PROPOSAL_KINDS, PROPOSAL_SOURCES, PROPOSAL_STATES, WEIGHTS,
  proposalView, threadView, touchView,
} from '../lib/story-threads.js';

const listStoryThreads = {
  name: 'list_story_threads',
  description:
    "A story's threads: the questions it makes the reader want answered (MICE kind, weight, scope, tags, who they are " +
    'about). Includes threads owned by the series the project is in. With storyThreadId: that one thread with its ' +
    'touches, the places in the manuscript that move it, each with its type (open, clue, payoff, ...), the words it ' +
    'quotes and any other thread it also moves. Status (open, resolved, dormant) is not here: it is derived, read it ' +
    'with get_thread_map_data. Not comment threads (list_feedback).',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string' },
      storyThreadId: { type: 'string', description: 'One thread, with its touches.' },
      kind: { type: 'string', enum: KINDS, description: 'Only threads of this kind.' },
      weight: { type: 'string', enum: WEIGHTS, description: 'Only threads of this weight.' },
      includeDeleted: { type: 'boolean', description: 'Add deleted threads (and touches), e.g. to find one to restore.' },
    },
    required: ['projectId'],
  },
  annotations: { readOnlyHint: true },

  async handler({ projectId, storyThreadId, kind, weight, includeDeleted }) {
    const deleted = includeDeleted ? 'true' : undefined;
    if (storyThreadId) {
      const [thread, touches] = await Promise.all([
        call(`/projects/${projectId}/story-threads/${storyThreadId}`),
        call(`/projects/${projectId}/story-thread-touches`, { query: { storyThreadId, includeDeleted: deleted } }),
      ]);
      return { storyThread: threadView(thread), touches: (touches?.items ?? []).map(touchView) };
    }
    const body = await call(`/projects/${projectId}/story-threads`, { query: { includeDeleted: deleted } });
    const threads = (body?.items ?? [])
      .filter((t) => (!kind || t.kind === kind) && (!weight || t.weight === weight))
      .map(threadView);
    return { storyThreads: threads };
  },
};

const getThreadMapData = {
  name: 'get_thread_map_data',
  description:
    "The story-thread map's data, exactly as the writer's own map, alerts list and thread drawer read it: per thread its " +
    'status, stations and dormant stretches, interchanges, open-thread load per section, nesting, reader-question ' +
    "ghosts, alerts and pending proposals. Positions are in words. The statuses and alerts are the writer's view, " +
    'derived by ezQuill: relay them, do not re-derive them. Give projectId for one book, or seriesId for a whole ' +
    'series (volumes in order).',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string' },
      seriesId: { type: 'string', description: 'Instead of projectId: every volume of a series.' },
    },
  },
  annotations: { readOnlyHint: true },

  async handler({ projectId, seriesId }) {
    if (!projectId === !seriesId) {
      throw new ToolError(Code.REQUEST_FAILED, 'Give exactly one of projectId or seriesId.');
    }
    const path = seriesId
      ? `/series/${seriesId}/story-threads/map-data`
      : `/projects/${projectId}/story-threads/map-data`;
    const mapData = await call(path);
    return { summary: summarise(mapData), mapData };
  },
};

/**
 * Counts read off the payload, so an agent can see the shape before the
 * detail. Counting is not deriving: every number here is a length or a tally
 * of a field the server already computed.
 */
function summarise(m) {
  const threads = m?.threads ?? [];
  const byStatus = {};
  for (const t of threads) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  const alertsBySeverity = {};
  for (const a of m?.alerts ?? []) alertsBySeverity[a.severity] = (alertsBySeverity[a.severity] ?? 0) + 1;
  return {
    storyThreads: threads.length,
    byStatus,
    alerts: (m?.alerts ?? []).length,
    alertsBySeverity,
    interchanges: (m?.interchanges ?? []).length,
    sections: (m?.manuscript?.units ?? []).length,
    totalWords: m?.manuscript?.totalWords,
    pendingProposals: m?.proposals?.pending ?? 0,
  };
}

const listThreadProposals = {
  name: 'list_thread_proposals',
  description:
    'Story-thread proposals: threads, touches, reader-question links and merges that a first reader, a prose pass, a ' +
    "structural hint or an agent suggested, and the writer has (or has not) reviewed. Nothing in a pending proposal is " +
    'real yet. Defaults to pending. Each carries what it would create (payload) and what it stands on (evidence).',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string' },
      state: { type: 'string', enum: [...PROPOSAL_STATES, 'all'], description: 'Default pending.' },
      source: { type: 'string', enum: PROPOSAL_SOURCES },
      kind: { type: 'string', enum: PROPOSAL_KINDS },
      storyThreadId: { type: 'string', description: 'Proposals that add to, link to, merge into or created this thread.' },
      runId: { type: 'string', description: 'Proposals from one reader or prose-pass run.' },
    },
    required: ['projectId'],
  },
  annotations: { readOnlyHint: true },

  async handler({ projectId, state, source, kind, storyThreadId, runId }) {
    const wanted = state ?? 'pending';
    const body = await call(`/projects/${projectId}/story-thread-proposals`, {
      query: { state: wanted === 'all' ? undefined : wanted, source, kind, storyThreadId, runId },
    });
    return { proposals: (body?.items ?? []).map(proposalView) };
  },
};

export const tools = [listStoryThreads, getThreadMapData, listThreadProposals];
