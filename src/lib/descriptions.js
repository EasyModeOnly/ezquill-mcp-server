/**
 * Writing a picture's description: a storyboard frame's (epic #56) or a comic
 * panel's (epic #57). Both keep it in the node's OWN document, written through
 * the content route; the two tools differ only in what they call the node.
 *
 * # Safe by construction (Decision c6378e77)
 *
 * Writing a description into a picture that has none is additive. REPLACING
 * one somebody wrote first keeps the old one as a version of the node, so the
 * change is restorable from its history rather than a silent overwrite, and
 * the write itself carries `ifContentVersion`: a description changed by
 * somebody else since it was read is refused (and the refused text kept as a
 * version by the API) rather than clobbered.
 */
import { call } from './api.js';
import { descriptionDocument, descriptionOf } from './frames.js';

/**
 * Replace `node`'s description with `description`.
 *
 * @param {string} projectId
 * @param {object} node the node as just read (its content and contentVersion)
 * @param {string} description the whole new description, one paragraph per line
 * @param {string} what the node's name in the kept version's label ("Frame", "Panel")
 * @returns {Promise<{unchanged: true, description: string} | {updated: object, previous?: string, keptVersion?: string|true}>}
 */
export async function replaceDescription(projectId, node, description, what) {
  const next = descriptionDocument(description);
  const previous = descriptionOf(node);
  if (previous === next.plainText) return { unchanged: true, description: previous };

  // Replacing somebody's words: keep them as a version first. With no body
  // content the API snapshots the node's current document itself, so what is
  // kept is what is stored, not what this connector believes is stored.
  let keptVersion;
  if (previous) {
    const version = await call(`/projects/${projectId}/nodes/${node.id}/versions`, {
      method: 'POST',
      body: { type: 'manual', description: `${what} description before an agent replaced it` },
    });
    keptVersion = version?.id ?? true;
  }

  const updated = await call(`/projects/${projectId}/nodes/${node.id}/content`, {
    method: 'PUT',
    body: {
      ...next,
      // Written only over the description that was read: a change made since
      // is refused with STALE_CONTENT rather than either write vanishing.
      ...(typeof node.contentVersion === 'number' ? { ifContentVersion: node.contentVersion } : {}),
    },
  });

  return {
    updated: { ...updated, content: updated?.content ?? next },
    ...(previous ? { previous, keptVersion } : {}),
  };
}
