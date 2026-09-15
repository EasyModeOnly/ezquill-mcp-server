/**
 * Making sense of the binder, which is harder than it looks since epic #32.
 *
 * # Where prose lives now
 *
 * A BLOCK is a node row (`nodeType: 'block'`), one per top-level paragraph,
 * holding its own `document`, its own `order` and its own `contentVersion`.
 * When a section's prose is in blocks, **the section's own document is NULL**.
 *
 * So fetching a scene does not get you its prose. You have to list its block
 * children and put them back together, which is what `assembleProse` does.
 *
 * # Why `hasProse` alone cannot tell a folder from a scene
 *
 * The schema's container flag is "document IS NULL". By that rule:
 *
 *   - a Part with chapters under it is a container. It is a folder.
 *   - a scene whose prose is in blocks is a container. It is NOT a folder.
 *   - a block that is planned and not yet written is a container. It is not a
 *     folder either — it is an empty paragraph.
 *
 * The codebase states the third case outright: "a block that has been planned
 * and not yet written has a NULL document, so it IS a container by the schema's
 * definition and is NOT a folder by the writer's."
 *
 * An agent handed raw `hasProse` would call a novel thousands of folders. So
 * `classify` answers the question the writer would recognise instead.
 */

export const BLOCK = 'block';

export const isBlock = (node) => node?.nodeType === BLOCK;

/**
 * A section's aim (`metadata.aim`): its thesis, purpose or angle. Undefined when
 * unset, so it drops out of JSON rather than reading as an empty claim.
 */
/** Candidate titles not in use (`metadata.alternateTitles`). Undefined when none. */
export const alternateTitlesOf = (node) => {
  const list = node?.metadata?.alternateTitles;
  if (!Array.isArray(list)) return undefined;
  const titles = list.filter((t) => typeof t === 'string' && t.trim());
  return titles.length > 0 ? titles : undefined;
};

export const aimOf = (node) => {
  const aim = node?.metadata?.aim;
  return typeof aim === 'string' && aim.trim() ? aim : undefined;
};

/**
 * What this node IS, in the words a writer would use.
 *
 * @returns {'scene'|'folder'|'unwritten'|'paragraph'}
 */
export function classify(node, children = []) {
  if (isBlock(node)) return 'paragraph';

  // Its own prose, the pre-#32 shape and still legal: a chapter may hold prose
  // directly, delegate to child scenes, or both.
  if (node?.hasProse) return 'scene';

  const blocks = children.filter(isBlock);
  if (blocks.length > 0) {
    // Prose in blocks. Written if any block has words in it; a section of
    // nothing but plans is still an outline rather than a draft.
    return blocks.some((b) => b.hasProse) ? 'scene' : 'unwritten';
  }

  if (children.length > 0) return 'folder';

  // Nothing under it and nothing in it: a declared level nobody has started.
  return 'unwritten';
}

/** Ascending by `order`, which is a float and may be fractional. */
export const byOrder = (a, b) => (a?.order ?? 0) - (b?.order ?? 0);

/**
 * Put a section's prose back together from its blocks.
 *
 * Paragraph order is `order`, not array order — the API sorts by it but a
 * caller that merged pages cannot assume that survived.
 *
 * Unwritten blocks contribute NOTHING to the prose rather than a blank line:
 * a plan is not an empty paragraph the writer typed, and rendering it as one
 * would put gaps in a manuscript that does not have them.
 */
export function assembleProse(section, blocks) {
  const written = [...blocks]
    .sort(byOrder)
    .filter((b) => b.hasProse && b.content?.plainText);

  if (written.length > 0) {
    return written.map((b) => b.content.plainText.trim()).join('\n\n');
  }

  // Pre-blocks section, or a chapter written directly.
  return section?.content?.plainText?.trim() ?? '';
}

/**
 * The outline lines for a section: what each paragraph is FOR.
 *
 * A block's plan is `metadata.plan`; a block with prose and no plan gets a
 * 90-character `excerpt` from the server instead, derived in the SELECT
 * precisely because the light projection withholds the body it would come from.
 */
export function planLines(blocks) {
  return [...blocks].sort(byOrder).map((b) => ({
    id: b.id,
    plan: b.metadata?.plan ?? null,
    // What the one paragraph has to cover. Omitted when there are none.
    ...(Array.isArray(b.metadata?.planPoints) && b.metadata.planPoints.length > 0
      ? { points: b.metadata.planPoints }
      : {}),
    excerpt: b.excerpt ?? null,
    written: Boolean(b.hasProse),
  }));
}

/**
 * Nest a flat node list, dropping blocks.
 *
 * Blocks are excluded because a binder row per paragraph is meaningless — the
 * same reason every view in the app filters them out.
 */
export function buildTree(nodes) {
  const structural = nodes.filter((n) => !isBlock(n));
  const blocksByParent = new Map();
  for (const node of nodes) {
    if (!isBlock(node) || !node.parentId) continue;
    const list = blocksByParent.get(node.parentId) ?? [];
    list.push(node);
    blocksByParent.set(node.parentId, list);
  }

  const byId = new Map(structural.map((n) => [n.id, { node: n, children: [] }]));
  const roots = [];

  for (const entry of byId.values()) {
    const parent = entry.node.parentId ? byId.get(entry.node.parentId) : null;
    if (parent) parent.children.push(entry);
    else roots.push(entry);
  }

  const shape = (entry) => {
    const childNodes = entry.children.map((c) => c.node);
    const blocks = blocksByParent.get(entry.node.id) ?? [];
    return {
      id: entry.node.id,
      title: entry.node.title,
      nodeType: entry.node.nodeType,
      status: entry.node.status,
      wordCount: entry.node.wordCount,
      // What this section has to argue or do (a post's thesis, a scene's
      // purpose). Not the synopsis in `description`. Omitted when unset.
      aim: aimOf(entry.node),
      alternateTitles: alternateTitlesOf(entry.node),
      kind: classify(entry.node, [...childNodes, ...blocks]),
      children: entry.children.sort((a, b) => byOrder(a.node, b.node)).map(shape),
    };
  };

  return roots.sort((a, b) => byOrder(a.node, b.node)).map(shape);
}
