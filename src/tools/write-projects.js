/**
 * Starting something: a new project, with its binder.
 *
 * Until this existed every write tool operated inside a project that already
 * existed, so the honest answer to a new writer was "go to the web app first"
 * (task #319). Task #322 closes that.
 *
 * # Where the levels come from
 *
 * NOT from this file. A novel is part → chapter, a screenplay act → sequence →
 * scene, a poetry collection collection → section → poem, and those chains live
 * in one registry in the ezQuill repo that the creation wizard also reads. This
 * tool asks the API for it (`lib/writing-types.js`) and refuses a node type the
 * writing type has no word for, because the API will not: `node_type` is open
 * TEXT, and an invented level is planted and rendered as though it were real.
 *
 * What it deliberately does NOT take from the registry is the COUNT. The wizard
 * plants "3 parts of 5 chapters" because a form has nothing better to go on; an
 * agent is in a conversation and knows the actual titles, which is the rule the
 * kickoff interview already follows (levels from the registry, count and titles
 * from what the writer said).
 *
 * # Confirmation
 *
 * Creating a project is additive and restorable, so by the connector's write
 * rule it goes direct. But it sits on the writer's dashboard for good, so the
 * description and the server instructions both say: only when asked, and after
 * saying back the title, type and structure. That is a request rather than a
 * guarantee, and is recorded as such.
 */
import { randomUUID } from 'node:crypto';
import { call } from '../lib/api.js';
import { appBaseUrl } from '../lib/app-url.js';
import { Code, ToolError } from '../lib/errors.js';
import { levelsFor, plantedLevelsFor } from '../lib/writing-types.js';

/**
 * Mirrors maxBatchNodes in the API's nodes service. The server is the real
 * limit; checking here means an oversized structure is refused BEFORE the
 * project exists, rather than leaving an empty project behind a failed batch.
 */
export const MAX_NODES = 500;

/**
 * The writing types, as a schema enum.
 *
 * A copy, and a safe one — unlike node types. The API validates writing_type
 * against a Postgres enum and rejects anything else with a 400, so drift here
 * surfaces as a loud refusal rather than a quietly wrong project. Without the
 * enum a model reliably invents `fiction`.
 */
export const WRITING_TYPES = [
  'novel',
  'academic',
  'blog',
  'screenplay',
  'poetry',
  'business',
  'journalism',
  'technical',
  'compendium',
  'shortform-video',
];

/**
 * The document a prose-level node is created with.
 *
 * Exactly the web app's `emptyDocument()`. Its presence is what makes a chapter
 * writable on the day it is created; its absence is what declares a container.
 */
const emptyDocument = () => ({ document: { type: 'doc', content: [] }, plainText: '' });

const structureEntry = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    nodeType: {
      type: 'string',
      description:
        "A level from this writing type's vocabulary: part/chapter for a novel, " +
        'act/sequence/scene for a screenplay, post for a blog. Anything else is refused.',
    },
    children: {
      type: 'array',
      description: 'Nodes inside this one, in the same shape.',
      items: { type: 'object' },
    },
  },
  required: ['title', 'nodeType'],
};

export const tools = [
  {
    name: 'create_project',
    description:
      'Create a new project, optionally with its structure (parts, chapters, acts, posts…). ' +
      'Only when the writer has asked for one: it stays on their dashboard. Confirm the ' +
      'title, writing type and structure with them first. The result lists the levels ' +
      'this writing type uses; plantedLevels is what ezQuill itself would create.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        writingType: { type: 'string', enum: WRITING_TYPES },
        synopsis: { type: 'string' },
        genre: { type: 'string' },
        structure: {
          type: 'array',
          description:
            'Top-level nodes, in order, each with optional children. Omit to create an ' +
            'empty project and add structure later with manage_outline.',
          items: structureEntry,
        },
      },
      required: ['title', 'writingType'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },

    async handler(args) {
      const { title, writingType, synopsis, genre } = args;
      const levels = await levelsFor(writingType);
      const plantedLevels = await plantedLevelsFor(writingType);

      // EVERYTHING that can refuse is checked before the project is created.
      // A refusal after the POST leaves an empty project on the dashboard,
      // which is the one artefact of this tool a writer did not ask for.
      const nodes = planNodes(args.structure ?? [], levels, writingType);

      // Only the fields CreateInput declares: the API decodes with
      // DisallowUnknownFields, so an extra key is a 400.
      const project = await call('/projects', {
        method: 'POST',
        body: {
          title,
          writingType,
          ...(synopsis ? { synopsis } : {}),
          ...(genre ? { genre } : {}),
        },
      });

      let created = [];
      if (nodes.length > 0) {
        try {
          const result = await call(`/projects/${project.id}/nodes/batch`, {
            method: 'POST',
            body: { nodes },
          });
          created = result?.nodes ?? [];
        } catch (err) {
          throw new ToolError(
            Code.STRUCTURE_FAILED,
            `The project "${project.title}" was created, but its structure was not ` +
              `(${err.message}). Do NOT call create_project again — that makes a second ` +
              'project. Add the structure to this one with manage_outline.',
            { projectId: project.id, cause: err.code }
          );
        }
      }

      return {
        project: {
          id: project.id,
          title: project.title,
          writingType: project.writingType,
          status: project.status,
        },
        created: created.map((n) => ({
          id: n.id,
          title: n.title,
          nodeType: n.nodeType,
          parentId: n.parentId ?? undefined,
        })),
        levels: levels.map((l) => ({ key: l.key, label: l.label, carriesProse: l.carriesProse })),
        plantedLevels,
        url: `${appBaseUrl()}/project/${project.id}`,
      };
    },
  },
];

/**
 * Flatten the requested structure into the batch body, parents first.
 *
 * Parents first is the batch endpoint's rule: a child names its parent by an
 * id minted here, before anything is sent, which is how a whole subtree lands
 * in one transaction.
 *
 * **nodeType is required, not defaulted.** The tempting default — the level at
 * that depth, or the first prose level — is exactly the silent failure this
 * tool exists to prevent: an agent that forgot to say plants SOMETHING, and a
 * novel whose top level quietly became chapters looks fine until a writer
 * opens the binder. A missing type is refused with the vocabulary attached.
 *
 * `content` is sent on CREATE for prose levels, and that is not the hazard
 * manage_outline refuses. The danger there is `PATCH /nodes/{id}` replacing a
 * collaborator's existing prose with no version check. A node being created has
 * no prose to replace and no collaborator who has seen it — the empty document
 * is the same one the web wizard plants, and it only declares "writable".
 */
export function planNodes(structure, levels, writingType) {
  const byKey = new Map(levels.map((l) => [l.key, l]));
  const nodes = [];

  const walk = (entries, parentId, path) => {
    entries.forEach((entry, i) => {
      const where = `${path}[${i}]`;
      const level = byKey.get(entry?.nodeType);
      if (!level) {
        throw new ToolError(
          Code.UNKNOWN_NODE_TYPE,
          `${where}: "${entry?.nodeType ?? '(missing)'}" is not a level of a ${writingType} ` +
            `project. Use one of: ${levels.map((l) => l.key).join(', ')}.`,
          { writingType, nodeType: entry?.nodeType, allowed: levels.map((l) => l.key) }
        );
      }
      if (!entry.title || !String(entry.title).trim()) {
        throw new ToolError(Code.REQUEST_FAILED, `${where}: every node needs a title.`);
      }

      const id = randomUUID();
      nodes.push({
        id,
        title: entry.title,
        nodeType: entry.nodeType,
        ...(parentId ? { parentId } : {}),
        // Explicit, unlike manage_outline's append: the project is new, so
        // there are no existing siblings to land after, and the order the
        // writer described is the order they should see.
        order: i,
        ...(level.carriesProse ? { content: emptyDocument() } : {}),
      });

      // Checked as it grows, so a pathological tree is refused without being
      // walked in full.
      if (nodes.length > MAX_NODES) {
        throw new ToolError(
          Code.REQUEST_FAILED,
          `A project can be created with at most ${MAX_NODES} nodes. Create it smaller ` +
            'and add the rest with manage_outline.',
          { max: MAX_NODES }
        );
      }

      if (Array.isArray(entry.children) && entry.children.length > 0) {
        walk(entry.children, id, `${where}.children`);
      }
    });
  };

  walk(structure, undefined, 'structure');
  return nodes;
}
