/**
 * Storyboard frames (ezquill epic #56): one picture of a scene, as a node.
 *
 * # What a frame is on the wire
 *
 * A node with `nodeType: 'frame'`, numbered "Frame N" within its parent by
 * the API (the ordinal is served, never counted here). See "Where a frame
 * goes" below for which parent. It has three fields a writer fills:
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
import { callPaged, call } from './api.js';
import { ToolError, Code } from './errors.js';
// A cycle (nodes.js imports isFrame from here), safe because neither module
// uses the other's bindings while it is being evaluated, only inside functions.
import { byOrder, ordinalOf } from './nodes.js';

export const FRAME = 'frame';

/**
 * # Where a frame goes (ezquill task #749, owner's decision 2026-11-24)
 *
 * Under the LOWEST level that carries prose: a scene, or a chapter written
 * with no scenes. A chapter that has scenes is above the board's groups, and
 * its frames go on its scenes. The served registry lists both scene and
 * chapter as a frame's parent, because a book can be both at once (one chapter
 * split into scenes, the next not); which node actually takes frames depends
 * on what is beneath it, so that half is checked here, against its children.
 * The API stores a frame under anything, so for an AI client this is the only
 * guard. The app's version is `holdsCards` in lib/storyboard/board.ts.
 *
 * The app still SHOWS frames already sitting on a chapter that later got
 * scenes (it never orphans a card), so this steers new frames rather than
 * passing judgement on old ones.
 */
export const WHERE_FRAMES_GO =
  'Frames sit under the lowest level that carries prose: a scene, or a chapter written with no scenes.';

// Children that are not sections of the binder: paragraphs, and the levels
// that stay off the page (pictures and a script's shots). The app's
// OFF_PAGE_NODE_TYPES plus `block`.
const NOT_SECTIONS = new Set(['block', FRAME, 'panel', 'shot']);

/**
 * The sections directly beneath a node (a chapter's scenes), in the order
 * given. Non-empty means the node is NOT the lowest prose level, so frames
 * belong on these instead.
 */
export const sectionsAmong = (children) =>
  (Array.isArray(children) ? children : []).filter((c) => c && !NOT_SECTIONS.has(c.nodeType));

export const isFrame = (node) => node?.nodeType === FRAME;

/**
 * Refuse a parent that does not take frames, before anything is sent. The ONE
 * copy of the rule for every path that can put a frame somewhere: manage_storyboard
 * add_frames, and manage_outline add (nodeType "frame") and move (task #881).
 *
 * Two checks. When `levels` is given, the parent's level must be one the
 * SERVED registry puts frames under (a scene, a chapter), not whatever id was
 * passed — and the top of the project is no level at all. And the parent must
 * be the lowest prose level: a chapter with sections beneath it is above the
 * board's groups, so a frame on it is not where the writer looks for that
 * picture. That refusal names the sections, in order with their ids, so the
 * model can pick the one the picture belongs to rather than guess.
 *
 * `count` and `verb` only word the refusal ("Add these frames…", "Move this
 * frame…"). Returns the parent's children, which add_frames reuses to place
 * afterFrameId, so the check costs no extra request there.
 */
export async function requireFrameHolder(projectId, parentId, levels, { count = 2, verb = 'Add' } = {}) {
  const one = count === 1;
  const these = one ? 'this frame' : 'these frames';
  const picture = one ? 'it pictures' : 'they picture';

  const target = parentId ? await call(`/projects/${projectId}/nodes/${parentId}`) : null;
  if (levels) {
    const parents = levels.filter((l) => (l.children ?? []).includes(FRAME)).map((l) => l.key);
    if (!target || !parents.includes(target.nodeType)) {
      const where = target ? `that id is a ${target.nodeType ?? 'node'}` : 'the top level of the project is not one';
      throw new ToolError(
        Code.REQUEST_FAILED,
        `Frames go under a ${parents.join(' or ') || 'scene'}, and ${where}. ` +
          `${WHERE_FRAMES_GO} Pass the scene ${one ? 'the frame pictures' : 'the frames picture'}.`,
        { nodeType: target?.nodeType ?? null, parents }
      );
    }
  }
  if (!target) return [];

  const children = await callPaged(`/projects/${projectId}/nodes`, 'nodes', { parentId, omitContent: true, limit: 10000 });
  const sections = sectionsAmong(children).sort(byOrder);
  if (sections.length === 0) return children;

  const kind = target.nodeType;
  const shown = sections.slice(0, MAX_NAMED);
  const more = sections.length - shown.length;
  throw new ToolError(
    Code.REQUEST_FAILED,
    `${subject(target, kind)} has ${sections.length === 1 ? 'a' : sections.length} ` +
      `${sections.length === 1 ? sectionNoun(sections) : `${sectionNoun(sections)}s`} beneath it, so it takes no frames ` +
      `itself. ${WHERE_FRAMES_GO} ${verb} ${these} to the one ${picture}: ` +
      shown.map((n) => `${label(n, n.nodeType)} (nodeId ${n.id})`).join('; ') +
      (more > 0 ? `; and ${more} more (get_outline lists them).` : '.'),
    {
      nodeType: kind,
      sections: sections.map((n) => ({ id: n.id, nodeType: n.nodeType, title: n.title || undefined, ordinal: ordinalOf(n)?.display })),
    }
  );
}

/** Sections one refusal names before saying how many more there are. */
const MAX_NAMED = 20;

/** "scene", or the common level of the sections when they are not scenes. */
const sectionNoun = (sections) => {
  const types = new Set(sections.map((n) => n.nodeType));
  return types.size === 1 ? [...types][0] : 'section';
};

/** How a refusal lists a node: its number and title, whichever it has. */
const label = (node, kind) => {
  const ordinal = ordinalOf(node)?.display;
  const title = node?.title ? `"${node.title}"` : undefined;
  if (ordinal && title) return `${ordinal} ${title}`;
  return ordinal ?? (title ? `${kind} ${title}` : `untitled ${kind}`);
};

/** The node a refusal is about, to start a sentence. */
const subject = (node, kind) => {
  if (node?.title) return `The ${kind} "${node.title}"`;
  return ordinalOf(node)?.display ?? `This ${kind}`;
};

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
