/**
 * Where a quoted passage sits in a section, as an anchor a server will take.
 *
 * Two writers need this: write_draft's `revise` (a suggested edit is a comment
 * anchored on the words it replaces) and the story-thread tools (a touch that
 * quotes prose is anchored on those words, ezquill epic #71). Both follow the
 * same rule, the one ezquill's `section-suggestion-target.ts` applies: the
 * quote must occur EXACTLY ONCE in the section, and inside one paragraph.
 * A quote found twice is refused rather than guessed at, because an anchor on
 * the wrong occurrence looks exactly like an anchor on the right one.
 *
 * Since prose moved into paragraph blocks, the anchor belongs to the BLOCK the
 * words are in, measured in that block's own ProseMirror positions
 * (ezquill lib/editor/block-comment-anchor.ts). A section whose prose is still
 * its own document keeps the old shape: anchored on the section, `inBlock`
 * false.
 */
import { call, callPaged } from './api.js';
import { ToolError, Code } from './errors.js';
import { assembleProse, isBlock } from './nodes.js';
import { anchorAt, occurrences, textOf } from './prose.js';

const textIn = (b) => (b.content?.document ? textOf(b.content.document) : (b.content?.plainText ?? ''));

/**
 * @returns {Promise<{ target: string, anchor: {from:number,to:number,text:string}, inBlock: boolean }>}
 *   `target` is the node to anchor on: a block when the prose is in blocks.
 */
export async function locateQuote(projectId, nodeId, quote) {
  const node = await call(`/projects/${projectId}/nodes/${nodeId}`);

  // Handed a paragraph rather than its section: the paragraph is the whole
  // haystack, and the anchor is in its own document.
  if (isBlock(node)) {
    const text = textIn(node);
    const n = occurrences(text, quote);
    if (n === 0) throw notFound();
    if (n > 1) throw ambiguous();
    const at = text.indexOf(quote);
    const doc = node.content?.document;
    return {
      target: node.id ?? nodeId,
      anchor: doc ? anchorAt(doc, at, quote) : { from: at + 1, to: at + 1 + quote.length, text: quote },
      inBlock: true,
    };
  }

  const children = await callPaged(`/projects/${projectId}/nodes`, 'nodes', { parentId: nodeId, limit: 10000 });
  const blocks = children.filter(isBlock);
  const prose = assembleProse(node, blocks);

  const first = prose.indexOf(quote);
  if (first === -1) throw notFound();
  if (prose.indexOf(quote, first + 1) !== -1) throw ambiguous();

  if (!blocks.some((b) => b.hasProse)) {
    return { target: nodeId, anchor: { from: first, to: first + quote.length, text: quote }, inBlock: false };
  }

  const holder = blocks.find((b) => occurrences(textIn(b), quote) === 1);
  if (!holder) {
    throw new ToolError(
      Code.REQUEST_FAILED,
      'Those words run across more than one paragraph. Quote a passage inside a single paragraph.'
    );
  }
  const doc = holder.content.document;
  // Without the document (a listing that withheld it), a block is one
  // paragraph of text, whose first character is position 1.
  const at = textIn(holder).indexOf(quote);
  return {
    target: holder.id,
    anchor: doc ? anchorAt(doc, at, quote) : { from: at + 1, to: at + 1 + quote.length, text: quote },
    inBlock: true,
  };
}

const notFound = () =>
  new ToolError(
    Code.REQUEST_FAILED,
    'Those words are not in this scene. Quote the text exactly as read_scene returned it.'
  );

const ambiguous = () =>
  new ToolError(
    Code.REQUEST_FAILED,
    'Those words appear more than once in this scene, so the anchor would be ambiguous. ' +
      'Quote a longer passage that occurs only once.'
  );
