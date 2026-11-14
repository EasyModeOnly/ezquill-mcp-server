/**
 * A story's storyboard (ezquill epic #56): frames under a scene.
 *
 * A frame is a node (see lib/frames.js for its fields), so moving, reordering
 * and deleting one is manage_outline's `move` and `delete`, exactly as for a
 * scene — the same endpoints, the same subtree-safe reparenting, the same
 * restorable soft delete. This tool does what manage_outline cannot: plant a
 * frame WITH its description, framing and line, and change those.
 *
 * # Refused before anything is sent
 *
 * - A project whose storyboard is off (STORYBOARD_OFF). The API hides frames
 *   then, so a frame created anyway would be invisible to the writer.
 * - A script. Its storyboard cards are its SHOTS, never frames (Decision
 *   1d59ef3b); the refusal names the shot tools instead.
 * - A served registry with no frame level for this project. The level is read
 *   from GET /writing-types, never assumed, so a connector ahead of its API
 *   says so rather than planting a level the API does not know.
 *
 * # Safe by construction (Decision c6378e77)
 *
 * Adding frames destroys nothing. A description is written by
 * `replaceDescription` (lib/descriptions.js), which keeps a replaced one as a
 * version and guards the write with `ifContentVersion`. A suggested edit is not used here because the storyboard shows no
 * comments, so a suggestion on a frame would be one nobody could see.
 */
import { randomUUID } from 'node:crypto';
import { call, callPaged } from '../lib/api.js';
import { ToolError, Code } from '../lib/errors.js';
import { byOrder, ordinalOf } from '../lib/nodes.js';
import { levelsFor } from '../lib/writing-types.js';
import { replaceDescription } from '../lib/descriptions.js';
import {
  FRAME,
  FRAMINGS,
  descriptionDocument,
  descriptionOf,
  frameFieldsOf,
  isFrame,
  normaliseLine,
  withFrameFields,
} from '../lib/frames.js';

/** Frames one add_frames call may plant. A storyboard is built a scene at a time. */
export const MAX_FRAMES = 50;

const lineSchema = {
  type: ['object', 'null'],
  properties: {
    kind: { type: 'string', enum: ['dialogue', 'caption'] },
    text: { type: 'string' },
  },
  required: ['text'],
  description:
    'One line of dialogue or a caption, plain text, attributed to nobody. kind defaults to ' +
    'dialogue. For set_frame, null clears it.',
};

const framingSchema = {
  type: 'string',
  description:
    `What the camera holds. The app offers ${FRAMINGS.join(', ')}; any short text is kept. ` +
    'For set_frame, an empty string clears it.',
};

export const tools = [
  {
    name: 'manage_storyboard',
    description:
      'A story\'s storyboard: frames under a scene, each a picture with a description, an optional ' +
      'framing and an optional line (dialogue or a caption). add_frames plants frames in a scene, ' +
      'after its last frame or after afterFrameId; set_description writes one frame\'s description ' +
      '(replacing one keeps the old text as a version of the frame); set_frame sets or clears its ' +
      'framing and line. Frames are numbered by ezQuill ("Frame 3") — never put a number in a ' +
      'title. Move, reorder or delete a frame with manage_outline move / delete. Frames are not ' +
      'manuscript: their words are not counted and not exported, and prose never goes in one. ' +
      'Needs the project\'s storyboard switched on. A script has no frames: its storyboard cards ' +
      'are its shots (manage_outline add nodeType "shot", manage_production set_shot for framing).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        action: { type: 'string', enum: ['add_frames', 'set_description', 'set_frame'] },
        nodeId: {
          type: 'string',
          description: 'For add_frames, the SCENE. For set_description and set_frame, the frame. From get_outline or read_scene.',
        },
        frames: {
          type: 'array',
          description: `For add_frames: the frames to plant, in order (at most ${MAX_FRAMES}). All are created in one transaction.`,
          items: {
            type: 'object',
            properties: {
              description: {
                type: 'string',
                description: 'What the picture shows. One paragraph per line.',
              },
              framing: framingSchema,
              line: lineSchema,
            },
          },
        },
        afterFrameId: {
          type: 'string',
          description: 'For add_frames: put the new frames after this frame of the scene. Omit to add at the end.',
        },
        description: {
          type: 'string',
          description: 'For set_description: the frame\'s whole new description. One paragraph per line.',
        },
        framing: framingSchema,
        line: lineSchema,
      },
      required: ['projectId', 'action', 'nodeId'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },

    async handler(args) {
      const { projectId, action, nodeId } = args;
      if (!nodeId) throw new ToolError(Code.REQUEST_FAILED, `${action} needs a nodeId.`);

      const levels = await requireStoryboard(projectId);
      switch (action) {
        case 'add_frames':
          return addFrames(args, levels);
        case 'set_description':
          return setDescription(args);
        case 'set_frame':
          return setFrame(args);
        default:
          throw new ToolError(Code.REQUEST_FAILED, `Unknown action: ${action}`);
      }
    },
  },
];

/**
 * Refuse a project that cannot have frames, and return its served levels.
 */
async function requireStoryboard(projectId) {
  const project = await call(`/projects/${projectId}`);
  if (project?.writingType === 'script') {
    throw new ToolError(
      Code.REQUEST_FAILED,
      `"${project.title}" is a script, and a script's storyboard cards are its shots, not frames. ` +
        'Add a shot under a scene with manage_outline add (nodeType "shot"), describe it in its ' +
        'text with write_draft, and set its framing with manage_production set_shot.',
      { projectId, writingType: 'script' }
    );
  }
  if (project?.storyboard !== true) {
    throw new ToolError(
      Code.STORYBOARD_OFF,
      `"${project?.title ?? projectId}" has its storyboard switched off, so it has no frames. ` +
        (project?.writingType === 'story'
          ? 'The writer can switch it on in the project\'s settings; nothing is deleted while it is off.'
          : `A ${project?.writingType ?? 'project of this type'} has no storyboard; only a story has frames.`),
      { projectId }
    );
  }
  const levels = await levelsFor(project);
  if (!levels.some((l) => l.key === FRAME)) {
    throw new ToolError(
      Code.STORYBOARD_OFF,
      'This ezQuill does not serve a frame level for this project yet, so frames cannot be added to it.',
      { projectId, levels: levels.map((l) => l.key) }
    );
  }
  return levels;
}

async function addFrames({ projectId, nodeId, frames, afterFrameId }, levels) {
  const wanted = Array.isArray(frames) ? frames : [];
  if (wanted.length === 0) {
    throw new ToolError(Code.REQUEST_FAILED, 'add_frames needs at least one entry in `frames`.');
  }
  if (wanted.length > MAX_FRAMES) {
    throw new ToolError(Code.REQUEST_FAILED, `add_frames takes at most ${MAX_FRAMES} frames per call.`);
  }

  // Everything is checked before anything is sent, so a bad third frame
  // does not leave the first two planted.
  const planned = wanted.map((f, i) => {
    let line;
    try {
      line = f?.line === undefined ? undefined : normaliseLine(f.line);
    } catch (err) {
      throw new ToolError(Code.REQUEST_FAILED, `frames[${i}]: ${err.message}`);
    }
    const fields = withFrameFields({}, {
      ...(f?.framing !== undefined ? { framing: f.framing } : {}),
      ...(line !== undefined ? { line } : {}),
    }).frame;
    return { content: descriptionDocument(f?.description), fields };
  });

  // The parent must be a level the SERVED registry puts frames under (a
  // scene), not whatever id was passed: a frame under a chapter is a card the
  // board never shows.
  const parents = levels.filter((l) => (l.children ?? []).includes(FRAME)).map((l) => l.key);
  const scene = await call(`/projects/${projectId}/nodes/${nodeId}`);
  if (!parents.includes(scene?.nodeType)) {
    throw new ToolError(
      Code.REQUEST_FAILED,
      `Frames go under a ${parents.join(' or ') || 'scene'}, and that id is a ${scene?.nodeType ?? 'node'}. ` +
        'Pass the scene the frames picture.',
      { nodeType: scene?.nodeType, parents }
    );
  }

  const orders = afterFrameId ? await ordersAfter(projectId, nodeId, afterFrameId, planned.length) : undefined;

  const result = await call(`/projects/${projectId}/nodes/batch`, {
    method: 'POST',
    body: {
      nodes: planned.map((p, i) => ({
        id: randomUUID(),
        // Untitled: a frame is called by its number until someone names it.
        title: '',
        nodeType: FRAME,
        parentId: nodeId,
        // Absent order appends after the last child, in request order.
        ...(orders ? { order: orders[i] } : {}),
        // Planted WITH its document, as the app plants one — an empty one
        // when no description was given, so the frame is a card from the start.
        content: p.content,
        ...(Object.keys(p.fields).length > 0 ? { metadata: { frame: p.fields } } : {}),
      })),
    },
  });

  return {
    created: (result?.nodes ?? []).map(summariseFrame),
    note: 'Numbers are ezQuill\'s: call get_outline or read_scene to see every frame\'s current number.',
  };
}

/**
 * Orders for `count` new frames placed after `afterFrameId`, between it and
 * the frame that follows, so nothing else in the scene has to move.
 */
async function ordersAfter(projectId, sceneId, afterFrameId, count) {
  const frames = (await callPaged(`/projects/${projectId}/nodes`, 'nodes', { parentId: sceneId, omitContent: true, limit: 10000 }))
    .filter(isFrame)
    .sort(byOrder);
  const at = frames.findIndex((f) => f.id === afterFrameId);
  if (at === -1) {
    throw new ToolError(Code.NOT_FOUND, `No frame ${afterFrameId} in this scene. Use read_scene to list its frames.`);
  }
  const from = frames[at].order ?? 0;
  const next = frames[at + 1];
  if (!next) return Array.from({ length: count }, (_, i) => from + i + 1);
  const step = ((next.order ?? from + 1) - from) / (count + 1);
  return Array.from({ length: count }, (_, i) => from + step * (i + 1));
}

async function readFrame(projectId, nodeId) {
  const node = await call(`/projects/${projectId}/nodes/${nodeId}`);
  if (!isFrame(node)) {
    throw new ToolError(
      Code.REQUEST_FAILED,
      `That id is a ${node?.nodeType ?? 'node'}, not a storyboard frame. Use read_scene on the scene to list its frames.`
    );
  }
  return node;
}

async function setDescription({ projectId, nodeId, description }) {
  if (typeof description !== 'string' || !description.trim()) {
    throw new ToolError(Code.REQUEST_FAILED, 'set_description needs a non-empty `description`.');
  }
  const frame = await readFrame(projectId, nodeId);
  const result = await replaceDescription(projectId, frame, description, 'Frame');
  if (result.unchanged) return { unchanged: nodeId, description: result.description };

  return {
    updated: summariseFrame(result.updated),
    ...(result.previous
      ? {
          previousDescription: result.previous,
          keptAsVersion: result.keptVersion,
          note: 'The previous description is kept in the frame\'s version history and can be restored.',
        }
      : {}),
  };
}

async function setFrame({ projectId, nodeId, framing, line }) {
  if (framing === undefined && line === undefined) {
    throw new ToolError(Code.REQUEST_FAILED, 'set_frame needs `framing`, `line`, or both.');
  }
  const patch = {};
  if (framing !== undefined) {
    if (typeof framing !== 'string') throw new ToolError(Code.REQUEST_FAILED, '`framing` is a string ("" clears it).');
    patch.framing = framing;
  }
  if (line !== undefined) {
    try {
      patch.line = normaliseLine(line);
    } catch (err) {
      throw new ToolError(Code.REQUEST_FAILED, err.message);
    }
  }

  // metadata is ASSIGNED on PATCH: rebuilt whole from the row just read.
  const frame = await readFrame(projectId, nodeId);
  const metadata = withFrameFields(frame.metadata, patch);
  const updated = await call(`/projects/${projectId}/nodes/${nodeId}`, { method: 'PATCH', body: { metadata } });
  return { updated: summariseFrame({ ...updated, content: updated?.content ?? frame.content }) };
}

/** What a caller needs back about a frame. */
const summariseFrame = (n) => ({
  id: n?.id,
  ordinal: ordinalOf(n),
  parentId: n?.parentId ?? undefined,
  ...frameFieldsOf(n),
  description: descriptionOf(n) ?? '',
});
