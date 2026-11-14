/**
 * Storyboard frames (ezquill epic #56): one picture of a scene, as a node.
 *
 * # What a frame is on the wire
 *
 * A node with `nodeType: 'frame'`, the child of a scene, numbered "Frame N"
 * within it by the API (the ordinal is served, never counted here). It has
 * three fields a writer fills:
 *
 * - **Description**: the node's OWN document (Tiptap JSON + plainText), written
 *   through `PUT /nodes/{id}/content` with the version guard. Never in blocks —
 *   the API refuses a block save under a frame, because a frame's words are
 *   left out of every word count and of the export by its row alone (Decision
 *   83aa524b), and words in blocks beneath it would count as manuscript.
 * - **Line**: one line of dialogue or a caption, `metadata.frame.line =
 *   { kind, text }`. Plain text, attributed to nobody.
 * - **Framing**: `metadata.frame.framing`, free text; the app offers the
 *   FRAMINGS below.
 *
 * `nodes.metadata` is ASSIGNED on PATCH, not merged, so `withFrameFields`
 * returns the WHOLE object rebuilt from the row that was read.
 *
 * Only a STORY has frames. A script's storyboard cards are its shots, never
 * frames (Decision 1d59ef3b), and their framing is the shot's own
 * (`manage_production set_shot`).
 *
 * The web app's model is `lib/storyboard/board.ts`; this reads the same
 * fields and does not copy its code.
 */

export const FRAME = 'frame';

export const isFrame = (node) => node?.nodeType === FRAME;

/** The framings the app's picker offers, wide to tight. Advisory: any text is stored. */
export const FRAMINGS = ['Wide', 'Medium', 'Close-up', 'Extreme close-up', 'Over-the-shoulder', 'Insert'];

export const LINE_KINDS = ['dialogue', 'caption'];

const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

const text = (value) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
};

/**
 * A frame's line and framing, read defensively: `metadata` is a blob the API
 * accepts whole, so a malformed value reads as unset rather than failing a read.
 * Keys are omitted when unset.
 */
export function frameFieldsOf(node) {
  const frame = asRecord(asRecord(node?.metadata).frame);
  const line = asRecord(frame.line);
  const lineText = text(line.text);
  const framing = text(frame.framing);
  return {
    ...(framing ? { framing } : {}),
    ...(lineText ? { line: { kind: line.kind === 'caption' ? 'caption' : 'dialogue', text: lineText } } : {}),
  };
}

/**
 * A line as a caller sent it, checked: `{ kind, text }`, kind defaulting to
 * dialogue. `null` (or an empty text) means "clear it" and returns null.
 * Throws a plain Error naming the problem; the tool turns it into a refusal.
 */
export function normaliseLine(line) {
  if (line === null) return null;
  if (typeof line === 'string') line = { text: line };
  if (!line || typeof line !== 'object') throw new Error('`line` must be { kind, text } or null.');
  const kind = line.kind ?? 'dialogue';
  if (!LINE_KINDS.includes(kind)) {
    throw new Error(`A line's kind is "dialogue" or "caption", not "${kind}".`);
  }
  const lineText = text(line.text);
  return lineText ? { kind, text: lineText } : null;
}

/**
 * The WHOLE metadata object to PATCH back with a frame's fields changed.
 *
 * `patch.framing` and `patch.line` are applied only when present as keys: a
 * blank framing or a null line clears that field. Every other key of the
 * metadata — tags, numbering, anything another view keeps there — and every
 * other key of `frame` is carried over from the row that was read.
 */
export function withFrameFields(metadata, patch) {
  const base = asRecord(metadata);
  const frame = { ...asRecord(base.frame) };
  if ('framing' in patch) {
    const framing = text(patch.framing);
    if (framing) frame.framing = framing;
    else delete frame.framing;
  }
  if ('line' in patch) {
    if (patch.line) frame.line = patch.line;
    else delete frame.line;
  }
  return { ...base, frame };
}

/**
 * A description as the document and plain text a content save takes: one
 * paragraph per line, blank lines dropped — the same reading the app's card
 * makes, so the editor, versions and search treat it like any other document.
 */
export function descriptionDocument(description) {
  const lines = String(description ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    document: {
      type: 'doc',
      content: lines.map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })),
    },
    plainText: lines.join('\n'),
  };
}

/** A frame's description as stored, or undefined when it has none. */
export const descriptionOf = (node) => text(node?.content?.plainText);
