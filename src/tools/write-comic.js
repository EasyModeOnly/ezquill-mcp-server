/**
 * A comic's panels (ezquill epic #57): pictures on a page, with lettering.
 *
 * A panel is a node built on the storyboard frame (see lib/panels.js), so
 * moving, reordering and deleting one is manage_outline's `move` and `delete`,
 * exactly as for a frame. This tool does what manage_outline cannot: plant a
 * panel WITH its description and framing, change those, and write the two
 * things only a panel has — its lettering and its box on the page.
 *
 * # Where each thing is written, and why only there
 *
 * - Description: the panel's own document, through the content route
 *   (`replaceDescription`, shared with the storyboard).
 * - Framing: `metadata.frame.framing`, by PATCH with the whole metadata
 *   rebuilt from the row just read, because PATCH assigns it.
 * - Lettering: ONLY `PUT …/nodes/{id}/panel/lettering`, with `ifRevision`.
 * - Box and z: ONLY `PUT …/nodes/panel-boxes`, all or none.
 *
 * `metadata.panel` is owned by the API (ezquill #708): a PATCH carrying it is
 * not refused, it is IGNORED, so writing lettering there would report success
 * and change nothing. The framing PATCH therefore strips `panel` from what it
 * sends rather than echoing back what it read.
 *
 * # Refused before anything is sent
 *
 * - A project that is not a comic (NOT_A_COMIC). Its pictures are a story's
 *   frames or a script's shots, each with its own tool.
 * - A served registry with no panel level for this project.
 * - A speaker that is not a character in the cast: by id, the id must be one;
 *   by name, the name must match exactly one. Never guessed, never created.
 *
 * # Safe by construction (Decision c6378e77)
 *
 * Adding panels destroys nothing. A replaced description is kept as a version.
 * Lettering is replaced whole, so the write carries the revision it was read
 * at: a list somebody else changed since is refused (STALE_CONTENT) rather
 * than overwritten, and the answer carries the previous list so the change can
 * be put back. Boxes are layout, not words; the previous ones come back too.
 */
import { randomUUID } from 'node:crypto';
import { call, callPaged } from '../lib/api.js';
import { ToolError, Code } from '../lib/errors.js';
import { byOrder, ordinalOf } from '../lib/nodes.js';
import { levelsFor } from '../lib/writing-types.js';
import { replaceDescription } from '../lib/descriptions.js';
import { FRAMINGS, descriptionDocument, descriptionOf, frameFieldsOf, withFrameFields } from '../lib/frames.js';
import {
  CAPTION_KINDS,
  LETTERING_KINDS,
  MAX_LETTERING_ITEMS,
  PANEL,
  isPanel,
  lettering,
  letteringRevision,
  letteringWithNames,
  normaliseBoxChange,
  panelLayout,
  resolveLettering,
} from '../lib/panels.js';

/** Panels one add_panels call may plant. A page holds a handful; a webtoon episode a few dozen. */
export const MAX_PANELS = 50;
/** Mirrors MaxPanelBoxes in the API. */
export const MAX_BOXES = 200;

const letteringItemSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: LETTERING_KINDS },
    text: { type: 'string' },
    speaker: {
      type: 'string',
      description: 'balloon/thought: the character\'s name, as in the cast. Must match exactly one character.',
    },
    speakerId: { type: 'string', description: 'balloon/thought: the character\'s entity id. Wins over speaker.' },
    offPanel: { type: 'boolean', description: 'balloon only: heard, not seen in this panel.' },
    captionKind: { type: 'string', enum: CAPTION_KINDS, description: 'caption only.' },
    id: { type: 'string', description: 'An existing item\'s id (from read_scene), to keep its identity. Omit for a new item.' },
  },
  required: ['kind', 'text'],
};

const framingSchema = {
  type: 'string',
  description: `What the panel holds. The app offers ${FRAMINGS.join(', ')}; any short text is kept. "" clears it.`,
};

export const tools = [
  {
    name: 'manage_comic',
    description:
      'A comic\'s panels: pictures on a page (a webtoon\'s episode), each with a description of ' +
      'what is drawn, an optional framing, lettering and a box on the page. add_panels plants ' +
      'panels on a page, after its last panel or after afterPanelId, optionally with lettering; ' +
      'set_description writes a panel\'s description (replacing one keeps the old text as a ' +
      'version); set_framing sets or clears its framing; set_lettering replaces its whole ' +
      'lettering list in reading order: balloon and thought by a character in the cast (speaker ' +
      'name or speakerId; an unknown name is refused, never created), caption, sfx; send the ' +
      'letteringRevision read_scene gave as ifRevision. set_boxes places panels: x, y, w, h are ' +
      'fractions of the page (a webtoon\'s y and h in strip widths), z stacks them; every box ' +
      'lands or none does. Reading order is the panel\'s order, never its box: move one with ' +
      'manage_outline move, delete it with manage_outline delete. Panels are numbered by ' +
      'ezQuill ("Panel 3") — never put a number in a title. Describe, never draw: nothing here ' +
      'makes art or prose. Comic projects only.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        action: {
          type: 'string',
          enum: ['add_panels', 'set_description', 'set_framing', 'set_lettering', 'set_boxes'],
        },
        nodeId: {
          type: 'string',
          description:
            'For add_panels, the PAGE (a webtoon\'s episode). For set_description, set_framing and ' +
            'set_lettering, the panel. From get_outline or read_scene. Not used by set_boxes.',
        },
        panels: {
          type: 'array',
          description: `For add_panels: the panels to plant, in reading order (at most ${MAX_PANELS}).`,
          items: {
            type: 'object',
            properties: {
              description: { type: 'string', description: 'What the panel shows. One paragraph per line.' },
              framing: framingSchema,
              lettering: { type: 'array', items: letteringItemSchema, description: 'Its lettering, in reading order.' },
            },
          },
        },
        afterPanelId: {
          type: 'string',
          description: 'For add_panels: put the new panels after this panel of the page. Omit to add at the end.',
        },
        description: {
          type: 'string',
          description: 'For set_description: the panel\'s whole new description. One paragraph per line.',
        },
        framing: framingSchema,
        items: {
          type: 'array',
          items: letteringItemSchema,
          description: `For set_lettering: the WHOLE list, in reading order (at most ${MAX_LETTERING_ITEMS}); [] clears it.`,
        },
        ifRevision: {
          type: 'integer',
          description:
            'For set_lettering: the letteringRevision you read. If the lettering changed since, the ' +
            'write is refused rather than overwriting it. Omit to use the revision read just now.',
        },
        boxes: {
          type: 'array',
          description: `For set_boxes: one entry per panel (at most ${MAX_BOXES}), all applied in one transaction.`,
          items: {
            type: 'object',
            properties: {
              nodeId: { type: 'string' },
              box: {
                type: ['object', 'null'],
                properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
                description: 'Fractions of the page. null clears it: the app places the panel itself again.',
              },
              z: { type: 'integer', description: 'Stacking: the higher is in front.' },
            },
            required: ['nodeId'],
          },
        },
      },
      required: ['projectId', 'action'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },

    async handler(args) {
      const { projectId, action } = args;
      if (action !== 'set_boxes' && !args.nodeId) {
        throw new ToolError(Code.REQUEST_FAILED, `${action} needs a nodeId.`);
      }
      const levels = await requireComic(projectId);
      switch (action) {
        case 'add_panels':
          return addPanels(args, levels);
        case 'set_description':
          return setDescription(args);
        case 'set_framing':
          return setFraming(args);
        case 'set_lettering':
          return setLettering(args);
        case 'set_boxes':
          return setBoxes(args);
        default:
          throw new ToolError(Code.REQUEST_FAILED, `Unknown action: ${action}`);
      }
    },
  },
];

/** Refuse a project that is not a comic, and return its served levels. */
async function requireComic(projectId) {
  const project = await call(`/projects/${projectId}`);
  if (project?.writingType !== 'comic') {
    const instead =
      project?.writingType === 'story'
        ? ' A story\'s pictures are storyboard frames: use manage_storyboard.'
        : project?.writingType === 'script'
          ? ' A script\'s pictures are its shots: use manage_outline and manage_production.'
          : '';
    throw new ToolError(
      Code.NOT_A_COMIC,
      `"${project?.title ?? projectId}" is a ${project?.writingType ?? 'project'}, not a comic, so it has no panels.${instead}`,
      { projectId, writingType: project?.writingType }
    );
  }
  const levels = await levelsFor(project);
  if (!levels.some((l) => l.key === PANEL)) {
    throw new ToolError(
      Code.NOT_A_COMIC,
      'This ezQuill does not serve a panel level for this project yet, so panels cannot be written.',
      { projectId, levels: levels.map((l) => l.key) }
    );
  }
  return levels;
}

/** The project's characters (its series' too), for resolving speakers. */
const charactersOf = (projectId) =>
  callPaged(`/projects/${projectId}/entities`, 'entities', { kind: 'character', limit: 1000 });

/** Resolve a lettering list, turning a bad item into a refusal. */
function resolveOrRefuse(items, characters, where = '') {
  try {
    return resolveLettering(items, characters);
  } catch (err) {
    throw new ToolError(Code.REQUEST_FAILED, `${where}${err.message}`, {
      characters: characters.map((c) => ({ id: c.id, name: c.name })),
    });
  }
}

async function addPanels({ projectId, nodeId, panels, afterPanelId }, levels) {
  const wanted = Array.isArray(panels) ? panels : [];
  if (wanted.length === 0) throw new ToolError(Code.REQUEST_FAILED, 'add_panels needs at least one entry in `panels`.');
  if (wanted.length > MAX_PANELS) {
    throw new ToolError(Code.REQUEST_FAILED, `add_panels takes at most ${MAX_PANELS} panels per call.`);
  }

  // Everything is checked before anything is sent: the parent, each framing,
  // and every speaker, so a bad third balloon does not leave two panels planted.
  const parents = levels.filter((l) => (l.children ?? []).includes(PANEL)).map((l) => l.key);
  const page = await call(`/projects/${projectId}/nodes/${nodeId}`);
  if (!parents.includes(page?.nodeType)) {
    throw new ToolError(
      Code.REQUEST_FAILED,
      `Panels go on a ${parents.join(' or ') || 'page'}, and that id is a ${page?.nodeType ?? 'node'}.`,
      { nodeType: page?.nodeType, parents }
    );
  }
  const needsCast = wanted.some((p) => Array.isArray(p?.lettering) && p.lettering.length > 0);
  const characters = needsCast ? await charactersOf(projectId) : [];
  const planned = wanted.map((p, i) => {
    if (p?.framing !== undefined && typeof p.framing !== 'string') {
      throw new ToolError(Code.REQUEST_FAILED, `panels[${i}]: framing is a string.`);
    }
    const fields = withFrameFields({}, p?.framing !== undefined ? { framing: p.framing } : {}).frame;
    const items = p?.lettering === undefined ? [] : resolveOrRefuse(p.lettering, characters, `panels[${i}].`);
    return { id: randomUUID(), content: descriptionDocument(p?.description), fields, items };
  });

  const orders = afterPanelId ? await ordersAfter(projectId, nodeId, afterPanelId, planned.length) : undefined;

  const result = await call(`/projects/${projectId}/nodes/batch`, {
    method: 'POST',
    body: {
      nodes: planned.map((p, i) => ({
        id: p.id,
        // Untitled: a panel is called by its number until someone names it.
        title: '',
        nodeType: PANEL,
        parentId: nodeId,
        ...(orders ? { order: orders[i] } : {}),
        content: p.content,
        // Framing only. `metadata.panel` is the API's: a create naming it is refused.
        ...(Object.keys(p.fields).length > 0 ? { metadata: { frame: p.fields } } : {}),
      })),
    },
  });
  const created = new Map((result?.nodes ?? []).map((n) => [n.id, n]));

  // Lettering after the panels exist, through its own route: a create may not
  // carry it. Each panel is new, so revision 0 is what it was read at.
  const failed = [];
  for (const p of planned) {
    if (p.items.length === 0) continue;
    try {
      const updated = await call(`/projects/${projectId}/nodes/${p.id}/panel/lettering`, {
        method: 'PUT',
        body: { items: p.items, ifRevision: 0 },
      });
      if (updated) created.set(p.id, { ...created.get(p.id), ...updated, content: created.get(p.id)?.content });
    } catch (err) {
      failed.push({ panelId: p.id, error: err.code ?? Code.REQUEST_FAILED, message: err.message });
    }
  }

  const names = new Map(characters.map((c) => [c.id, c.name]));
  const summary = planned.map((p) => summarisePanel(created.get(p.id) ?? { id: p.id }, names));
  if (failed.length > 0) {
    throw new ToolError(
      Code.REQUEST_FAILED,
      `The panels were created, but lettering for ${failed.length} of them was not written. Do NOT add ` +
        'the panels again; write their lettering with set_lettering.',
      { created: summary, failed }
    );
  }
  return {
    created: summary,
    note: 'Numbers are ezQuill\'s: call get_outline or read_scene to see every panel\'s current number.',
  };
}

/** Orders for `count` new panels after `afterPanelId`, so nothing else on the page moves. */
async function ordersAfter(projectId, pageId, afterPanelId, count) {
  const panels = (await callPaged(`/projects/${projectId}/nodes`, 'nodes', { parentId: pageId, omitContent: true, limit: 10000 }))
    .filter(isPanel)
    .sort(byOrder);
  const at = panels.findIndex((p) => p.id === afterPanelId);
  if (at === -1) {
    throw new ToolError(Code.NOT_FOUND, `No panel ${afterPanelId} on this page. Use read_scene to list its panels.`);
  }
  const from = panels[at].order ?? 0;
  const next = panels[at + 1];
  if (!next) return Array.from({ length: count }, (_, i) => from + i + 1);
  const step = ((next.order ?? from + 1) - from) / (count + 1);
  return Array.from({ length: count }, (_, i) => from + step * (i + 1));
}

async function readPanel(projectId, nodeId) {
  const node = await call(`/projects/${projectId}/nodes/${nodeId}`);
  if (!isPanel(node)) {
    throw new ToolError(
      Code.REQUEST_FAILED,
      `That id is a ${node?.nodeType ?? 'node'}, not a panel. Use read_scene on the page to list its panels.`
    );
  }
  return node;
}

async function setDescription({ projectId, nodeId, description }) {
  if (typeof description !== 'string' || !description.trim()) {
    throw new ToolError(Code.REQUEST_FAILED, 'set_description needs a non-empty `description`.');
  }
  const panel = await readPanel(projectId, nodeId);
  const result = await replaceDescription(projectId, panel, description, 'Panel');
  if (result.unchanged) return { unchanged: nodeId, description: result.description };
  return {
    updated: summarisePanel(result.updated),
    ...(result.previous
      ? {
          previousDescription: result.previous,
          keptAsVersion: result.keptVersion,
          note: 'The previous description is kept in the panel\'s version history and can be restored.',
        }
      : {}),
  };
}

async function setFraming({ projectId, nodeId, framing }) {
  if (typeof framing !== 'string') {
    throw new ToolError(Code.REQUEST_FAILED, 'set_framing needs `framing`, a string ("" clears it).');
  }
  const panel = await readPanel(projectId, nodeId);
  // PATCH assigns metadata: rebuilt whole from the row just read, minus the
  // API-owned `panel`, which PATCH would ignore anyway.
  const { panel: _owned, ...metadata } = withFrameFields(panel.metadata, { framing });
  void _owned;
  const updated = await call(`/projects/${projectId}/nodes/${nodeId}`, { method: 'PATCH', body: { metadata } });
  return { updated: summarisePanel({ ...updated, content: updated?.content ?? panel.content }) };
}

async function setLettering({ projectId, nodeId, items, ifRevision }) {
  if (!Array.isArray(items)) {
    throw new ToolError(Code.REQUEST_FAILED, 'set_lettering needs `items`, the whole list ([] clears it).');
  }
  if (ifRevision !== undefined && (!Number.isInteger(ifRevision) || ifRevision < 0)) {
    throw new ToolError(Code.REQUEST_FAILED, '`ifRevision` is the letteringRevision read_scene gave, a whole number.');
  }
  const [panel, characters] = await Promise.all([readPanel(projectId, nodeId), charactersOf(projectId)]);
  const names = new Map(characters.map((c) => [c.id, c.name]));
  const current = letteringRevision(panel);
  const previous = letteringWithNames(panel, names);

  // Stale before sending: said here with what is there now, so the agent can
  // re-read and decide, rather than as the API's bare 409.
  if (ifRevision !== undefined && ifRevision !== current) {
    throw new ToolError(
      Code.STALE_CONTENT,
      'This panel\'s lettering changed since you read it. Read it again and rebuild your list from what is there now.',
      { letteringRevision: current, lettering: previous }
    );
  }
  const resolved = resolveOrRefuse(items, characters);

  const updated = await call(`/projects/${projectId}/nodes/${nodeId}/panel/lettering`, {
    method: 'PUT',
    body: { items: resolved, ifRevision: ifRevision ?? current },
  });
  return {
    updated: summarisePanel({ ...updated, content: updated?.content ?? panel.content }, names),
    ...(lettering(panel).length > 0
      ? {
          previousLettering: previous,
          note: 'The previous lettering is above; to put it back, send it as items with the new letteringRevision.',
        }
      : {}),
  };
}

async function setBoxes({ projectId, boxes }) {
  const wanted = Array.isArray(boxes) ? boxes : [];
  if (wanted.length === 0) throw new ToolError(Code.REQUEST_FAILED, 'set_boxes needs at least one entry in `boxes`.');
  if (wanted.length > MAX_BOXES) {
    throw new ToolError(Code.REQUEST_FAILED, `set_boxes takes at most ${MAX_BOXES} panels per call.`);
  }
  let items;
  try {
    items = wanted.map(normaliseBoxChange);
  } catch (err) {
    throw new ToolError(Code.REQUEST_FAILED, err.message);
  }
  const ids = new Set(items.map((i) => i.nodeId));
  if (ids.size !== items.length) throw new ToolError(Code.REQUEST_FAILED, 'Each panel may appear once in `boxes`.');

  // The boxes as they were, so the change can be undone. One list call for
  // every panel in the project, without bodies; a failure only loses the undo.
  const before = await callPaged(`/projects/${projectId}/nodes`, 'nodes', { nodeType: PANEL, omitContent: true, limit: 10000 })
    .then((list) => list.filter((n) => ids.has(n.id)).map((n) => ({ nodeId: n.id, ...panelLayout(n) })))
    .catch(() => undefined);

  // All or none: the API applies the list in one transaction, and refuses a
  // box off the form's page or an id that is not a panel of this project.
  const result = await call(`/projects/${projectId}/nodes/panel-boxes`, { method: 'PUT', body: { items } });
  return {
    updated: (result?.nodes ?? []).map((n) => ({ id: n.id, ordinal: ordinalOf(n), ...panelLayout(n) })),
    ...(before ? { previous: before } : {}),
  };
}

/** What a caller needs back about a panel. Lettering with names when they are known. */
function summarisePanel(n, names = new Map()) {
  const { framing } = frameFieldsOf(n);
  return {
    id: n?.id,
    ordinal: ordinalOf(n),
    parentId: n?.parentId ?? undefined,
    ...(framing ? { framing } : {}),
    description: descriptionOf(n) ?? '',
    ...panelLayout(n),
    lettering: letteringWithNames(n, names),
    letteringRevision: letteringRevision(n),
  };
}
