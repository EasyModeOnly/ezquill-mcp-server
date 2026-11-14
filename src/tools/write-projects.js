/**
 * Starting something: a new project, with its binder.
 *
 * Until this existed every write tool operated inside a project that already
 * existed, so the honest answer to a new writer was "go to the web app first"
 * (task #319). Task #322 closes that.
 *
 * # Where the levels come from
 *
 * NOT from this file. A story is part → chapter, a feature script act →
 * sequence → scene, a poetry collection collection → section → poem, and those chains live
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
import { hasProductionVariant, levelsFor, plantedLevelsFor, shapesFor } from '../lib/writing-types.js';

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
export const WRITING_TYPES = ['story', 'document', 'script', 'poetry', 'comic'];

/**
 * Every shape any writing type may take, as the schema's enum (ezquill epics
 * #48 and #55): a script's shape, a story's length and a document's form. Which
 * ones a type actually has is the registry's answer (`shapesFor`), checked
 * before anything is created; this is the enum for the reason WRITING_TYPES is.
 */
export const SCRIPT_SHAPES = ['feature', 'series', 'parts'];
export const STORY_SHAPES = ['novel', 'novella', 'short-story'];
export const DOCUMENT_FORMS = ['paper', 'article', 'post', 'report', 'documentation'];
export const COMIC_FORMS = ['manga', 'webtoon', 'graphic-novel', 'comic-book'];
export const SHAPES = [...SCRIPT_SHAPES, ...STORY_SHAPES, ...DOCUMENT_FORMS, ...COMIC_FORMS];

/**
 * The writing types whose shape is REQUIRED: a document's form and a comic's
 * (ezquill epics #55 and #57). The API refuses either without one, since
 * neither has a sensible default — a paper and a post are different binders,
 * and a manga and a webtoon are not even both made of pages. Which forms a
 * type has is still the served registry's answer (`shapesFor`).
 */
const FORM_REQUIRED = { document: 'A document needs a form', comic: 'A comic needs a form' };

/**
 * The writing types ezQuill retired, and what each became. The API refuses them
 * for a new project; checking here turns a client holding a stale schema's
 * "novel" into a refusal that says what to send instead, before anything is
 * created. Mirrors FOLDED_WRITING_TYPES and RETIRED_WRITING_TYPES in the
 * ezQuill repo (lib/types/core/writing-types.ts).
 */
export const RETIRED_WRITING_TYPES = {
  novel: { writingType: 'story', shape: 'novel' },
  compendium: { writingType: 'story', shape: 'novel' },
  academic: { writingType: 'document', shape: 'paper' },
  journalism: { writingType: 'document', shape: 'article' },
  blog: { writingType: 'document', shape: 'post' },
  business: { writingType: 'document', shape: 'report' },
  technical: { writingType: 'document', shape: 'documentation' },
  screenplay: { writingType: 'script', shape: 'feature' },
  'shortform-video': { writingType: 'script', shape: 'series' },
};

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
    title: {
      type: 'string',
      description:
        'The name, with NO number in it: ezQuill numbers nodes by position ("Ep. 3", ' +
        '"Shot 2"). Omit it on a numbered level the writer has not named; its number ' +
        'names it. Every other level needs one.',
    },
    nodeType: {
      type: 'string',
      description:
        "A level from this project's vocabulary: part/chapter for a novel-length story, " +
        'scene for a short story, act/sequence/scene for a feature script, episode/scene ' +
        '(and shot, with production on) for a series script, post for a document shaped ' +
        'as a post, chapter/page for a graphic novel. Panels are added later with ' +
        'manage_comic. Anything else is refused.',
    },
    children: {
      type: 'array',
      description: 'Nodes inside this one, in the same shape.',
      items: { type: 'object' },
    },
  },
  required: ['nodeType'],
};

export const tools = [
  {
    name: 'create_project',
    description:
      'Create a new project, optionally with its structure (parts, chapters, acts, posts…). ' +
      'Only when the writer has asked for one: it stays on their dashboard. Confirm the ' +
      'title, writing type and structure with them first. Four writing types: a `story` ' +
      '(fiction; its shape is its length), a `document` (non-fiction; its shape is its ' +
      'form, and is required), a `script`, `poetry` and a `comic` (its shape is its form, ' +
      'required: manga, webtoon, graphic-novel or comic-book). A film, a show or a generated ' +
      'short is a `script`: pick its shape, and set production for shots, takes and ' +
      'compiled prompts. A show (shape series, or parts) is a series of season projects: ' +
      'this creates the series and its first season, or — given seriesId — the next ' +
      'season of an existing show, which shares its cast and bible. The result lists the ' +
      'levels this project uses; plantedLevels is what ezQuill itself would create.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        writingType: { type: 'string', enum: WRITING_TYPES },
        shape: {
          type: 'string',
          enum: SHAPES,
          description:
            'Story: its length, novel (part → chapter → scene; the default), novella, or ' +
            'short-story (scenes only). Document: its form, REQUIRED, one of paper (an ' +
            'academic paper), article (journalism), post (a blog post), report (business), ' +
            'documentation (technical). Script: feature (one film, act → sequence → scene; ' +
            'the default), series (one season of a show, episode → scene), or parts (one ' +
            'part of a work in parts, shaped like a feature). Comic: its form, REQUIRED, one of ' +
            'manga (volume → chapter → page → panel, read right to left), webtoon (episode → ' +
            'panel, one vertical strip), graphic-novel (chapter → page → panel) or comic-book ' +
            '(issue → page → panel). Poetry has none.',
        },
        production: {
          type: 'boolean',
          description:
            'Scripts only. Digital content creation: a shot under every scene, compiled ' +
            'prompts and takes. Pro and up; refused on a plan without it.',
        },
        seriesId: {
          type: 'string',
          description:
            "A show's series id (list_projects → series), to add its NEXT season. The new " +
            "season takes the show's title and the season's number; shape and production " +
            'carry over unless given.',
        },
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
      const { writingType, synopsis, genre } = args;
      let { title } = args;
      const retired = RETIRED_WRITING_TYPES[writingType];
      if (retired) {
        throw new ToolError(
          Code.REQUEST_FAILED,
          `"${writingType}" is no longer a writing type: send writingType "${retired.writingType}" ` +
            `with shape "${retired.shape}".`,
          { writingType, replacement: retired }
        );
      }
      // The next season of an existing show: its shape and production carry
      // over from the latest season unless the caller states them.
      let show = null;
      if (args.seriesId) {
        if (writingType !== 'script') {
          throw new ToolError(Code.REQUEST_FAILED, 'Only a script can be a season of a show.');
        }
        show = await call(`/series/${args.seriesId}`, { query: { withProjects: true } });
        const latest = show.projects?.[show.projects.length - 1];
        if (latest) {
          const prior = await call(`/projects/${latest.id}`);
          args = {
            ...args,
            shape: args.shape ?? prior.shape ?? 'series',
            production: args.production ?? prior.production === true,
          };
        }
      }
      const shapes = await shapesFor(writingType);
      if (shapes.length === 0 && args.shape !== undefined) {
        throw new ToolError(Code.REQUEST_FAILED, `A ${writingType} project has no shape.`);
      }
      const canProduce = await hasProductionVariant(writingType);
      if (args.production !== undefined && !canProduce) {
        throw new ToolError(
          Code.REQUEST_FAILED,
          `A ${writingType} project has no production switch; only a script does.`
        );
      }
      if (args.shape !== undefined && !shapes.includes(args.shape)) {
        throw new ToolError(Code.REQUEST_FAILED, `shape must be one of ${shapes.join(', ')}.`);
      }
      // The API refuses a document or a comic without a form, so say so
      // before the project exists rather than after.
      if (FORM_REQUIRED[writingType] && args.shape === undefined) {
        throw new ToolError(
          Code.REQUEST_FAILED,
          `${FORM_REQUIRED[writingType]}: shape must be one of ${shapes.join(', ')}.`
        );
      }
      const structureOf = {
        writingType,
        ...(shapes.length ? { shape: args.shape ?? shapes[0] } : {}),
        ...(canProduce ? { production: args.production === true } : {}),
      };
      const levels = await levelsFor(structureOf);
      const plantedLevels = await plantedLevelsFor(structureOf);

      // EVERYTHING that can refuse is checked before the project is created.
      // A refusal after the POST leaves an empty project on the dashboard,
      // which is the one artefact of this tool a writer did not ask for.
      const nodes = planNodes(args.structure ?? [], levels, writingType);

      // A show is a series of season projects (ezquill epic #47): a new one
      // gets its series first, then its first season; a seriesId adds the next.
      const isShow = writingType === 'script' && ['series', 'parts'].includes(structureOf.shape);
      const member = structureOf.shape === 'parts' ? 'Part' : 'Season';
      let membership = {};
      let createdSeries = null;
      if (show) {
        if (!isShow) {
          throw new ToolError(Code.REQUEST_FAILED, 'A season of a show is shaped as a series or in parts.');
        }
        const order = Math.max(0, ...(show.projects ?? []).map((p, i) => p.seriesOrder ?? i + 1)) + 1;
        title = `${show.title}, ${member} ${order}`;
        membership = { seriesId: show.id, seriesOrder: order };
      } else if (isShow) {
        createdSeries = await call('/series', {
          method: 'POST',
          body: {
            title,
            writingType: 'script',
            ...(synopsis ? { description: synopsis } : {}),
            metadata: { type: 'series', status: 'active', ...(genre ? { genre } : {}) },
          },
        });
        membership = { seriesId: createdSeries.id, seriesOrder: 1 };
        title = `${title}, ${member} 1`;
      }

      // Only the fields CreateInput declares: the API decodes with
      // DisallowUnknownFields, so an extra key is a 400.
      let project;
      try {
        project = await call('/projects', {
          method: 'POST',
          body: {
            title,
            writingType,
            ...membership,
            ...(shapes.length ? { shape: structureOf.shape } : {}),
            ...(canProduce ? { production: structureOf.production } : {}),
            ...(synopsis ? { synopsis } : {}),
            ...(genre ? { genre } : {}),
          },
        });
      } catch (err) {
        // A new show's series exists by now; a season the API refused (a plan
        // limit, say) must not leave it behind, empty, on the dashboard.
        if (createdSeries) {
          await call(`/series/${createdSeries.id}`, { method: 'DELETE' }).catch(() => {});
        }
        throw err;
      }

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
          ...(project.shape ? { shape: project.shape, production: project.production === true } : {}),
          status: project.status,
          ...(membership.seriesId ? { seriesId: membership.seriesId, seriesOrder: membership.seriesOrder } : {}),
        },
        ...(createdSeries ? { series: { id: createdSeries.id, title: createdSeries.title } } : {}),
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
      // A numbered level may be untitled: its number names it, and stays right
      // when the node moves, where a typed "Shot 3" goes stale on the first
      // reorder (ezquill epic #37). The API refuses an empty title anywhere
      // else, so the same rule is stated here before anything is sent.
      const untitled = !entry.title || !String(entry.title).trim();
      if (untitled && !level.numbered) {
        throw new ToolError(
          Code.REQUEST_FAILED,
          `${where}: a ${level.key} needs a title (only a numbered level may be left untitled).`
        );
      }

      const id = randomUUID();
      nodes.push({
        id,
        title: untitled ? '' : entry.title,
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
