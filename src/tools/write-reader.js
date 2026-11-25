/**
 * Driving a first reader (ezquill epic #70, task #898; plan §14 and §14a).
 *
 * Two tools, because the two ways of reading differ in the one thing a writer
 * cares about before saying yes: who pays.
 *
 * - `manage_first_reader`: ezQuill's model reads, metered in the WRITER'S
 *   credits. Over the web app's route (estimate, start, advance), one batch of
 *   sections per call; the route stops starting sections after 45 s, so a call
 *   returns in a couple of minutes at worst.
 * - `read_as_first_reader`: the agent calling this tool IS the reader, and
 *   nothing is metered. `next` hands out exactly one section, built by the same
 *   no-spoilers builder as the model's prompt; `submit` runs the answer through
 *   the same validation and quote check as a model answer.
 *
 * What ezQuill cannot guarantee for the second is what the agent already
 * knows. An agent that has read the outline or a later chapter is not a first
 * reader, and nothing on the server can see that. The description is the only
 * lever, which is why it asks for a fresh subagent in so many words.
 *
 * Cancel goes to Go for both: it spends nothing.
 */
import { call } from '../lib/api.js';
import { Code, ToolError } from '../lib/errors.js';
import { AGENT_CAVEAT, PERSONAS, READER_ROUTE, cancelRun, findOpenRun, requirePersona, runView } from '../lib/reader.js';

const route = (body) => call(READER_ROUTE, { app: true, method: 'POST', body });

const PERSONA_SCHEMA = {
  type: 'string',
  enum: PERSONAS,
  description:
    '"genre": an attentive reader of this genre who notices setups and predicts. "casual": reads for the characters, forgets minor details, says when lost.',
};

/** What a batch of the ezQuill reader did, in words an agent can relay. */
function batchView(body) {
  const out = { run: runView(body?.run), read: body?.read ?? 0 };
  if (body?.stopped) out.stopped = body.stopped;
  if (body?.message) out.message = body.message;
  if (body?.refusal) out.refusal = body.refusal;
  out.next = nextStep(body);
  return out;
}

function nextStep(body) {
  const run = body?.run;
  if (!run) return undefined;
  if (run.status === 'completed') return 'The reading is finished. Read it with get_reader_report.';
  if (run.status === 'cancelled') return 'The reading was cancelled.';
  switch (body.stopped) {
    case 'budget':
      return "Paused at its budget. Continue with a higher budgetCredits only if the writer agrees to spend more.";
    case 'cap':
      return 'Paused: the credit limit was reached. Tell the writer; do not retry.';
    case 'error':
      return 'Paused on an error (see message). Tell the writer.';
    default:
      return 'Call continue again to read the next batch, while the writer wants it to go on.';
  }
}

function estimateView(body) {
  const out = {
    sections: body.unitCount,
    reusedFromEarlierReading: body.reusedCount,
    toRead: body.toReadCount,
    words: body.words,
    defaultBudgetCredits: body.defaultBudgetCredits,
  };
  const e = body.estimate;
  if (e === null || e === undefined) {
    out.credits = { min: 0, max: 0 };
    out.note = 'Nothing has changed since an earlier reading: starting copies it and spends nothing.';
    return out;
  }
  // Credits only. Unpriced is not free: null credits say the price is unknown.
  out.credits = e.credits;
  out.remainingCredits = e.remainingCredits;
  if (e.limitedBy) out.limitedBy = e.limitedBy;
  out.fits = e.fits;
  return out;
}

/**
 * `next`, taking the reading back from a lost session when that is what is
 * in the way (ezquill #918).
 *
 * An agent that lost its leaseToken (a new conversation, a dropped
 * subagent) is otherwise refused for up to 15 minutes by its own dead
 * session's lease. So when `next` is sent WITHOUT a token and refused because
 * another session holds the reading, it asks once more with `takeOver`. Only
 * the person who started the reading can take it over; the server enforces
 * that, and anyone else gets its refusal. With a token, nothing is retried: a
 * token that no longer matches means a session that may still be alive, and
 * two of the writer's own sessions racing must keep refusing each other.
 *
 * Go names no code for a held lease (it is a plain 409 "conflict", like a
 * closed run or a wrong seq), so the words are what tell them apart. A change
 * of wording makes this a plain 409 again, which is where it started.
 */
async function claimNext(projectId, runId, leaseToken) {
  const body = { action: 'next', projectId, runId, ...(leaseToken ? { leaseToken } : {}) };
  try {
    return await route(body);
  } catch (err) {
    if (leaseToken || !heldElsewhere(err)) throw err;
    return { ...(await route({ ...body, takeOver: true })), tookOver: true };
  }
}

function heldElsewhere(err) {
  return err instanceof ToolError && err.detail?.status === 409 && /another session/i.test(err.message);
}

async function runIdOr(args, driver) {
  if (args.runId) return args.runId;
  return findOpenRun(args.projectId, { driver, persona: args.persona });
}

const manageFirstReader = {
  name: 'manage_first_reader',
  description:
    "Have ezQuill's model read a story as a first-time reader, one section at a time in reading order, seeing only the " +
    "prose so far. THIS SPENDS THE WRITER'S AI CREDITS: use it only when the writer asked for a first reader, give them " +
    'the estimate first, and start only on their go-ahead. estimate (persona): the credit range, sections to read and how ' +
    'many an earlier reading lets it skip; spends nothing. start (persona, budgetCredits?, default 1000): creates the run ' +
    'and reads the first batch. continue (runId, or persona to find the open run; budgetCredits? raises the budget of a ' +
    'run paused for it): reads ONE batch per call and returns progress; call it again to go on. cancel (runId or ' +
    'persona): stops it; what was read is kept. Read the results with get_reader_report. To read it yourself at no ' +
    'cost, use read_as_first_reader instead. Story projects only.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string' },
      action: { type: 'string', enum: ['estimate', 'start', 'continue', 'cancel'] },
      persona: PERSONA_SCHEMA,
      runId: { type: 'string', description: 'The reading, for continue and cancel. Omit to use the open one.' },
      budgetCredits: {
        type: 'integer',
        minimum: 1,
        description: 'The most this reading may spend, in credits. Only a figure the writer agreed to.',
      },
    },
    required: ['projectId', 'action'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false },

  async handler(args) {
    const { projectId, action, persona, budgetCredits } = args;
    switch (action) {
      case 'estimate': {
        requirePersona(persona);
        return estimateView(await route({ action: 'estimate', projectId, persona }));
      }
      case 'start': {
        requirePersona(persona);
        const body = await route({
          action: 'start',
          projectId,
          persona,
          driver: 'ezquill',
          ...(budgetCredits !== undefined ? { budgetCredits } : {}),
        });
        return batchView(body);
      }
      case 'continue': {
        const runId = await runIdOr(args, 'ezquill');
        const body = await route({
          action: 'advance',
          projectId,
          runId,
          ...(budgetCredits !== undefined ? { budgetCredits } : {}),
        });
        return batchView(body);
      }
      case 'cancel':
        return cancelRun(projectId, await runIdOr(args, 'ezquill'));
      default:
        throw new ToolError(Code.REQUEST_FAILED, `Unknown action: ${action}`);
    }
  },
};

const readAsFirstReader = {
  name: 'read_as_first_reader',
  description:
    'Be the first reader yourself: read a story one section at a time, as someone who has never seen it, and record ' +
    "your questions, predictions, confusions and engagement. Spends no ezQuill credits. Its value depends on you knowing " +
    'NOTHING about the book beyond what you have been handed, so: run the whole reading in a FRESH subagent or ' +
    'conversation that has not seen this project; use NO other ezQuill tool during it (no read_scene, get_outline, ' +
    'search_project or report); never read ahead or guess at later sections. start (persona, model = your model name): ' +
    'creates the reading. next (runId, leaseToken from the last call): returns exactly ONE section with `instructions` ' +
    '(who you are and how to read), `reading` (your notes so far, then the prose), the JSON `schema` and progress, or ' +
    'done. Answer as that reader, in the first person, as reactions and never advice, with exactly the JSON the schema ' +
    'asks for, quoting the prose word for word. submit (runId, seq, leaseToken, answer): sends it; if it is refused, ' +
    'fix the listed errors and submit once more. Then next again, until done. Keep the leaseToken; if it is lost, next ' +
    'without one takes the reading back from your old session. cancel (runId or persona) stops it. Story projects only.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string' },
      action: { type: 'string', enum: ['start', 'next', 'submit', 'cancel'] },
      persona: PERSONA_SCHEMA,
      model: { type: 'string', description: 'start: the model doing the reading, shown as a label ("Read by your agent (…)").' },
      runId: { type: 'string', description: 'The reading. Omit on next or cancel to use the open agent reading.' },
      leaseToken: { type: 'string', description: 'From the last next or submit.' },
      seq: { type: 'integer', minimum: 0, description: 'submit: the seq that next handed out.' },
      answer: { type: 'object', description: 'submit: your answer, matching the schema next handed out.' },
    },
    required: ['projectId', 'action'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false },

  async handler(args) {
    const { projectId, action, persona } = args;
    switch (action) {
      case 'start': {
        requirePersona(persona);
        const body = await route({
          action: 'start',
          projectId,
          persona,
          driver: 'agent',
          ...(args.model ? { model: args.model } : {}),
        });
        const run = runView(body?.run);
        return {
          run,
          caveat: AGENT_CAVEAT,
          next:
            body?.run?.status === 'completed'
              ? 'Nothing has changed since an earlier reading by your agent: it was copied, and there is nothing to read.'
              : 'Call next with this runId, in a fresh subagent that has not seen this project.',
        };
      }
      case 'next': {
        const runId = await runIdOr(args, 'agent');
        const body = await claimNext(projectId, runId, args.leaseToken);
        if (body?.done) return { done: true, run: runView(body.run), next: 'The reading is finished.' };
        return {
          runId: body.runId,
          seq: body.seq,
          leaseToken: body.leaseToken,
          leaseUntil: body.leaseUntil,
          ...(body.tookOver
            ? { tookOver: 'The reading was held by an earlier session of yours; it is yours again, and that session can no longer submit.' }
            : {}),
          progress: body.reading?.progress
            ? `section ${body.reading.progress.seq + 1} of ${body.reading.progress.total}`
            : undefined,
          instructions: body.reading?.instructions,
          reading: body.reading?.reading,
          schema: body.reading?.schema,
          promptVersion: body.reading?.promptVersion,
          next: 'Read only this. Answer with the JSON the schema asks for, then submit it with this seq and leaseToken.',
        };
      }
      case 'submit': {
        const { runId, seq, leaseToken, answer } = args;
        if (!runId || !leaseToken || !Number.isInteger(seq)) {
          throw new ToolError(Code.REQUEST_FAILED, 'submit needs runId, seq and the leaseToken that next gave.');
        }
        if (answer === undefined || answer === null) {
          throw new ToolError(Code.REQUEST_FAILED, 'submit needs answer: the JSON the schema asks for.', { field: 'answer' });
        }
        let body;
        try {
          body = await route({ action: 'submit', projectId, runId, seq, leaseToken, answer });
        } catch (err) {
          // A refused answer is something to fix and resend, not a failure:
          // the errors and the (renewed) token are what the agent needs.
          if (err instanceof ToolError && err.detail?.status === 422 && Array.isArray(err.body?.errors)) {
            return {
              accepted: false,
              message: err.message,
              errors: err.body.errors,
              leaseToken: err.body.leaseToken ?? leaseToken,
              next: 'Fix these and submit once more with the same seq.',
            };
          }
          throw err;
        }
        const done = body?.run?.status === 'completed';
        return {
          accepted: true,
          seq: body.seq,
          run: runView(body.run),
          ...(body.droppedCount ? { droppedCount: body.droppedCount } : {}),
          ...(body.repairedCount ? { repairedCount: body.repairedCount } : {}),
          ...(body.leaseToken ? { leaseToken: body.leaseToken } : {}),
          next: done ? 'The reading is finished.' : 'Call next with this leaseToken for the next section.',
        };
      }
      case 'cancel':
        return cancelRun(projectId, await runIdOr(args, 'agent'));
      default:
        throw new ToolError(Code.REQUEST_FAILED, `Unknown action: ${action}`);
    }
  },
};

export const tools = [manageFirstReader, readAsFirstReader];
