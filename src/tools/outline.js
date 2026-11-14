import { call, callPaged } from '../lib/api.js';
import { aimOf, alternateTitlesOf, assembleProse, sumWords, buildTree, byOrder, isBlock, ordinalOf, planLines } from '../lib/nodes.js';
import { descriptionOf, frameFieldsOf, isFrame } from '../lib/frames.js';
import { isPanel, lettering, letteringRevision, letteringWithNames, panelLayout } from '../lib/panels.js';

export const tools = [
  {
    name: 'get_outline',
    description:
      'The structure of a project: its parts, chapters and scenes, with status, ' +
      'word counts and each numbered node\'s ordinal ("Ep. 3", "Shot 10A"), which ' +
      'ezQuill derives from position. Storyboard frames appear under their scene as ' +
      'kind "frame" with their framing and line; they are pictures, not scenes to ' +
      'write, and their words are not counted. A comic\'s panels appear under their ' +
      'page as kind "panel" with ordinal, framing, box and a count of their lettering. ' +
      'Returns no prose, frame or panel descriptions, or lettering — use read_scene.',
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
      'Read one scene: its prose, its outline plan, which characters and places ' +
      'appear in it, and its storyboard frames (each frame\'s ordinal, framing, line ' +
      'and description, kept apart from the prose). On a comic page it lists the ' +
      'panels: description, framing, box, and lettering with each speaker named. One ' +
      'node at a time — to find a scene, use search_project or get_outline. Read on a ' +
      'frame or a panel, it returns that one.',
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
      // A frame is read as a frame: its description is its own document and
      // is not prose, so it is never reported as the scene's text or counted.
      if (isFrame(node)) {
        return {
          id: node.id,
          title: node.title,
          ordinal: ordinalOf(node),
          nodeType: node.nodeType,
          kind: 'frame',
          parentId: node.parentId ?? undefined,
          ...frameFieldsOf(node),
          description: descriptionOf(node) ?? '',
          contentVersion: node.contentVersion,
        };
      }
      if (isPanel(node)) {
        const [panel] = await panelsInFull(projectId, [node]);
        return { ...panel, parentId: node.parentId ?? undefined, contentVersion: node.contentVersion };
      }
      // A shot's production, in brief (ezquill epic #38): its status and its
      // takes. get_production scope "shot" has the whole of it.
      const production = node.nodeType === 'shot' ? await shotProduction(projectId, nodeId, node) : undefined;

      const blocks = children.filter(isBlock).sort(byOrder);
      const structural = children.filter((c) => !isBlock(c) && !isFrame(c) && !isPanel(c)).sort(byOrder);
      // The scene's storyboard (epic #56). Listed apart from the prose and
      // never assembled into it: a frame describes a picture, and its words
      // are not the manuscript (Decision 83aa524b).
      const frames = children.filter(isFrame).sort(byOrder);
      // A comic page's panels (epic #57), the same way: pictures with their
      // lettering, never assembled into the page's own text.
      const panels = await panelsInFull(projectId, children.filter(isPanel).sort(byOrder));

      return {
        id: node.id,
        title: node.title,
        ordinal: ordinalOf(node),
        nodeType: node.nodeType,
        status: node.status,
        // The scene's own prose plus its paragraphs: since prose moved into
        // block rows the node's own count is 0 for any scene written since.
        wordCount: (node.wordCount ?? 0) + sumWords(blocks),
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
        children: structural.map((c) => ({
          id: c.id,
          title: c.title,
          ordinal: ordinalOf(c),
          nodeType: c.nodeType,
        })),
        ...(frames.length > 0
          ? {
              frames: frames.map((f) => ({
                id: f.id,
                ordinal: ordinalOf(f),
                ...(f.title ? { title: f.title } : {}),
                ...frameFieldsOf(f),
                description: descriptionOf(f) ?? '',
              })),
            }
          : {}),
        ...(panels.length > 0 ? { panels } : {}),
        ...(production ? { production } : {}),
      };
    },
  },
];

/**
 * Panels as read_scene returns them: description, framing, box, and lettering
 * with each speaker's NAME, resolved from the project's characters at read
 * time, as the app does. The characters are read only when a panel has a
 * speaker, and a failure to read them leaves the ids rather than failing.
 */
async function panelsInFull(projectId, panels) {
  if (panels.length === 0) return [];
  const speaking = panels.some((p) => lettering(p).some((i) => i.speakerId));
  const characters = speaking
    ? await callPaged(`/projects/${projectId}/entities`, 'entities', { kind: 'character', limit: 1000 }).catch(() => [])
    : [];
  const names = new Map(characters.map((c) => [c.id, c.name]));
  return panels.map((p) => {
    const { framing } = frameFieldsOf(p);
    return {
      id: p.id,
      ordinal: ordinalOf(p),
      ...(p.title ? { title: p.title } : {}),
      kind: 'panel',
      ...(framing ? { framing } : {}),
      description: descriptionOf(p) ?? '',
      ...panelLayout(p),
      lettering: letteringWithNames(p, names),
      // Send this back as ifRevision with manage_comic set_lettering.
      letteringRevision: letteringRevision(p),
    };
  });
}

/**
 * A shot's production at a glance: status, how many takes, which is locked.
 * A take is a version whose content carries `take`; a failure to read them
 * leaves the summary out rather than failing the read of the scene.
 */
async function shotProduction(projectId, nodeId, node) {
  const listed = await call(`/projects/${projectId}/nodes/${nodeId}/versions`, { query: { limit: 500 } }).catch(
    () => null
  );
  const takes = (listed?.versions ?? []).filter((v) => v.content && typeof v.content.take === 'object');
  const locked = takes.find((v) => v.content.take.status === 'accepted');
  return {
    status: node.productionStatus ?? null,
    ...(node.productionNote ? { note: node.productionNote } : {}),
    takeCount: takes.length,
    lockedTakeId: locked?.id ?? null,
  };
}

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
