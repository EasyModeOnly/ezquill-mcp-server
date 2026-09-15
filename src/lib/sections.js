/**
 * What a section's paragraphs are, and whether new ones may be added to it.
 *
 * Shared by every tool that adds blocks to a section: write_draft's append,
 * which adds written paragraphs, and manage_outline's add_lines, which adds
 * planned ones. Both compose the same whole-section reconcile, so both must
 * send every existing block back, and both face the same pre-blocks section.
 */
import { call, callPaged } from './api.js';
import { ToolError, Code } from './errors.js';
import { byOrder, isBlock } from './nodes.js';

/** A section's live blocks, in paragraph order. */
export async function sectionBlocks(projectId, nodeId) {
  return (
    await callPaged(`/projects/${projectId}/nodes`, 'nodes', { parentId: nodeId, limit: 10000 })
  )
    .filter(isBlock)
    .sort(byOrder);
}

/**
 * A section whose prose still lives in its OWN document, from before prose
 * moved into blocks.
 *
 * Appending would need `adoptSectionProse`, which nulls the section's document
 * in the same transaction — and that is a migration, not an append. Splitting
 * existing prose into paragraphs is the editor's job, and getting it wrong here
 * would silently reshape a manuscript. Refused, with the state named, rather
 * than attempted.
 *
 * # Except a document with NOTHING in it, which is adopted
 *
 * The wizard, the kickoff and create_project all plant a prose level with an
 * empty document — that is what makes a chapter writable on the day it is
 * made. Refusing those made every freshly planted chapter unwritable from the
 * connector, which was found by creating a project and trying to write in it.
 * An empty document has nothing to split, so adopting it is exactly what the
 * editor does when it seeds itself from one.
 *
 * "Empty" means no content NODES, not no text: a document holding only an
 * image has no plain text either, and nulling it would delete the image. That
 * is the same reason the API makes adoption a flag rather than inferring it.
 *
 * @returns {Promise<boolean>} whether the save must adopt the section's document
 */
export async function refuseUnmigrated(projectId, nodeId, blocks) {
  if (blocks.length > 0) return false;

  const node = await call(`/projects/${projectId}/nodes/${nodeId}`);
  // A paragraph cannot hold paragraphs. Blocks created under one would be
  // invisible to every view, which lists a section's blocks and stops there.
  if (isBlock(node)) {
    throw new ToolError(
      Code.REQUEST_FAILED,
      'That id is a paragraph, not a section. Pass the scene, chapter or post it belongs to.'
    );
  }
  if (node?.hasProse && isEmptyDocument(node.content?.document)) return true;
  if (node?.hasProse) {
    throw new ToolError(
      Code.REQUEST_FAILED,
      'This scene\'s prose is not split into paragraphs yet, so adding paragraphs would mean ' +
        'restructuring what is already there. Open it in ezQuill once, then try again. ' +
        'You can still propose changes to it with action "revise".'
    );
  }
  return false;
}

/** A Tiptap doc with no content nodes at all. An absent document is not one. */
const isEmptyDocument = (doc) =>
  Boolean(doc) && typeof doc === 'object' && (!Array.isArray(doc.content) || doc.content.length === 0);
