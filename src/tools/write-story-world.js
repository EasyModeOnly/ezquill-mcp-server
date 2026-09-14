/**
 * Changing the story world: entities, their relationships, and who is in a
 * scene.
 */
import { call } from '../lib/api.js';
import { ToolError, Code } from '../lib/errors.js';
import { resolveProfile } from '../lib/profile.js';

export const tools = [
  {
    name: 'manage_entity',
    description:
      'Create or change a character, place, faction, item or research note, and the ' +
      'relationships between them.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        action: {
          type: 'string',
          enum: ['create', 'update', 'relate', 'unrelate', 'delete', 'restore'],
        },
        entityId: { type: 'string', description: 'Required by everything except create.' },
        kind: {
          type: 'string',
          description: 'character, location, faction, item, term, research, worldbuilding, theme…',
        },
        name: { type: 'string' },
        description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        profile: {
          type: 'object',
          description:
            'Kind-specific fields — role, age, occupation, notes and so on. Merged with ' +
            "what is already there; the writer's existing values are never dropped.",
        },
        toEntityId: { type: 'string', description: 'For relate: the other end.' },
        relationKind: {
          type: 'string',
          description:
            'For relate: parent_of, mentor_of, member_of, based_in, documents… Directed, ' +
            'read from this entity to the other.',
        },
        inverseKind: {
          type: 'string',
          description:
            'For relate: how the edge reads from the OTHER end — child_of, student_of. ' +
            'One row then serves both directions.',
        },
        relationId: { type: 'string', description: 'For unrelate.' },
      },
      required: ['projectId', 'action'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },

    async handler(args) {
      const { projectId, action } = args;
      const base = `/projects/${projectId}/entities`;

      switch (action) {
        case 'create': {
          if (!args.name || !args.kind) {
            throw new ToolError(Code.REQUEST_FAILED, 'create needs a name and a kind.');
          }
          const created = await call(base, {
            method: 'POST',
            body: {
              kind: args.kind,
              name: args.name,
              ...(args.description ? { description: args.description } : {}),
              ...(args.tags ? { tags: args.tags } : {}),
              // A profile written by anything other than a person goes in the
              // authored namespace, same as the per-kind form in the app. The
              // engine owns the top level; writing there would make an invented
              // value indistinguishable from an imported one.
              ...(args.profile ? { profile: { authored: args.profile } } : {}),
            },
          });
          return { created: summarise(created) };
        }

        case 'update': {
          requireEntity(args);
          // PATCH REPLACES `profile` — the repository writes `profile = $n`
          // with no merge, and nothing server-side objects. So the whole blob
          // is rebuilt from the row that was read: the engine's keys at the top
          // level, the writer's under `authored`, and this change layered onto
          // the authored half. Sending only the new keys would erase both.
          const current = args.profile ? await call(`${base}/${args.entityId}`) : null;
          const profile = args.profile
            ? {
                ...(current?.profile ?? {}),
                authored: { ...(current?.profile?.authored ?? {}), ...args.profile },
              }
            : undefined;

          const updated = await call(`${base}/${args.entityId}`, {
            method: 'PATCH',
            body: {
              ...(args.name ? { name: args.name } : {}),
              ...(args.description !== undefined ? { description: args.description } : {}),
              ...(args.tags ? { tags: args.tags } : {}),
              ...(profile ? { profile } : {}),
            },
          });
          return { updated: summarise(updated) };
        }

        case 'relate': {
          requireEntity(args);
          if (!args.toEntityId || !args.relationKind) {
            throw new ToolError(Code.REQUEST_FAILED, 'relate needs toEntityId and relationKind.');
          }
          // The path entity is always the FROM end — the handler overwrites
          // fromEntityId with it regardless of the body, so sending one would
          // be a lie that happened to work.
          const relation = await call(`${base}/${args.entityId}/relations`, {
            method: 'POST',
            body: {
              toEntityId: args.toEntityId,
              kind: args.relationKind,
              ...(args.inverseKind ? { inverseKind: args.inverseKind } : {}),
            },
          });
          return { related: { id: relation.id, kind: relation.kind, to: args.toEntityId } };
        }

        case 'unrelate':
          requireEntity(args);
          if (!args.relationId) {
            throw new ToolError(Code.REQUEST_FAILED, 'unrelate needs a relationId.');
          }
          await call(`${base}/${args.entityId}/relations/${args.relationId}`, { method: 'DELETE' });
          return { unrelated: args.relationId };

        case 'delete':
          requireEntity(args);
          await call(`${base}/${args.entityId}`, { method: 'DELETE' });
          return {
            deleted: args.entityId,
            note: 'Soft deleted. Its links to scenes are kept so a restore is complete, but it is out of every cast while deleted.',
          };

        case 'restore':
          requireEntity(args);
          await call(`${base}/${args.entityId}/restore`, { method: 'POST', body: {} });
          return { restored: args.entityId };

        default:
          throw new ToolError(Code.REQUEST_FAILED, `Unknown action: ${action}`);
      }
    },
  },

  {
    name: 'manage_cast',
    description:
      'Record that a character, place or note belongs to a scene — who is present, ' +
      'whose point of view it is, where it happens, what it cites.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        action: { type: 'string', enum: ['link', 'unlink'] },
        nodeId: { type: 'string' },
        entityId: { type: 'string' },
        role: {
          type: 'string',
          description: 'pov, present, setting, mentioned, referenced, cited, sourced.',
        },
      },
      required: ['projectId', 'action', 'nodeId', 'entityId', 'role'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },

    async handler({ projectId, action, nodeId, entityId, role }) {
      // The per-entity endpoint, which ADDS. Never the collection PUT, which
      // replaces the whole cast: using that would mean reading every existing
      // link and sending it back, and silently dropping any role this tool did
      // not know to carry — `mentioned` and `cited` are the ones that would go.
      // The endpoint that only adds cannot lose anything.
      //
      // `data` is deliberately not exposed: the handler types it as []byte, so
      // on the wire it is a base64 string rather than an object, which is a
      // trap for any JSON-shaped caller and buys nothing here.
      const path = `/projects/${projectId}/nodes/${nodeId}/entities/${entityId}`;

      if (action === 'link') {
        const link = await call(path, { method: 'PUT', body: { role } });
        return { linked: { nodeId, entityId, role: link?.role ?? role } };
      }

      // The role is part of the key `(node_id, entity_id, role)`, so unlinking
      // needs it: a character can be both the point of view and present.
      await call(`${path}?role=${encodeURIComponent(role)}`, { method: 'DELETE' });
      return { unlinked: { nodeId, entityId, role } };
    },
  },
];

function requireEntity(args) {
  if (!args.entityId) {
    throw new ToolError(Code.REQUEST_FAILED, `${args.action} needs an entityId.`);
  }
}

const summarise = (e) => ({
  id: e.id,
  name: e.name,
  kind: e.kind,
  description: e.description || undefined,
  tags: e.tags ?? [],
  profile: resolveProfile(e.profile),
});
