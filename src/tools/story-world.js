import { call, callPaged } from '../lib/api.js';
import { resolveProfile } from '../lib/profile.js';

export const tools = [
  {
    name: 'list_entities',
    description:
      "The project's story world: characters, locations, factions, items, and research " +
      'notes. Filter by kind, by tag, or by which scene they appear in.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        kind: {
          type: 'string',
          description: 'character, location, faction, item, source, term, research, …',
        },
        tag: { type: 'string' },
        search: { type: 'string', description: 'Match against the name.' },
        appearsInNode: {
          type: 'string',
          description: 'Only entities linked to this node.',
        },
        role: {
          type: 'string',
          description:
            'Used with appearsInNode: pov, present, setting, mentioned, cited. ' +
            'Together these answer "who is the POV of this scene".',
        },
      },
      required: ['projectId'],
    },
    annotations: { readOnlyHint: true },

    async handler({ projectId, kind, tag, search, appearsInNode, role }) {
      const entities = await callPaged(`/projects/${projectId}/entities`, 'entities', {
        kind,
        tag,
        search,
        appearsInNode,
        role,
        limit: 1000,
      });

      return {
        entities: entities.map((e) => ({
          id: e.id,
          name: e.name,
          kind: e.kind,
          description: e.description || undefined,
          tags: e.tags ?? [],
          appearanceCount: e.appearanceCount ?? 0,
          relationCount: e.relationCount ?? 0,
        })),
      };
    },
  },

  {
    name: 'get_entity',
    description:
      'One character, place or note in full: its profile, who and what it is connected ' +
      'to, and every scene it appears in.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        entityId: { type: 'string' },
      },
      required: ['projectId', 'entityId'],
    },
    annotations: { readOnlyHint: true },

    async handler({ projectId, entityId }) {
      const base = `/projects/${projectId}/entities/${entityId}`;
      const [entity, relations, appearances] = await Promise.all([
        call(base),
        call(`${base}/relations`).catch(() => null),
        call(`${base}/appearances`).catch(() => null),
      ]);

      return {
        id: entity.id,
        name: entity.name,
        kind: entity.kind,
        description: entity.description || undefined,
        tags: entity.tags ?? [],
        // Resolved, so a caller cannot read the imported value over the
        // writer's edit. See lib/profile.js — the rule otherwise lives only in
        // the web app, and reading the raw blob fails silently.
        profile: resolveProfile(entity.profile),
        // `kind` here is already the inverse when the edge points the other
        // way, so one directed row reads correctly from either end and this
        // needs no flipping: (Ana)-[parent_of]->(Bea) reads back on Bea as
        // "child_of Ana".
        relations: (relations?.relations ?? []).map((r) => ({
          kind: r.kind,
          entityId: r.entity?.id,
          name: r.entity?.name,
          entityKind: r.entity?.kind,
          outgoing: r.outgoing,
        })),
        appearances: (appearances?.appearances ?? []).map((a) => ({
          nodeId: a.nodeId,
          nodeTitle: a.nodeTitle,
          nodeType: a.nodeType,
          role: a.role,
        })),
      };
    },
  },
];
