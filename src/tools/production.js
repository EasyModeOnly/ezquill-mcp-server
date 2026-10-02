/**
 * Reading production (ezquill epic #38): what has been made from a shortform
 * show's shots, and the prompt to make the next one.
 *
 * Both tools read answers the WEB APP computes — the prompt compiler and the
 * production summaries are its TypeScript — through `call(..., { app: true })`.
 * Porting either here would be a second copy that drifts: a compiler whose
 * block text differs by one word produces a different clip.
 */
import { call } from '../lib/api.js';

export const tools = [
  {
    name: 'get_production',
    description:
      'What has been produced in a shortform-video show, and what is next. scope "project": ' +
      'shots per status, next up, blocked shots with why, unproduced scripts, spend. ' +
      'scope "episode" (nodeId = the episode): its shots in status columns with takes, credits ' +
      'and warnings, and its cut. scope "shot" (nodeId = the shot): the locked take and its ' +
      'files, rejected takes with reasons, the start-frame chain, stills and sound cues, plus `fields` — ' +
      'the framing, camera, left-to-right order, length and prompt action the compiler reads — and ' +
      '`startPlan`. scope "show": the house prompt template, the show settings, the show-wide rules, and ' +
      'every entity kind with the profile and production fields it takes. Read it before changing any of them.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        scope: { type: 'string', enum: ['project', 'episode', 'shot', 'show'] },
        nodeId: { type: 'string', description: 'The episode or shot, for those scopes.' },
      },
      required: ['projectId'],
    },
    annotations: { readOnlyHint: true },

    async handler({ projectId, scope = 'project', nodeId }) {
      return call('/api/video/production', {
        app: true,
        query: { projectId, scope, nodeId },
      });
    },
  },

  {
    name: 'compile_prompt',
    description:
      "Compile a shot's generation prompt from its cast, set, props, rules and the show's " +
      'prompt template — the prompt ezQuill shows for that shot. Returns `prompt` (what to ' +
      'submit: the writer\'s hand edit when there is one), `params` (model, duration, aspect ' +
      'ratio, whether to generate audio), `diagnostics` (blocking ones mean do not submit), and ' +
      '`assets`. Submit exactly `prompt`, then record the take with manage_production record_take.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        nodeId: { type: 'string', description: 'The shot.' },
      },
      required: ['projectId', 'nodeId'],
    },
    annotations: { readOnlyHint: true },

    async handler({ projectId, nodeId }) {
      return call('/api/video/compile', { app: true, method: 'POST', body: { projectId, nodeId } });
    },
  },
];
