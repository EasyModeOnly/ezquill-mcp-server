/**
 * Positions inside one paragraph block's Tiptap document.
 *
 * A comment's anchor is measured in ProseMirror positions inside its BLOCK's
 * own document (ezquill lib/editor/block-comment-anchor.ts), not in characters
 * of the assembled scene. A block document is `doc > paragraph > text…`, so the
 * paragraph opens at 0 and its first character sits at position 1 — which is
 * why offsets into plain text cannot simply be sent as they are.
 */

/** Every text leaf, joined — the same reading the web app's textOf makes. */
export function textOf(node) {
  if (!node || typeof node !== 'object') return '';
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? []).map(textOf).join('');
}

/**
 * The text of a document, with each character's ProseMirror position.
 * Non-text leaves (a hard break, an image) take a position and add no text.
 */
export function textPositions(doc) {
  const positions = [];
  let text = '';
  const walk = (node, pos) => {
    if (typeof node.text === 'string') {
      for (let i = 0; i < node.text.length; i += 1) positions.push(pos + i);
      text += node.text;
      return pos + node.text.length;
    }
    const children = node.content ?? [];
    if (children.length === 0) return pos + 1; // a leaf: one position
    let inner = pos + 1;
    for (const child of children) inner = walk(child, inner);
    return inner + 1;
  };
  let pos = 0; // the doc node has no opening position of its own
  for (const child of doc?.content ?? []) pos = walk(child, pos);
  return { text, positions };
}

/** A block-relative anchor for `quote` at character `start` of the block's text. */
export function anchorAt(doc, start, quote) {
  const { positions } = textPositions(doc);
  return { from: positions[start], to: positions[start + quote.length - 1] + 1, text: quote };
}

/** How many times `needle` occurs in `haystack`. */
export function occurrences(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) n += 1;
  return n;
}
