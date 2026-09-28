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

const fileRefSchema = {
  type: 'object',
  description:
    'A file outside ezQuill. provider: higgsfield | runway | veo | kling | elevenlabs | local | other. ' +
    'role: source | revoiced | final | last_frame | handoff_frame | still | audio | project | export. ' +
    'Needs at least one of jobId, path, url. The jobId is the durable reference; a CDN url expires.',
};

export const tools = [
  {
    name: 'manage_production',
    description:
      'Record what was produced for a shortform-video show. record_take: one generation of a shot ' +
      '(accepted, rejected or pending — record rejected takes too). update_take: its verdict, reason, ' +
      'review marks, audio checks, voice, files or the model the tool actually used. record_still / ' +
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
        versionId: { type: 'string', description: 'update_take: the take, as returned by record_take or get_production.' },
        recordId: { type: 'string', description: 'update_record / delete_record.' },
        take: {
          type: 'object',
          description:
            'record_take: jobId (required), tool, modelRequested, modelActual, resolution, seed, credits, ' +
            'status (pending | accepted | rejected | superseded), verdictReason {code, text}, note, ' +
            'files [FileRef], voice {voiceId, voiceName, revoiceJobId, tool}, audioChecks, lastFrame, ' +
            'handoffFrame, startImage. prompt, params and asset stamps default to the shot\'s compile — ' +
            'pass prompt only when you submitted something else, and wasEdited: true with it.',
        },
        patch: {
          type: 'object',
          description:
            'update_take: any of status, note, verdictReason {code, text}, review, audioChecks, voice, ' +
            'files, lastFrame, handoffFrame, modelActual, credits. Each replaces that field. ' +
            'Reason codes: anatomy, eyes, identity, framing, order, props, wardrobe, text, beat, audio, ' +
            'model_swap, other.',
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
          need('nodeId', 'versionId', 'patch');
          // Applied by the SERVER to the stored take, under a row lock, so it
          // cannot erase a status or review somebody changed meanwhile.
          await call(`/projects/${projectId}/nodes/${args.nodeId}/versions/${args.versionId}/take`, {
            method: 'PATCH',
            body: args.patch,
          });
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
