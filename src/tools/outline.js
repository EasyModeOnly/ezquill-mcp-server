import { call, callPaged } from '../lib/api.js';
import { aimOf, alternateTitlesOf, assembleProse, buildTree, byOrder, isBlock, planLines } from '../lib/nodes.js';

export const tools = [
  {
    name: 'get_outline',
    description:
      'The structure of a project: its parts, chapters and scenes, with status and ' +
      'word counts. Returns no prose — use read_scene for that.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        parentId: {
          type: 'string',
          description: 'Limit to one branch. Omit for the whole binder.',
        },
      },
      required: ['projectId'],
    },
    annotations: { readOnlyHint: true },

    async handler({ projectId, parentId }) {
      // omitContent because a large project is 52.7 MB with bodies and 5.7 MB
      // without, and nothing here renders prose.
      //
      // Blocks are NOT excluded at the API, even though they are excluded from
      // the tree: buildTree needs them to tell a written scene from a folder.
      // They are dropped on the way out instead.
      const nodes = await callPaged(`/projects/${projectId}/nodes`, 'nodes', {
        omitContent: true,
        limit: 10000,
      });

      const scoped = parentId ? descendantsOf(nodes, parentId) : nodes;
      return { outline: buildTree(scoped) };
    },
  },

  {
    name: 'read_scene',
    description:
      'Read one scene: its prose, its outline plan, and which characters and places ' +
      'appear in it. One node at a time — to find a scene, use search_project or get_outline.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        nodeId: { type: 'string', description: 'From get_outline or a search result.' },
      },
      required: ['projectId', 'nodeId'],
    },
    annotations: { readOnlyHint: true },

    async handler({ projectId, nodeId }) {
      // Three calls folded into one tool. The node alone is not enough: since
      // epic #32 a written scene's own `document` is NULL because its prose
      // lives in child BLOCK rows, so fetching the node and reporting its
      // content would report an empty scene for every scene actually written.
      const [node, children, cast] = await Promise.all([
        call(`/projects/${projectId}/nodes/${nodeId}`),
        callPaged(`/projects/${projectId}/nodes`, 'nodes', { parentId: nodeId, limit: 10000 }),
        call(`/projects/${projectId}/nodes/${nodeId}/entities`).catch(() => null),
      ]);

      const blocks = children.filter(isBlock).sort(byOrder);
      const structural = children.filter((c) => !isBlock(c)).sort(byOrder);

      return {
        id: node.id,
        title: node.title,
        nodeType: node.nodeType,
        status: node.status,
        wordCount: node.wordCount,
        aim: aimOf(node),
        alternateTitles: alternateTitlesOf(node),
        prose: assembleProse(node, blocks),
        // The outline lines beside the prose. A planned-but-unwritten block
        // shows what the writer intends to put there, which is exactly the
        // context an agent asked to help with a scene needs.
        plan: blocks.length > 0 ? planLines(blocks) : undefined,
        cast: (cast?.cast ?? []).map((c) => ({
          entityId: c.entityId,
          name: c.name,
          kind: c.kind,
          // Raw, not a label: pov / present / setting / mentioned for fiction,
          // cited elsewhere. An agent wants the enum.
          role: c.role,
        })),
        storyTime:
          node.storyTimeStart === undefined && node.storyTimeEnd === undefined
            ? undefined
            : { start: node.storyTimeStart, end: node.storyTimeEnd },
        // A chapter that delegates to child scenes rather than holding prose.
        children: structural.map((c) => ({ id: c.id, title: c.title, nodeType: c.nodeType })),
      };
    },
  },
];

/** The subtree under parentId, parent included, from a flat list. */
function descendantsOf(nodes, parentId) {
  const byParent = new Map();
  for (const n of nodes) {
    const list = byParent.get(n.parentId ?? null) ?? [];
    list.push(n);
    byParent.set(n.parentId ?? null, list);
  }

  const root = nodes.find((n) => n.id === parentId);
  if (!root) return [];

  const out = [root];
  const queue = [parentId];
  while (queue.length > 0) {
    for (const child of byParent.get(queue.pop()) ?? []) {
      out.push(child);
      queue.push(child.id);
    }
  }
  return out;
}
