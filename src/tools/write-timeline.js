/**
 * Changing the timeline.
 *
 * # The shallow-merge trap, which has bitten this codebase three times
 *
 * `timeline_events.data` is updated with `data = data || $n::jsonb`. The `||`
 * operator merges KEYS, not trees — so a payload naming `story` replaces the
 * WHOLE story object, however few of its keys the sender knew about.
 *
 * The app's own event form did exactly this: it built `story` from four form
 * fields, so editing an imported event's title silently deleted its characters
 * and locations. Every writer of this column has to rebuild the sub-object from
 * the row it read, and this file is no exception.
 */
import { call } from '../lib/api.js';
import { ToolError, Code } from '../lib/errors.js';

export const tools = [
  {
    name: 'manage_timeline',
    description:
      'Add or change an event on the project timeline — something that happens in the ' +
      'story, or a milestone in the writing.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        action: { type: 'string', enum: ['create', 'update', 'delete', 'restore'] },
        eventId: { type: 'string', description: 'Required by everything except create.' },
        mode: {
          type: 'string',
          enum: ['story', 'project'],
          description: 'For create: chronology inside the fiction, or the writer\'s own milestones.',
        },
        title: { type: 'string' },
        description: { type: 'string' },
        type: { type: 'string', description: 'What kind of event — scene, revelation, death…' },
        storyDate: { type: 'string', description: 'When it happens, in the story\'s own terms.' },
        nodeId: { type: 'string', description: 'The scene this event belongs to, if any.' },
        characterIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Entity IDS, not names. The timeline\'s filters intersect against ids, so a name ' +
            'here matches nothing and the event disappears from the very view it belongs in.',
        },
        locationIds: { type: 'array', items: { type: 'string' }, description: 'Entity ids.' },
      },
      required: ['projectId', 'action'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },

    async handler(args) {
      const { projectId, action } = args;
      const base = `/projects/${projectId}/timeline-events`;

      if (action === 'create') {
        if (!args.title) throw new ToolError(Code.REQUEST_FAILED, 'create needs a title.');
        const event = await call(base, {
          method: 'POST',
          body: {
            timelineType: args.mode ?? 'story',
            ...(args.nodeId ? { nodeId: args.nodeId } : {}),
            data: buildData(args, {}),
          },
        });
        return { created: summarise(event) };
      }

      if (!args.eventId) {
        throw new ToolError(Code.REQUEST_FAILED, `${action} needs an eventId.`);
      }

      if (action === 'update') {
        // Read first, always. The merge is shallow, so `story` must be rebuilt
        // from what is stored — otherwise changing a title drops the cast.
        const events = await call(base, { query: {} });
        const current = (events?.events ?? []).find((e) => e.id === args.eventId);
        if (!current) {
          throw new ToolError(Code.NOT_FOUND, `No timeline event ${args.eventId} in this project.`);
        }

        const updated = await call(`${base}/${args.eventId}`, {
          method: 'PATCH',
          body: {
            ...(args.mode ? { timelineType: args.mode } : {}),
            ...(args.nodeId !== undefined ? { nodeId: args.nodeId } : {}),
            data: buildData(args, current.data ?? {}),
          },
        });
        return { updated: summarise(updated) };
      }

      if (action === 'delete') {
        await call(`${base}/${args.eventId}`, { method: 'DELETE' });
        return { deleted: args.eventId, note: 'Soft deleted; manage_timeline restore brings it back.' };
      }

      if (action === 'restore') {
        await call(`${base}/${args.eventId}/restore`, { method: 'POST', body: {} });
        return { restored: args.eventId };
      }

      throw new ToolError(Code.REQUEST_FAILED, `Unknown action: ${action}`);
    },
  },
];

/**
 * Build the `data` blob, layering this change over what is stored.
 *
 * The spread on `story` is the load-bearing part. An object literal assigned to
 * a JSONB sub-object that does NOT begin with a spread is the tell for this
 * whole class of bug — if you are reading this because something lost its cast,
 * look for the one that is missing.
 */
function buildData(args, current) {
  const story = { ...(current.story ?? {}) };
  if (args.characterIds) story.characters = args.characterIds;
  if (args.locationIds) story.locations = args.locationIds;

  return {
    ...current,
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(args.type !== undefined ? { type: args.type } : {}),
    ...(args.storyDate !== undefined ? { storyDate: args.storyDate } : {}),
    ...(Object.keys(story).length > 0 ? { story } : {}),
  };
}

const summarise = (e) => ({
  id: e.id,
  timelineType: e.timelineType,
  title: e.data?.title,
  storyDate: e.data?.storyDate,
  characterIds: e.data?.story?.characters,
  locationIds: e.data?.story?.locations,
});
