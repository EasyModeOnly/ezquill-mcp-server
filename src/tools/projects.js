/**
 * Tool schemas and their handlers live together, deliberately.
 *
 * ezmodo splits `tools/` from `handlers/`, which earns its keep at ~96 tools.
 * At nine, the split would only create two places to change when an argument is
 * added, and a schema that has drifted from its handler is a 400 the agent
 * cannot diagnose.
 */
import { call } from '../lib/api.js';
import { Code, ToolError } from '../lib/errors.js';
import { createProjectUrl } from '../lib/app-url.js';

export const tools = [
  {
    name: 'list_projects',
    description:
      "List the writer's projects. Start here: every other tool needs a projectId.",
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by project status.' },
        search: { type: 'string', description: 'Match against the title.' },
        shared: {
          type: 'boolean',
          description: 'List projects shared WITH the writer instead of ones they own.',
        },
        limit: { type: 'number', description: 'Default 50.' },
      },
    },
    annotations: { readOnlyHint: true },

    async handler({ status, search, shared, limit }) {
      const body = await call('/projects', {
        query: { status, search, limit, role: shared ? 'collaborator' : undefined },
      });

      const projects = (body?.projects ?? []).map((p) => ({
        id: p.id,
        title: p.title,
        writingType: p.writingType,
        status: p.status,
        wordCount: p.progress?.totalWordCount ?? 0,
        seriesId: p.seriesId ?? undefined,
      }));

      // "Signed in and nothing here" is a fact an agent must be able to act on.
      // Returned as an empty list it reads as data loss — the writer connected
      // their manuscripts and the agent reports there are none.
      //
      // Guarded on `!search && !status` because "you have nothing" and "nothing
      // matched that" are different facts, and only the first one is this. A
      // filtered miss stays an empty list.
      //
      // The URL is handed back rather than described. Somebody can register
      // from the connector's own sign-in page and reach this line having never
      // opened ezQuill, so "in the app" names a place they have not been. Only
      // on the OWNED branch: a person waiting to be invited to someone else's
      // project is not helped by a link to make their own, and offering it
      // suggests the invitation was the misunderstanding.
      if (projects.length === 0 && !search && !status) {
        if (shared) {
          throw new ToolError(
            Code.NO_PROJECTS,
            'No projects have been shared with this account yet.',
            { shared: true }
          );
        }
        throw new ToolError(
          Code.NO_PROJECTS,
          'This ezQuill account has no projects yet. Projects are created in ezQuill itself, ' +
            'not through this connector — open the link to make one, then ask again.',
          { createProjectUrl: createProjectUrl() }
        );
      }

      return { projects, hasMore: Boolean(body?.hasMore), total: body?.total ?? projects.length };
    },
  },

  {
    name: 'get_project',
    description:
      'One project in detail: what it is, how far along it is, and its story-world premise.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
    annotations: { readOnlyHint: true },

    async handler({ projectId }) {
      // Two calls because stats are aggregated on read and deliberately not on
      // the project row — a fact about other rows is a COUNT, not a column.
      const [project, stats] = await Promise.all([
        call(`/projects/${projectId}`),
        call(`/projects/${projectId}/stats`).catch(() => null),
      ]);

      // storyWorld is a CONVENTION inside an opaque metadata blob, never a
      // typed field, so it is read defensively rather than indexed.
      const metadata = project?.metadata ?? {};
      const world = metadata && typeof metadata === 'object' ? metadata.storyWorld : undefined;

      return {
        id: project.id,
        title: project.title,
        writingType: project.writingType,
        status: project.status,
        synopsis: project.synopsis ?? undefined,
        genre: project.genre ?? undefined,
        tags: project.tags ?? [],
        wordCount: project.progress?.totalWordCount ?? 0,
        wordGoal: project.progress?.overallWordGoal ?? undefined,
        storyWorld: world ?? undefined,
        stats: stats ?? undefined,
      };
    },
  },
];
