/**
 * The first reader (ezquill epic #70), as the connector shows it.
 *
 * A first reader is a SIMULATED reader: a model (or the writer's own agent)
 * reads a story in order, one section at a time, seeing only the prose so far,
 * and records its questions, predictions, confusions and engagement. Nothing
 * it says is a fact about the book, and nothing is the writer's own note.
 *
 * The run's state lives in the Go API (`/projects/{id}/reader-runs`, its
 * report at `/projects/{id}/reader-report`). Reading is driven by the web app's
 * route `/api/ai/first-reader` (`app: true`), because the no-spoilers prompt
 * builder, the answer validation and the quote check are its TypeScript, and a
 * second copy here would drift (the same reason production.js calls the app).
 * Cancel goes to Go directly: it spends nothing, so the route does not carry it.
 */
import { call } from './api.js';
import { Code, ToolError } from './errors.js';

export const PERSONAS = ['genre', 'casual'];

/** Where a run's reading is driven. */
export const READER_ROUTE = '/api/ai/first-reader';

/** Said beside every agent-read run, as the app says it (plan §14a). */
export const AGENT_CAVEAT = "Read by the writer's own agent: ezQuill can't check what this reader already knew.";

/** A run reduced to what an agent needs to say where the reading stands. */
export function runView(run) {
  if (!run) return undefined;
  const view = {
    runId: run.id,
    persona: run.persona,
    readBy: run.driver === 'agent' ? `your agent (${String(run.model ?? '').replace(/^agent:/, '') || 'unknown'})` : 'ezQuill',
    status: run.status,
    // Units read so far, which is also the next unit's seq.
    progress: `${run.nextSeq ?? 0} of ${run.total ?? 0} read`,
    nextSeq: run.nextSeq,
    total: run.total,
  };
  if (run.pauseReason) view.pauseReason = run.pauseReason;
  if (run.error) view.error = run.error;
  // Credits only: an agent run has no budget and spends nothing.
  if (run.driver !== 'agent') {
    view.spentCredits = run.spentCredits;
    if (run.budgetCredits !== undefined) view.budgetCredits = run.budgetCredits;
    // Unpriced is not free: a non-zero count makes spentCredits a floor.
    if (run.unpricedCalls) view.spentIsAFloor = true;
  }
  if (run.reusedThroughSeq) view.reusedFromEarlierReading = run.reusedThroughSeq;
  if (run.status === 'in_progress' || run.status === 'paused') view.beingReadNow = Boolean(run.driving);
  if (run.finishedAt) view.finishedAt = run.finishedAt;
  return view;
}

/**
 * The open run (in progress or paused) for this driver, when the caller did
 * not name one. One open run per persona is the server's rule, so with a
 * persona this is exact; without one, two open runs are ambiguous and refused.
 */
export async function findOpenRun(projectId, { driver, persona }) {
  const body = await call(`/projects/${projectId}/reader-runs`);
  const open = (body?.items ?? []).filter(
    (r) =>
      (r.status === 'in_progress' || r.status === 'paused') &&
      r.driver === driver &&
      (!persona || r.persona === persona)
  );
  if (open.length === 1) return open[0].id;
  if (open.length === 0) {
    throw new ToolError(Code.NOT_FOUND, `There is no open ${driver === 'agent' ? 'agent ' : ''}reading on this project${persona ? ` for the ${persona} reader` : ''}. Start one first.`);
  }
  throw new ToolError(Code.REQUEST_FAILED, `More than one reading is open (${open.map((r) => r.persona).join(', ')}). Pass runId or persona.`);
}

/** Cancel a run. Anyone with Write may; the snapshots read so far are kept. */
export async function cancelRun(projectId, runId) {
  const run = await call(`/projects/${projectId}/reader-runs/${runId}/cancel`, { method: 'POST' });
  return { cancelled: true, run: runView(run), note: 'What was read before the cancel is kept as a partial reading.' };
}

export function requirePersona(persona) {
  if (!PERSONAS.includes(persona)) throw new ToolError(Code.REQUEST_FAILED, 'persona must be "genre" or "casual".');
}
