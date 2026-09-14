/**
 * Changing the binder: its structure and its plan lines.
 *
 * One tool rather than seven, because they are one thing a writer does —
 * "reorganise my chapters" is not seven capabilities. The `action` says which.
 *
 * # What this tool deliberately CANNOT do
 *
 * It has no field for prose, and that is a safety property rather than a
 * scoping choice. `PATCH /nodes/{id}` accepts `content` and carries NO
 * `ifContentVersion`, so prose written through it replaces a collaborator's
 * work with no conflict check and no warning. Giving this tool a content field
 * would put the one unguarded write path in the hands of the caller least able
 * to notice. Prose goes through write_draft, which is guarded per paragraph.
 */
import { randomUUID } from 'node:crypto';
import { call } from '../lib/api.js';
import { ToolError, Code } from '../lib/errors.js';

export const tools = [
  {
    name: 'manage_outline',
    description:
      'Change the structure of a project: add chapters or scenes, rename them, move ' +
      'them, set their status, or write the one-line plan for a paragraph. Does not ' +
      'write prose — use write_draft for that.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        action: {
          type: 'string',
          enum: ['add', 'rename', 'move', 'set_status', 'set_plan', 'delete', 'restore'],
        },
        nodeId: {
          type: 'string',
          description: 'The node to act on. Required by every action except add.',
        },
        nodes: {
          type: 'array',
          description:
            'For add: the nodes to create, in order. All are created in one transaction.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              nodeType: {
                type: 'string',
                description:
                  'chapter, scene, part, section, act, poem, post… Use get_outline to see ' +
                  'what this project already uses; the level below a chapter is usually a scene.',
              },
              parentId: {
                type: 'string',
                description: 'Omit to create at the top level of the project.',
              },
            },
            required: ['title'],
          },
        },
        title: { type: 'string', description: 'For rename.' },
        status: {
          type: 'string',
          description: 'For set_status: outline, draft, revision, complete, abandoned.',
        },
        plan: {
          type: 'string',
          description:
            "For set_plan: the one-line intention for a paragraph — what it is FOR, " +
            'not its text.',
        },
        parentId: { type: 'string', description: 'For move. Omit to move to the top level.' },
        order: {
          type: 'number',
          description:
            'For move or add: the position among siblings, as an absolute value rather ' +
            'than an index. Omit to append at the end; 0 puts it first.',
        },
      },
      required: ['projectId', 'action'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },

    async handler(args) {
      const { projectId, action } = args;
      const base = `/projects/${projectId}/nodes`;

      switch (action) {
        case 'add': {
          const wanted = args.nodes ?? [];
          if (wanted.length === 0) {
            throw new ToolError(Code.REQUEST_FAILED, 'add needs at least one entry in `nodes`.');
          }

          // The CLIENT mints the ids, which is what the batch endpoint expects:
          // a child can name a parent created earlier in the same request.
          // Nothing here creates nested nodes, so there are no forward
          // references to get wrong — but minting them keeps the ids knowable
          // before the round trip.
          const body = {
            nodes: wanted.map((n) => ({
              id: randomUUID(),
              title: n.title,
              ...(n.nodeType ? { nodeType: n.nodeType } : {}),
              ...(n.parentId ? { parentId: n.parentId } : {}),
              // `order` is deliberately omitted: absent means "append after the
              // last sibling", which is what adding to an outline means. An
              // explicit 0 would put every one of them first, in reverse.
            })),
          };

          const result = await call(`${base}/batch`, { method: 'POST', body });
          return {
            created: (result?.nodes ?? []).map(summarise),
          };
        }

        case 'rename':
          requireNode(args);
          return {
            updated: summarise(
              await call(`${base}/${args.nodeId}`, { method: 'PATCH', body: { title: args.title } })
            ),
          };

        case 'set_status':
          requireNode(args);
          return {
            updated: summarise(
              await call(`${base}/${args.nodeId}`, {
                method: 'PATCH',
                body: { status: args.status },
              })
            ),
          };

        case 'move': {
          requireNode(args);
          // Its OWN endpoint, never PATCH. Reparenting is the one mutation that
          // can corrupt the tree — PATCH has no parentId field precisely so an
          // unchecked write cannot detach a branch into a cycle — and this path
          // rejects a destination inside the node's own subtree.
          const moved = await call(`${base}/${args.nodeId}/parent`, {
            method: 'PUT',
            body: {
              parentId: args.parentId ?? null,
              ...(args.order === undefined ? {} : { order: args.order }),
            },
          });
          return { moved: summarise(moved) };
        }

        case 'set_plan': {
          requireNode(args);
          // `nodes.metadata` is ASSIGNED, not merged — the repository writes
          // `metadata = $n` with no `||`. So a partial write does not lose one
          // sub-object, it replaces the WHOLE blob: tags, writingType and every
          // view's block go with it. Read the row and rebuild from it.
          const node = await call(`${base}/${args.nodeId}`);
          const metadata = { ...(node.metadata ?? {}), plan: args.plan };

          return {
            updated: summarise(
              await call(`${base}/${args.nodeId}`, { method: 'PATCH', body: { metadata } })
            ),
          };
        }

        case 'delete':
          requireNode(args);
          // Soft, and it takes the whole subtree with it — restorable as one
          // unit by `restore`. Needs the delete consent scope, which the API
          // enforces on the method; a refusal arrives as FORBIDDEN_SCOPE.
          await call(`${base}/${args.nodeId}`, { method: 'DELETE' });
          return {
            deleted: args.nodeId,
            note: 'Soft deleted with everything under it. manage_outline restore brings the whole subtree back.',
          };

        case 'restore':
          requireNode(args);
          await call(`${base}/${args.nodeId}/restore`, { method: 'POST', body: {} });
          return { restored: args.nodeId };

        default:
          throw new ToolError(Code.REQUEST_FAILED, `Unknown action: ${action}`);
      }
    },
  },
];

function requireNode(args) {
  if (!args.nodeId) {
    throw new ToolError(Code.REQUEST_FAILED, `${args.action} needs a nodeId.`);
  }
}

/** What a caller needs back, not the whole row. */
const summarise = (n) => ({
  id: n.id,
  title: n.title,
  nodeType: n.nodeType,
  status: n.status,
  parentId: n.parentId ?? undefined,
});
