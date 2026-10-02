/**
 * Recording production (ezquill epic #38): takes, stills, sound cues, cuts, and
 * a shot's production status.
 *
 * One tool with actions, per the connector's aggregation rule — not one tool
 * per REST route. What each action writes is validated by the API with
 * DisallowUnknownFields (versions.Take, production.NormaliseData), so a
 * misspelt key is refused rather than stored and never read.
 *
 * Three rules this file keeps for the agent:
 * - **Record rejected takes too.** A rejection is paid for and it is where the
 *   lessons come from; a ledger of only accepted takes understates every cost.
 * - **The job id is the durable reference.** A CDN URL expires; always send the
 *   jobId, and a URL only as a convenience.
 * - **A take's record is the compile's.** record_take fills the prompt, the
 *   generation parameters and the asset stamps from compile_prompt unless told
 *   otherwise, so an agent's take goes stale on a redesign exactly as the
 *   app's does.
 */
import { call } from '../lib/api.js';
import { ToolError, Code } from '../lib/errors.js';

const ACTIONS = [
  'record_take', 'update_take',
  'record_still', 'record_cue', 'record_cut', 'update_record', 'delete_record',
  'set_status',
];

// The take's shape, declared field by field (ezquill #433). It mirrors
// versions.Take in the API (api/internal/core/versions/take.go), which decodes
// with DisallowUnknownFields: a key not listed here is refused there, so an
// agent that can SEE the shape does not have to discover it one 400 at a time
// (Saltpig shorts: "provider", then "jobId", then "floorDb"). Nested objects
// set additionalProperties: false, so a client that validates catches the
// misspelling before the call. The top level does not, for the same reason
// no tool here does: a stale client's extra key should reach the API and get
// the API's located error, not be dropped silently by the transport.
const PROVIDERS = ['higgsfield', 'runway', 'veo', 'kling', 'elevenlabs', 'local', 'other'];
const ROLES = ['source', 'revoiced', 'final', 'last_frame', 'handoff_frame', 'still', 'audio', 'project', 'export'];
const REASONS = ['anatomy', 'eyes', 'identity', 'framing', 'order', 'props', 'wardrobe', 'text', 'beat', 'audio', 'model_swap', 'other'];
const REVIEW_ITEMS = REASONS.filter((r) => !['audio', 'model_swap', 'other'].includes(r));

const closed = (properties, extra = {}) => ({ type: 'object', properties, additionalProperties: false, ...extra });

const fileRefSchema = closed(
  {
    provider: { type: 'string', enum: PROVIDERS },
    role: { type: 'string', enum: ROLES },
    jobId: { type: 'string', description: 'The generator job id: the durable reference.' },
    assetId: { type: 'string' },
    path: { type: 'string', description: 'A local or editor path, stored as written.' },
    url: { type: 'string', description: 'A convenience only; CDN links expire.' },
    urlCapturedAt: { type: 'string', description: 'RFC 3339; when the url was copied.' },
    version: { type: 'string' },
  },
  {
    required: ['provider', 'role'],
    description: 'A file outside ezQuill. Needs at least one of jobId, path, url.',
  }
);

const startImageSchema = closed(
  {
    source: { type: 'string', enum: ['none', 'still', 'previous-take', 'upload'] },
    fromTakeId: { type: 'string', description: 'The take the frame was pulled from (a versionId).' },
    fromNodeId: { type: 'string', description: 'That take\'s shot.' },
    note: { type: 'string' },
    frame: fileRefSchema,
    frameSeconds: { type: 'number', description: 'Where in that take the frame was pulled.' },
  },
  {
    required: ['source'],
    description:
      'Where the clip\'s first frame came from. compile_prompt returns this exact shape as params.startImage ' +
      '(record_take copies it). NOT the shot\'s start PLAN {kind, fromNodeId, frameTime}, which is a different shape.',
  }
);

const audioChecksSchema = closed(
  {
    speechPresent: { type: 'boolean' },
    wrongSpeaker: { type: 'boolean' },
    noiseFloorDb: { type: 'number' },
    notes: { type: 'string' },
  },
  { description: 'What somebody heard. Omit a field nobody checked: absent means not checked, not fine.' }
);

const voiceSchema = closed(
  {
    voiceId: { type: 'string' },
    voiceName: { type: 'string' },
    revoiceJobId: { type: 'string' },
    tool: { type: 'string', enum: PROVIDERS },
  },
  { required: ['voiceId'] }
);

const verdictReasonSchema = closed(
  { code: { type: 'string', enum: REASONS }, text: { type: 'string' } },
  { description: 'Why it was accepted or rejected. A code, some text, or both.' }
);

const reviewSchema = closed(
  {
    marks: {
      type: 'array',
      items: closed(
        {
          key: { type: 'string', enum: REVIEW_ITEMS },
          outcome: { type: 'string', enum: ['pass', 'fail'] },
          note: { type: 'string' },
        },
        { required: ['key', 'outcome'] }
      ),
    },
    reviewedAt: { type: 'string' },
  },
  { required: ['marks'] }
);

const stampSchema = closed(
  {
    entityId: { type: 'string' },
    name: { type: 'string' },
    kind: { type: 'string' },
    roles: { type: 'array', items: { type: 'string' } },
    elementId: { type: 'string' },
    voiceId: { type: 'string' },
    deprecated: { type: 'boolean' },
  },
  { required: ['entityId'] }
);

/** Fields a take records and an update can change: shared by `take` and `patch`. */
const movable = {
  status: { type: 'string', enum: ['pending', 'accepted', 'rejected', 'superseded'] },
  note: { type: 'string' },
  verdictReason: verdictReasonSchema,
  review: reviewSchema,
  audioChecks: audioChecksSchema,
  voice: voiceSchema,
  files: { type: 'array', items: fileRefSchema },
  lastFrame: fileRefSchema,
  handoffFrame: fileRefSchema,
  modelActual: { type: 'string', description: 'What the tool reports it actually used.' },
  credits: { type: 'number', description: 'What it cost. Omit when unknown: unpriced is not free.' },
};

const takeSchema = closed(
  {
    jobId: { type: 'string', description: 'Required: the durable reference to the clip.' },
    tool: { type: 'string', enum: PROVIDERS },
    modelRequested: { type: 'string' },
    aspectRatio: { type: 'string' },
    durationSeconds: { type: 'number' },
    resolution: { type: 'string' },
    seed: { type: 'integer' },
    generateAudio: { type: 'boolean' },
    declinedPresetId: { type: 'string' },
    prompt: {
      type: 'string',
      description: 'Only when you submitted something other than the compile (with wasEdited: true), or when backfilling a take whose prompt you have.',
    },
    wasEdited: { type: 'boolean' },
    promptRef: closed(
      { tool: { type: 'string', enum: PROVIDERS }, jobId: { type: 'string' } },
      { required: ['jobId'], description: 'Backfill: the job that holds a prompt you do not have. Stored as a pointer; never fetched.' }
    ),
    startImage: startImageSchema,
    assets: { type: 'array', items: stampSchema, description: 'Defaults to the compile\'s stamps; leave it alone.' },
    url: { type: 'string', description: 'v1 single clip link. Use files.' },
    shotAt: { type: 'string', description: 'RFC 3339; when it was generated. Required with backfill.' },
    ...movable,
  },
  {
    required: ['jobId'],
    description:
      'record_take. prompt, params, startImage and asset stamps default to the shot\'s compile at the time of ' +
      'recording — so record a take when you submit it. For a take generated earlier, set backfill: true.',
  }
);

const patchSchema = closed(movable, {
  description: 'update_take: each field present REPLACES that field; absent fields are left alone.',
});

export const tools = [
  {
    name: 'manage_production',
    description:
      'Record what was produced for a shortform-video show. record_take: one generation of a shot ' +
      '(accepted, rejected or pending — record rejected takes too); set backfill: true for a take generated ' +
      'earlier, so it is not stamped with today\'s prompt. update_take (by versionId alone): its verdict, reason, ' +
      'review marks, audio checks, voice, files or the model the tool actually used. A refused field is named ' +
      'by its path in the error\'s `field`. record_still / ' +
      'record_cue / record_cut: a generated image, a sound cue on a shot, or an episode\'s edit (trims, ' +
      'loudness, export, publishes). update_record / delete_record. set_status: a shot\'s production ' +
      'status (planned, prompting, generating, review, locked, in_cut, published, blocked).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        action: { type: 'string', enum: ACTIONS },
        nodeId: {
          type: 'string',
          description: 'The shot (record_take, update_take, record_still, record_cue, set_status) or the episode (record_cut).',
        },
        versionId: {
          type: 'string',
          description: 'update_take: the take, as returned by record_take or get_production. Enough on its own; nodeId is optional.',
        },
        recordId: { type: 'string', description: 'update_record / delete_record.' },
        take: takeSchema,
        patch: patchSchema,
        backfill: {
          type: 'boolean',
          description:
            'record_take: the take was generated earlier. Nothing is compiled: today\'s prompt and parameters ' +
            'are not what was submitted then. Needs take.shotAt. The prompt is recorded as you give it ' +
            '(take.prompt), as a pointer (take.promptRef), or as not captured.',
        },
        data: {
          type: 'object',
          description:
            'record_still: {purpose: staging | start_frame | handoff_frame | set_plate | wardrobe_ref | other, ' +
            'tool, model, jobId, prompt, files, forTakeId, fromTakeId}. record_cue: {type: sfx | music_bed | ' +
            'splice | repair | voice, title, status: idea | sourced | placed | approved, source {tool, jobId, ' +
            'library, trackId, file}, placement {inSeconds, outSeconds}}. record_cut: {trims [{shotNodeId, ' +
            'takeId, inSeconds, outSeconds}], loudness {targetLufs, measuredLufs, passedAt}, editorProject, ' +
            'finalExport, publishes [{destination, url, publishedAt}]}. update_record: the fields to change.',
        },
        status: {
          type: ['string', 'null'],
          description: 'set_status: the new status, or null to stop tracking the shot.',
        },
        note: { type: 'string', description: 'set_status: why — required in spirit for blocked.' },
        file: fileRefSchema,
      },
      required: ['projectId', 'action'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },

    async handler(args) {
      const { projectId, action } = args;
      const need = (...keys) => {
        for (const k of keys) {
          if (args[k] === undefined || args[k] === '') {
            throw new ToolError(Code.REQUEST_FAILED, `${action} needs ${k}.`);
          }
        }
      };

      switch (action) {
        case 'record_take': {
          need('nodeId', 'take');
          if (!args.take.jobId) {
            throw new ToolError(Code.REQUEST_FAILED, 'record_take needs take.jobId — the durable reference to the clip.');
          }
          if (args.backfill) return recordBackfilledTake(projectId, args.nodeId, args.take);
          // The compile supplies what the app's ledger records automatically:
          // the prompt as it would be sent, the derived parameters, and the
          // asset stamps a later redesign is checked against.
          const compiled = await call('/api/video/compile', {
            app: true,
            method: 'POST',
            body: { projectId, nodeId: args.nodeId },
          });
          const take = {
            prompt: compiled.prompt,
            ...(compiled.wasEdited ? { wasEdited: true } : {}),
            // Supplied text wins below, and says so; otherwise the record is
            // the compile, made now, at submission.
            promptSource: args.take.prompt !== undefined ? 'supplied' : 'compiled',
            // What the compile resolved the clip to open on (#430), in the
            // take's own shape, so the chain check can read it later.
            ...(compiled.params?.startImage ? { startImage: compiled.params.startImage } : {}),
            modelRequested: compiled.params?.model,
            aspectRatio: compiled.params?.aspectRatio,
            durationSeconds: compiled.params?.durationSeconds,
            generateAudio: compiled.params?.generateAudio,
            ...(compiled.params?.declinedPresetId ? { declinedPresetId: compiled.params.declinedPresetId } : {}),
            assets: compiled.assets ?? [],
            status: 'pending',
            shotAt: new Date().toISOString(),
            ...args.take,
          };
          const version = await call(`/projects/${projectId}/nodes/${args.nodeId}/versions`, {
            method: 'POST',
            body: {
              type: 'manual',
              description: ['Take', take.modelRequested, take.credits ? `${take.credits} credits` : undefined]
                .filter(Boolean)
                .join(' · '),
              content: { take },
            },
          });
          return {
            recorded: { versionId: version.id, number: version.versionNumber, status: take.status },
            ...(compiled.diagnostics?.some((d) => d.severity === 'blocking')
              ? { warning: 'The compile had blocking diagnostics; this take was recorded anyway, as submitted.' }
              : {}),
          };
        }

        case 'update_take': {
          need('versionId', 'patch');
          // Applied by the SERVER to the stored take, under a row lock, so it
          // cannot erase a status or review somebody changed meanwhile. By
          // version alone (#435): the id is unique, and the server resolves
          // its shot. A nodeId still takes the nested route, which also
          // checks the take is that shot's.
          const path = args.nodeId
            ? `/projects/${projectId}/nodes/${args.nodeId}/versions/${args.versionId}/take`
            : `/projects/${projectId}/takes/${args.versionId}`;
          await call(path, { method: 'PATCH', body: args.patch });
          return { updated: args.versionId };
        }

        case 'record_still':
        case 'record_cue':
        case 'record_cut': {
          need('nodeId', 'data');
          const kind = action.slice('record_'.length);
          const record = await call(`/projects/${projectId}/production-records`, {
            method: 'POST',
            body: { nodeId: args.nodeId, kind, data: args.data },
          });
          return { recorded: { id: record.id, kind: record.kind, nodeId: record.nodeId } };
        }

        case 'update_record': {
          need('recordId', 'data');
          // PATCH replaces `data` WHOLE, so it is rebuilt from the record as it
          // stands with the change laid over it — sending only the new keys
          // would erase every other field of the still, cue or cut.
          const current = await call(`/projects/${projectId}/production-records/${args.recordId}`);
          const record = await call(`/projects/${projectId}/production-records/${args.recordId}`, {
            method: 'PATCH',
            body: { data: { ...(current?.data ?? {}), ...args.data } },
          });
          return { updated: { id: record.id, kind: record.kind } };
        }

        case 'delete_record': {
          need('recordId');
          await call(`/projects/${projectId}/production-records/${args.recordId}`, { method: 'DELETE' });
          return { deleted: args.recordId, note: 'Soft deleted.' };
        }

        case 'set_status': {
          need('nodeId');
          if (args.status === undefined) {
            throw new ToolError(Code.REQUEST_FAILED, 'set_status needs status (or null to stop tracking).');
          }
          const node = await call(`/projects/${projectId}/nodes/${args.nodeId}/production-status`, {
            method: 'PUT',
            body: { status: args.status, ...(args.note !== undefined ? { note: args.note } : {}) },
          });
          return { nodeId: node.id, productionStatus: node.productionStatus ?? null, note: node.productionNote };
        }

        default:
          throw new ToolError(Code.REQUEST_FAILED, `Unknown action: ${action}`);
      }
    },
  },
];

/**
 * A take generated before it was recorded (ezquill #436).
 *
 * Nothing is compiled. A compile now would stamp today's prompt, parameters
 * and asset stamps on a clip made from different ones — a false record that
 * reads exactly like a true one, which is worse than a gap. So the take holds
 * only what the recorder states, and says where its prompt is.
 */
async function recordBackfilledTake(projectId, nodeId, given) {
  if (!given.shotAt) {
    throw new ToolError(
      Code.REQUEST_FAILED,
      'A backfilled take needs take.shotAt: when it was generated. Recording it as now is the error backfill exists to avoid.'
    );
  }
  const promptSource = given.prompt ? 'supplied' : given.promptRef ? 'reference' : 'not-captured';
  const take = {
    prompt: '',
    assets: [],
    status: 'pending',
    ...given,
    promptSource,
  };
  const version = await call(`/projects/${projectId}/nodes/${nodeId}/versions`, {
    method: 'POST',
    body: {
      type: 'manual',
      description: ['Take', 'backfilled', take.modelRequested, take.credits ? `${take.credits} credits` : undefined]
        .filter(Boolean)
        .join(' · '),
      content: { take },
    },
  });
  return {
    recorded: { versionId: version.id, number: version.versionNumber, status: take.status, promptSource },
    ...(promptSource === 'not-captured'
      ? { note: 'Recorded with its prompt not captured. Pass take.prompt or take.promptRef if you have either.' }
      : {}),
  };
}
