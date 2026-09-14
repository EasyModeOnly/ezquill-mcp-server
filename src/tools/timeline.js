import { call } from '../lib/api.js';

export const tools = [
  {
    name: 'get_timeline',
    description:
      'The project timeline. Story mode is chronology inside the fiction; project mode ' +
      'is the writer\'s own milestones.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        mode: {
          type: 'string',
          enum: ['story', 'project'],
          description: 'Omit for both.',
        },
        nodeId: { type: 'string', description: 'Only events attached to this node.' },
      },
      required: ['projectId'],
    },
    annotations: { readOnlyHint: true },

    async handler({ projectId, mode, nodeId }) {
      const body = await call(`/projects/${projectId}/timeline-events`, {
        query: { mode, nodeId },
      });

      return {
        events: (body?.events ?? []).map((e) => {
          // `data` is an opaque JSONB blob carrying the whole rich shape; the
          // web app flattens it back onto the event and so does this, because
          // handing an agent a blob makes it guess at the keys.
          const data = e.data ?? {};
          return {
            id: e.id,
            timelineType: e.timelineType,
            title: data.title ?? undefined,
            description: data.description ?? undefined,
            type: data.type ?? undefined,
            storyDate: data.storyDate ?? undefined,
            realDate: e.realDate ?? undefined,
            nodeId: e.nodeId || undefined,
            // ENTITY IDS, not names — this is what the timeline's own filters
            // intersect against. Pass them to get_entity to resolve a name.
            characterIds: data.story?.characters ?? undefined,
            locationIds: data.story?.locations ?? undefined,
          };
        }),
      };
    },
  },
];
