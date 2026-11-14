/**
 * Comic panels (ezquill epic #57): a picture on a page, as a node.
 *
 * # What a panel is on the wire
 *
 * A node with `nodeType: 'panel'`, the child of a page (a webtoon's episode),
 * numbered "Panel N" within it by the API. It is built on the storyboard frame
 * (lib/frames.js): its DESCRIPTION is its own document, written through
 * `PUT /nodes/{id}/content`, never in blocks, and its FRAMING is
 * `metadata.frame.framing`. Like a frame, its words are not manuscript.
 *
 * What a frame does not have lives in `metadata.panel` (ezquill #708):
 *
 *   panel: { box: {x, y, w, h}, z, lettering: [ … ], letteringRevision }
 *
 * That key is OWNED BY THE API. PATCH /nodes keeps the stored value whatever
 * a body sends (so it is silently ignored there, never an error), and a create
 * naming it is refused. The only writers are:
 *
 * - `PUT /projects/{id}/nodes/{nodeId}/panel/lettering` — `{ items,
 *   ifRevision }`, the whole list in reading order. A list someone replaced
 *   since `ifRevision` was read is refused with a 409.
 * - `PUT /projects/{id}/nodes/panel-boxes` — `{ items: [{ nodeId, box, z }] }`,
 *   one transaction: every box lands or none does.
 *
 * Lettering items are one of four kinds, each with only its own fields (the
 * API decodes them strictly, so a stray field is a 400):
 *
 * - `balloon`: `speakerId` (a CHARACTER entity id, never a name), `text`,
 *   optional `offPanel`;
 * - `thought`: `speakerId`, `text`;
 * - `caption`: `text`, optional `captionKind` narration | location | time;
 * - `sfx`: `text`.
 *
 * The web app's model is `lib/comic/panel.ts`, and the Go API's
 * `api/internal/core/nodes/panel.go` is the authority on every rule; this reads
 * the same fields and copies neither.
 */

export const PANEL = 'panel';

export const isPanel = (node) => node?.nodeType === PANEL;

export const LETTERING_KINDS = ['balloon', 'thought', 'caption', 'sfx'];
export const CAPTION_KINDS = ['narration', 'location', 'time'];

/** Limits the API enforces, checked first so a refusal names the item. */
export const MAX_LETTERING_ITEMS = 40;
export const MAX_LETTERING_TEXT = 1000;
export const MAX_SFX_TEXT = 200;

const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const str = (value) => (typeof value === 'string' ? value : '');
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

const panelOf = (node) => asRecord(asRecord(node?.metadata).panel);

/** One stored item, or undefined when it does not read as one. */
function readItem(value) {
  const raw = asRecord(value);
  const id = str(raw.id);
  if (!id) return undefined;
  const text = str(raw.text);
  switch (raw.kind) {
    case 'balloon':
      return str(raw.speakerId)
        ? { id, kind: 'balloon', speakerId: raw.speakerId, text, ...(raw.offPanel === true ? { offPanel: true } : {}) }
        : undefined;
    case 'thought':
      return str(raw.speakerId) ? { id, kind: 'thought', speakerId: raw.speakerId, text } : undefined;
    case 'caption':
      return {
        id,
        kind: 'caption',
        text,
        ...(CAPTION_KINDS.includes(raw.captionKind) ? { captionKind: raw.captionKind } : {}),
      };
    case 'sfx':
      return { id, kind: 'sfx', text };
    default:
      return undefined;
  }
}

/** A panel's lettering in reading order; items that do not read are skipped. */
export function lettering(node) {
  const list = panelOf(node).lettering;
  return Array.isArray(list) ? list.map(readItem).filter(Boolean) : [];
}

/** The revision to send back as `ifRevision`. 0 before any write. */
export function letteringRevision(node) {
  const rev = panelOf(node).letteringRevision;
  return finite(rev) && rev >= 0 ? Math.floor(rev) : 0;
}

/**
 * A panel's box and z. A box that is not four finite numbers with a positive
 * width and height reads as none (the app places the panel automatically).
 */
export function panelLayout(node) {
  const panel = panelOf(node);
  const { x, y, w, h } = asRecord(panel.box);
  const z = finite(panel.z) ? Math.trunc(panel.z) : 0;
  const box = [x, y, w, h].every(finite) && w > 0 && h > 0 ? { x, y, w, h } : undefined;
  return { ...(box ? { box } : {}), z };
}

/**
 * The lettering in brief, for the outline: how many of each kind, and how many
 * speakers. No words — those are read_scene's.
 */
export function letteringSummary(node) {
  const items = lettering(node);
  const counts = { balloon: 0, thought: 0, caption: 0, sfx: 0 };
  const speakers = new Set();
  for (const item of items) {
    counts[item.kind] += 1;
    if (item.speakerId) speakers.add(item.speakerId);
  }
  return { items: items.length, ...counts, speakers: speakers.size };
}

/**
 * The lettering in full, each speaker resolved to a name from `names`
 * (id → name). A speaker that no longer resolves reads as "Unknown speaker",
 * with the id kept beside it so an agent can see which.
 */
export function letteringWithNames(node, names) {
  return lettering(node).map((item) =>
    item.speakerId ? { ...item, speaker: names.get(item.speakerId) ?? 'Unknown speaker' } : item
  );
}

/**
 * Resolve the speakers of a lettering list a caller sent, and check every item
 * against the API's per-kind shape before anything is sent.
 *
 * A balloon or thought names its speaker by `speakerId` or by `speaker` (a
 * name). An id must be one of `characters`; a name must match exactly one of
 * them, ignoring case and surrounding space. Anything else throws a plain
 * Error naming the item, which the tool turns into a refusal: a balloon is
 * never written with a speaker the connector guessed.
 *
 * Returns the items as the API takes them: only each kind's own fields.
 *
 * @param {unknown[]} items
 * @param {{id: string, name: string}[]} characters the project's (and its series') characters
 */
export function resolveLettering(items, characters) {
  if (!Array.isArray(items)) throw new Error('`items` must be a list (an empty one clears the lettering).');
  if (items.length > MAX_LETTERING_ITEMS) {
    throw new Error(`A panel holds at most ${MAX_LETTERING_ITEMS} lettering items.`);
  }
  const byId = new Map(characters.map((c) => [c.id, c]));
  const byName = new Map();
  for (const c of characters) {
    const key = String(c.name ?? '').trim().toLowerCase();
    if (!key) continue;
    byName.set(key, [...(byName.get(key) ?? []), c]);
  }

  return items.map((raw, i) => {
    const where = `items[${i}]`;
    const item = asRecord(raw);
    if (!LETTERING_KINDS.includes(item.kind)) {
      throw new Error(`${where}: kind must be one of ${LETTERING_KINDS.join(', ')}.`);
    }
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    const max = item.kind === 'sfx' ? MAX_SFX_TEXT : MAX_LETTERING_TEXT;
    if ([...text].length > max) throw new Error(`${where}: text is at most ${max} characters for a ${item.kind}.`);
    const id = typeof item.id === 'string' && item.id.trim() ? { id: item.id.trim() } : {};

    if (item.kind === 'caption') {
      if (item.speaker !== undefined || item.speakerId !== undefined) {
        throw new Error(`${where}: a caption has no speaker. Use a balloon or a thought for a character's words.`);
      }
      if (item.captionKind !== undefined && !CAPTION_KINDS.includes(item.captionKind)) {
        throw new Error(`${where}: captionKind must be one of ${CAPTION_KINDS.join(', ')}.`);
      }
      return { ...id, kind: 'caption', text, ...(item.captionKind ? { captionKind: item.captionKind } : {}) };
    }
    if (item.kind === 'sfx') {
      if (item.speaker !== undefined || item.speakerId !== undefined) {
        throw new Error(`${where}: a sound effect has no speaker.`);
      }
      return { ...id, kind: 'sfx', text };
    }

    const speakerId = resolveSpeaker(item, byId, byName, where);
    return {
      ...id,
      kind: item.kind,
      speakerId,
      text,
      ...(item.kind === 'balloon' && item.offPanel === true ? { offPanel: true } : {}),
    };
  });
}

function resolveSpeaker(item, byId, byName, where) {
  if (typeof item.speakerId === 'string' && item.speakerId.trim()) {
    const id = item.speakerId.trim();
    if (!byId.has(id)) {
      throw new Error(
        `${where}: speakerId ${id} is not a character in this project's cast. ` +
          'Use list_entities kind "character" for the ids.'
      );
    }
    return id;
  }
  const name = typeof item.speaker === 'string' ? item.speaker.trim() : '';
  if (!name) {
    throw new Error(`${where}: a ${item.kind} is always someone's: give speaker (a character's name) or speakerId.`);
  }
  const matches = byName.get(name.toLowerCase()) ?? [];
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    throw new Error(
      `${where}: "${name}" names ${matches.length} characters (${matches.map((m) => m.id).join(', ')}). ` +
        'Pass speakerId to say which.'
    );
  }
  throw new Error(
    `${where}: no character in this project is called "${name}". A speaker must be a character ` +
      'in the cast: check list_entities kind "character", and ask the writer before creating one.'
  );
}

/**
 * A box change as the API takes it: `{ nodeId, box?, z? }`, with `box: null`
 * clearing it. Only the shape is checked here (four finite numbers, a positive
 * width and height, an integer z); the API bounds it by the form's page.
 */
export function normaliseBoxChange(raw, i) {
  const where = `boxes[${i}]`;
  const item = asRecord(raw);
  const nodeId = typeof item.nodeId === 'string' ? item.nodeId.trim() : '';
  if (!nodeId) throw new Error(`${where}: nodeId is required.`);
  const out = { nodeId };
  if (item.box === null) {
    out.box = null;
  } else if (item.box !== undefined) {
    const { x, y, w, h } = asRecord(item.box);
    if (![x, y, w, h].every(finite) || w <= 0 || h <= 0) {
      throw new Error(`${where}: box is { x, y, w, h }, four numbers with w and h above 0 (or null to clear it).`);
    }
    out.box = { x, y, w, h };
  }
  if (item.z !== undefined) {
    if (!Number.isInteger(item.z)) throw new Error(`${where}: z is a whole number.`);
    out.z = item.z;
  }
  if (out.box === undefined && out.z === undefined) {
    throw new Error(`${where}: send a box, null to clear it, or a z.`);
  }
  return out;
}
