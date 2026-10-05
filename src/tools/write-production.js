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
import { randomUUID } from 'node:crypto';
import { call } from '../lib/api.js';
import { ToolError, Code } from '../lib/errors.js';
import { sectionBlocks } from '../lib/sections.js';
import { occurrences, textOf } from '../lib/prose.js';

const closed = (properties, extra = {}) => ({ type: 'object', properties, additionalProperties: false, ...extra });

const ACTIONS = [
  'record_take', 'update_take',
  'record_still', 'record_cue', 'record_cut', 'update_record', 'delete_record',
  'set_status', 'set_shot', 'set_prompt_template', 'add_rule', 'remove_rule',
  'override_rule', 'clear_override', 'set_show_settings', 'mark_dialogue',
];

// A shot's production fields (ezquill #431): what the compiler reads for its
// CAMERA, SHOT and params blocks, which only the web composer could write.
// Mirrors nodes.ShotPatch in the API. null clears a field: unstated is a real
// answer, and the compiler then says nothing about it rather than guessing.
const nullable = (schema) => ({ ...schema, type: [schema.type, 'null'] });
const shotSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'set_shot: only the fields to change; null clears one. Read get_production scope "shot" `fields` first.',
  properties: {
    framing: nullable({ type: 'string', description: 'What the camera holds: "a chest-up two-shot".' }),
    camera: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['move'],
      description: 'How the camera moves. Only locked emits FIXED / never pulls back. Unset: nothing is said.',
      properties: {
        move: { type: 'string', enum: ['locked', 'tracking', 'handheld', 'push-in', 'pull-out', 'pan'] },
        note: { type: 'string', description: '"follows Sal down the corridor"' },
      },
    },
    castOrder: nullable({
      type: 'array',
      items: { type: 'string' },
      description: 'Character entity ids, camera-left to camera-right. The prompt states an order only when this covers everyone in frame.',
    }),
    wideFraming: nullable({ type: 'boolean', description: "Whether the set's geography is visible." }),
    durationSeconds: nullable({
      type: 'number',
      description: 'Clip length. Unset: fitted to the line (its words, plus a 1s tail), or the show default; 4s with no line.',
    }),
    action: nullable({
      type: 'string',
      description: 'What the SHOT block says, written for the model. Unset: the script prose is sent as written.',
    }),
    startImage: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['kind'],
      description: 'The start PLAN. kind chain = the last frame of the shot before; still / upload = an image.',
      properties: {
        kind: { type: 'string', enum: ['chain', 'still', 'upload'] },
        fromNodeId: { type: 'string' },
        frameTime: { type: 'number' },
        mediaId: { type: 'string' },
      },
    },
  },
};

const templateSchema = closed(
  {
    style: { type: 'string', description: 'The STYLE line every prompt opens with.' },
    preamble: { type: 'string' },
    tail: { type: 'string' },
    blocks: {
      type: 'object',
      description: 'Per compiler block (CAST, CAMERA, NO-TEXT…): {enabled: false} or {heading}. Switching a block off keeps its rules.',
      additionalProperties: closed({ enabled: { type: 'boolean' }, heading: { type: 'string' } }),
    },
    extraBlocks: {
      type: 'array',
      description: 'Standing blocks of the house (EYES, FIRST FRAME, NO FADES, KEEPS MOVING…), each placed after a compiler block.',
      items: closed(
        { name: { type: 'string' }, text: { type: 'string' }, after: { type: 'string' } },
        { required: ['name', 'text', 'after'] }
      ),
    },
  },
  {
    description:
      'set_prompt_template: the WHOLE template — it replaces what is there. Read get_production scope "show" ' +
      'promptTemplate first and send it back with your change. The template edits and toggles; block order is the compiler\'s.',
  }
);

// The show's generation settings (ezquill #452), which only a show-bible import
// could write. Mirrors projects.ShowSettingsPatch: only the keys to change, and
// null returns one to its default.
const showSettingsSchema = closed(
  {
    defaultClipSeconds: nullable({ type: 'number', description: 'A silent shot\'s length when it states none. Unset: the 4s floor.' }),
    dialogueSeconds: nullable({ type: 'number', description: 'The least a speaking shot gets, however short its line. Unset: fitted to the line.' }),
    maxClipSeconds: nullable({ type: 'number', description: 'The model\'s ceiling; longer requests are clamped and warned about.' }),
    wordsPerSecond: nullable({ type: 'number', description: 'Speaking rate a line is fitted at. Unset: 2.5.' }),
    aspectRatio: { type: ['string', 'null'], enum: ['9:16', '16:9', '1:1', null] },
    renderModel: nullable({ type: 'string', description: 'The model a compile names in params.model, e.g. seedance_2_0.' }),
    resolution: nullable({ type: 'string', description: '"720p", "1080p": a generation parameter, never prompt text.' }),
    creditsPerSecond: nullable({ type: 'number', description: 'Price, for params.estimatedCredits. Unset: no estimate rather than a guess.' }),
    declinedPresetId: nullable({ type: 'string' }),
  },
  { description: 'set_show_settings: only the settings to change; null returns one to its default. Read get_production scope "show" settings first.' }
);

const ruleSchema = closed(
  {
    block: { type: 'string', description: 'The block it belongs in: EYES, EARS, ANATOMY, WARDROBE, PROPS, CAMERA, AUDIO…' },
    text: {
      type: 'string',
      description: 'add_rule / remove_rule: required. override_rule / clear_override: only to say which rule when the block holds several.',
    },
    incident: {
      type: 'string',
      description: 'add_rule: what went wrong that this rule prevents — the take, what it cost. A rule nobody can justify is the first one cut.',
    },
  },
  // Only `block` is required at the schema: override_rule and clear_override
  // name a rule by block alone when its owner has one there, and a client that
  // validates against `required: ['block', 'text']` refused exactly those calls
  // before they reached the handler. add_rule / remove_rule check text below.
  { required: ['block'] }
);

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

const patchSchema = closed(
  {
    ...movable,
    // A prompt can be RETRACTED, never written afterwards (ezquill #446): a
    // take backfilled with a pointer string in `prompt` and wasEdited set can
    // be put right without re-recording it.
    promptSource: {
      type: 'string',
      enum: ['not-captured', 'reference'],
      description: 'Correct a prompt the take never held: not-captured (nobody has it) or reference (with promptRef). Both clear prompt and wasEdited.',
    },
    promptRef: closed(
      { tool: { type: 'string', enum: PROVIDERS }, jobId: { type: 'string' } },
      { required: ['jobId'], description: 'The job that holds the prompt. Alone, it implies promptSource reference.' }
    ),
  },
  {
    description:
      'update_take: each field present REPLACES that field; absent fields are left alone. The prompt text itself cannot be patched.',
  }
);

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
      'status (planned, prompting, generating, review, locked, in_cut, published, blocked). ' +
      'set_shot: a shot\'s framing, camera, left-to-right order, length, prompt action or start plan — ' +
      'what compile_prompt reads. set_prompt_template: the show\'s house template (style line, standing ' +
      'blocks). set_show_settings: clip lengths, speaking rate, aspect ratio, model, resolution, price. ' +
      'add_rule / remove_rule: a continuity rule on the show, on one entity with entityId ' +
      '(Sal\'s "exactly two ears"), on one episode with episodeId (its look or weather), or on one entity in ' +
      'one episode with both (Sal\'s robe in this episode only — compiled under Sal\'s name, only when he is in ' +
      'frame). NO FADES is a template block. override_rule: one shot (nodeId) deliberately breaks a rule — name it by rule.block ' +
      '(+ rule.text when its owner has several in that block) and entityId / episodeId as for add_rule; give ' +
      'a reason, and a replacement to have the prompt say what holds instead. clear_override undoes it. ' +
      'mark_dialogue: make a shot\'s line its DIALOGUE — quote the line exactly as it stands (e.g. ' +
      'SAL: "And slop needs love too."); it becomes its own quote-block paragraph, its NAME: label and ' +
      'quotation marks dropped (the compiler writes "SAL says: …"), and speakerId links who says it. ' +
      'The words themselves are unchanged. This is how to clear inline-dialogue-not-marked.',
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
            'takeId, inSeconds, outSeconds}] (merged by shot into a cut already there), loudness {targetLufs, measuredLufs, passedAt}, editorProject, ' +
            'finalExport, publishes [{destination, url, publishedAt}]}. update_record: the fields to change.',
        },
        status: {
          type: ['string', 'null'],
          description: 'set_status: the new status, or null to stop tracking the shot.',
        },
        note: { type: 'string', description: 'set_status: why — required in spirit for blocked.' },
        shot: shotSchema,
        template: templateSchema,
        settings: showSettingsSchema,
        rule: ruleSchema,
        entityId: {
          type: 'string',
          description: 'add_rule / remove_rule / override_rule / clear_override: the entity the rule is about. With episodeId too: that entity, in that episode only.',
        },
        episodeId: {
          type: 'string',
          description: 'add_rule / remove_rule / override_rule / clear_override: the episode a rule holds in, for one that is not show-wide.',
        },
        reason: { type: 'string', description: 'override_rule: why this shot is the exception. Required.' },
        quote: {
          type: 'string',
          description: 'mark_dialogue: the line exactly as it stands in the shot, inside one paragraph. Must occur once.',
        },
        speakerId: { type: 'string', description: 'mark_dialogue: the character who says it, linked as the shot\'s speaker.' },
        replacement: {
          type: 'string',
          description: 'override_rule: what holds instead, said to the model in an OVERRIDE block ("Sal has a third arm"). Omit to only drop the rule.',
        },
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
            ...(compiled.params?.resolution ? { resolution: compiled.params.resolution } : {}),
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

        case 'record_cut': {
          need('nodeId', 'data');
          // An episode has ONE live cut (a unique index), so a second POST is
          // refused — and the episode view used to give no id to update it by
          // (ezquill #451). So record_cut extends the cut that is there: a
          // trim replaces that shot's trim and keeps the others, a publish
          // replaces that destination's, and every other key is laid over.
          const existing = await call(`/projects/${projectId}/production-records`, {
            query: { nodeId: args.nodeId, kind: 'cut' },
          });
          const current = existing?.records?.[0];
          if (!current) {
            const record = await call(`/projects/${projectId}/production-records`, {
              method: 'POST',
              body: { nodeId: args.nodeId, kind: 'cut', data: args.data },
            });
            return { recorded: { id: record.id, kind: record.kind, nodeId: record.nodeId } };
          }
          const record = await call(`/projects/${projectId}/production-records/${current.id}`, {
            method: 'PATCH',
            body: { data: mergeCut(current.data ?? {}, args.data) },
          });
          return {
            recorded: { id: record.id, kind: record.kind, nodeId: record.nodeId },
            merged: true,
            trims: record.data?.trims ?? [],
          };
        }

        case 'record_still':
        case 'record_cue': {
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

        case 'set_shot': {
          need('nodeId', 'shot');
          // Merged by the SERVER into metadata.shot under a row lock (#431):
          // the composer's own keys and every other view's metadata survive.
          const node = await call(`/projects/${projectId}/nodes/${args.nodeId}/shot`, {
            method: 'PATCH',
            body: args.shot,
          });
          return { nodeId: node.id, shot: node.metadata?.shot ?? {} };
        }

        case 'mark_dialogue': {
          need('nodeId', 'quote');
          return markDialogue(projectId, args.nodeId, args.quote, args.speakerId);
        }

        case 'set_show_settings': {
          need('settings');
          // Merged by the SERVER into showBible, key by key (#452): the
          // template, the rules and the bible import's own keys survive.
          const out = await call(`/projects/${projectId}/show-settings`, { method: 'PATCH', body: args.settings });
          return { settings: out.settings };
        }

        case 'set_prompt_template': {
          need('template');
          const stored = await call(`/projects/${projectId}/prompt-template`, { method: 'PUT', body: args.template });
          return { promptTemplate: stored };
        }

        case 'override_rule': {
          need('nodeId', 'rule', 'reason');
          // The override snapshots the rule's text, so that rewording the rule
          // later re-raises the exception instead of silently keeping it. The
          // snapshot is READ here, not typed by the agent: a near-miss copy
          // would be an override that matches nothing.
          const rule = await findRule(projectId, args, args.rule);
          const out = await call(`/projects/${projectId}/nodes/${args.nodeId}/shot/overrides`, {
            method: 'POST',
            body: {
              ...(args.entityId ? { entityId: args.entityId } : {}),
              block: rule.block,
              textAtOverride: rule.text,
              reason: args.reason,
              ...(args.replacement ? { replacement: args.replacement } : {}),
            },
          });
          return {
            overrides: out.overrides,
            ...(args.replacement
              ? {}
              : { note: 'The rule is dropped from this shot and nothing replaces it. Pass replacement to have the prompt say what holds instead.' }),
          };
        }

        case 'clear_override': {
          need('nodeId', 'rule');
          const out = await call(`/projects/${projectId}/nodes/${args.nodeId}/shot/overrides/remove`, {
            method: 'POST',
            body: {
              ...(args.entityId ? { entityId: args.entityId } : {}),
              block: args.rule.block,
              ...(args.rule.text ? { textAtOverride: args.rule.text } : {}),
            },
          });
          return { removed: out.removed, overrides: out.overrides };
        }

        case 'add_rule':
        case 'remove_rule': {
          need('rule');
          if (!args.rule.text?.trim()) {
            throw new ToolError(Code.REQUEST_FAILED, `${action} needs rule.text: the rule itself.`);
          }
          // An episode's rule may be ABOUT an entity (#455): it lives on the
          // episode and carries the entity's id, so it is compiled under that
          // name and only into shots the entity is in.
          const about = args.episodeId && args.entityId ? { entityId: args.entityId } : {};
          const base = args.episodeId
            ? `/projects/${projectId}/nodes/${args.episodeId}/rules`
            : args.entityId
              ? `/projects/${projectId}/entities/${args.entityId}/rules`
              : `/projects/${projectId}/show-rules`;
          if (action === 'add_rule') {
            // origin 'agent' is what keeps it across a bible re-import: the
            // import replaces only the rules it wrote itself.
            const out = await call(base, { method: 'POST', body: { ...args.rule, ...about, origin: 'agent' } });
            return { rules: out.rules };
          }
          const out = await call(`${base}/remove`, {
            method: 'POST',
            body: { block: args.rule.block, text: args.rule.text, ...about },
          });
          return {
            removed: out.removed,
            rules: out.rules,
            ...(out.imported
              ? { note: 'That rule came from the show bible; the next bible import will put it back unless the bible changes.' }
              : {}),
            ...(!out.removed ? { note: 'No rule with that block and text.' } : {}),
          };
        }

        default:
          throw new ToolError(Code.REQUEST_FAILED, `Unknown action: ${action}`);
      }
    },
  },
];

/**
 * Make a line of a shot its dialogue (ezquill #458).
 *
 * The compiler reads a shot's line only from a QUOTE-BLOCK paragraph
 * (readShotText), so a line written inline — `SAL: "…"` in the middle of the
 * blocking — compiles silent, and the diagnostic saying so asked an agent for
 * something no tool could do. A suggested edit cannot either: it replaces text,
 * and the Saltpig agent's `> SAL: "…"` would have landed as a literal ">".
 *
 * This is a write, not a suggestion, and it is limited to what makes that
 * safe: the WORDS are kept as they are; what changes is where they sit (their
 * own paragraph, a quote block) and two pieces of notation that become
 * structure — the `NAME:` label, which the speaker link replaces, and the
 * enclosing quotation marks, which the compiler adds itself ("SAL says: \"…\"").
 * The paragraph it came from is guarded by its content version, so a writer's
 * edit made meanwhile refuses this rather than being overwritten.
 */
async function markDialogue(projectId, nodeId, quote, speakerId) {
  const blocks = await sectionBlocks(projectId, nodeId);
  const holders = blocks.filter((b) => occurrences(textOf(b.content?.document), quote) > 0);
  const total = holders.reduce((n, b) => n + occurrences(textOf(b.content?.document), quote), 0);
  if (total === 0) {
    throw new ToolError(
      Code.REQUEST_FAILED,
      'That line is not in this shot, inside a single paragraph. Quote it exactly as read_scene shows it.'
    );
  }
  if (total > 1) {
    throw new ToolError(Code.REQUEST_FAILED, 'That text occurs more than once in this shot. Quote the whole line.');
  }
  const block = holders[0];
  const doc = block.content.document;
  const top = doc?.content ?? [];
  if (top.length !== 1 || top[0].type !== 'paragraph') {
    throw new ToolError(
      Code.REQUEST_FAILED,
      top[0]?.type === 'blockquote'
        ? 'That line is already a quote block: it is the shot\'s dialogue.'
        : 'That paragraph is not plain prose (a list, a heading…). Change it in ezQuill.'
    );
  }

  const text = textOf(doc);
  const start = text.indexOf(quote);
  const before = text.slice(0, start).trim();
  const after = text.slice(start + quote.length).trim();
  const spoken = quote
    .trim()
    .replace(/^[A-Z][A-Z0-9 .'’-]*:\s*/, '')
    .replace(/^["“](.*)["”]$/s, '$1')
    .trim();
  if (!spoken) throw new ToolError(Code.REQUEST_FAILED, 'Nothing is left to say once the label is taken off.');

  const para = (t) => ({
    document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] },
    plainText: t,
  });
  const line = {
    document: {
      type: 'doc',
      content: [{ type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: spoken }] }] }],
    },
    plainText: spoken,
  };
  const guard = typeof block.contentVersion === 'number' ? { ifContentVersion: block.contentVersion } : {};

  // The original row keeps the first piece, so its comments and history stay
  // with the words they were about; the rest are new paragraphs after it.
  const pieces = [...(before ? [para(before)] : []), line, ...(after ? [para(after)] : [])];
  const replaced = pieces.map((content, i) => ({ id: i === 0 ? block.id : randomUUID(), content, ...(i === 0 ? guard : {}) }));
  const save = blocks.flatMap((b) => (b.id === block.id ? replaced : [{ id: b.id }]));

  const result = await call(`/projects/${projectId}/nodes/${nodeId}/blocks`, { method: 'PUT', body: { blocks: save } });
  const refused = result?.refused ?? [];
  if (refused.length > 0) {
    return {
      marked: false,
      warning: 'The paragraph changed in ezQuill before this landed, so nothing was moved. Re-read the shot and try again.',
    };
  }
  if (speakerId) {
    // The endpoint that ADDS a link: the shot's other roles are untouched.
    await call(`/projects/${projectId}/nodes/${nodeId}/entities/${speakerId}`, { method: 'PUT', body: { role: 'speaker' } });
  }
  return {
    marked: true,
    dialogue: spoken,
    paragraphs: pieces.length,
    ...(speakerId
      ? {}
      : { note: 'No speakerId given: link who says it (manage_cast role speaker), or the line is dropped from the prompt.' }),
  };
}

/**
 * An episode's cut with more laid over it. Lists are merged by their key — a
 * trim by its shot, a publish by its destination — so adding shot 5's trim
 * cannot drop shots 1–4's, which a plain spread of `trims` would.
 */
export function mergeCut(stored, given) {
  const byKey = (list, key, more) => {
    if (!Array.isArray(more)) return list ?? [];
    const out = [...(Array.isArray(list) ? list : [])];
    for (const item of more) {
      const i = out.findIndex((o) => o?.[key] === item?.[key]);
      if (i >= 0) out[i] = item;
      else out.push(item);
    }
    return out;
  };
  return {
    ...stored,
    ...given,
    trims: byKey(stored.trims, 'shotNodeId', given.trims),
    publishes: byKey(stored.publishes, 'destination', given.publishes),
  };
}

/**
 * The rule an override names, read from where it lives: the entity, the
 * episode, or the show. By block alone when its owner has one rule there; with
 * rule.text when it has several, so an agent never overrides the wrong one.
 */
async function findRule(projectId, { entityId, episodeId }, wanted) {
  const block = String(wanted.block ?? '').trim().toUpperCase();
  let rules;
  let owner;
  if (episodeId) {
    // The episode's rules: about nobody, or — with entityId — about that entity.
    const episode = await call(`/projects/${projectId}/nodes/${episodeId}`);
    const all = episode?.metadata?.bible?.rules;
    rules = (Array.isArray(all) ? all : []).filter((r) => (r?.entityId || undefined) === (entityId || undefined));
    owner = `${episode?.title ?? 'that episode'}${entityId ? ` (about ${entityId})` : ''}`;
  } else if (entityId) {
    const entity = await call(`/projects/${projectId}/entities/${entityId}`);
    rules = entity?.metadata?.bible?.rules;
    owner = entity?.name ?? entityId;
  } else {
    const project = await call(`/projects/${projectId}`);
    rules = project?.metadata?.showBible?.rules;
    owner = 'the show';
  }
  const inBlock = (Array.isArray(rules) ? rules : []).filter(
    (r) => r && typeof r.text === 'string' && String(r.block ?? '').toUpperCase() === block
  );
  const text = wanted.text?.trim();
  const matches = text ? inBlock.filter((r) => r.text.trim() === text) : inBlock;
  if (matches.length === 1) return { block, text: matches[0].text };
  if (matches.length === 0) {
    throw new ToolError(
      Code.REQUEST_FAILED,
      `${owner} has no ${block} rule${text ? ` reading "${text}"` : ''}. Its ${block} rules: ${
        inBlock.map((r) => `"${r.text}"`).join(', ') || 'none'
      }. Name an episode rule with episodeId, an entity's with entityId.`
    );
  }
  throw new ToolError(
    Code.REQUEST_FAILED,
    `${owner} has ${matches.length} ${block} rules; pass rule.text to say which: ${matches.map((r) => `"${r.text}"`).join(', ')}.`
  );
}

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
