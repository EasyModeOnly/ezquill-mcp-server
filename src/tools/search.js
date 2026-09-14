import { call } from '../lib/api.js';
import { Code, ToolError } from '../lib/errors.js';

export const tools = [
  {
    name: 'search_project',
    description:
      'Search a project semantically — by meaning, not keywords. Use this to find ' +
      'where something is discussed when you do not know what words the writer used. ' +
      'Results are ordered by similarity; there is no relevance score and no threshold.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        query: {
          type: 'string',
          description: 'A question or a description of what you are looking for.',
        },
        limit: { type: 'number', description: 'Default 10, maximum 50.' },
        sourceTypes: {
          type: 'array',
          items: { type: 'string', enum: ['node', 'entity', 'timeline_event'] },
          description: 'Narrow the search. Omit to search everything.',
        },
      },
      required: ['projectId', 'query'],
    },
    annotations: { readOnlyHint: true },

    async handler({ projectId, query, limit, sourceTypes }) {
      let body;
      try {
        body = await call(`/projects/${projectId}/search`, {
          method: 'POST',
          body: { text: query, limit, sourceTypes },
        });
      } catch (err) {
        // The API answers 503 when embeddings are not configured, and that is
        // NOT the same statement as "nothing matched". Passed through with its
        // own code and a message that says which it is, because an agent that
        // reports a missing service as an empty manuscript is telling the
        // writer their book is empty.
        if (err instanceof ToolError && err.code === Code.SEARCH_UNAVAILABLE) {
          throw new ToolError(
            Code.SEARCH_UNAVAILABLE,
            'Semantic search is not available in this ezQuill deployment. ' +
              'This is not a statement about the project’s contents — ' +
              'use get_outline and read_scene instead.'
          );
        }
        throw err;
      }

      return {
        // Ordered by similarity. NO score of any kind is exposed: the
        // underlying cosine distance has no absolute meaning — a question
        // matched its answering scene at 0.60 while wrong scenes sat at 0.68
        // and 0.74, so any cutoff tight enough to look meaningful discards
        // correct answers. Order within one project is the whole signal, and
        // omitting the number is what stops a caller inventing a threshold.
        results: (body?.results ?? []).map((r) => ({
          sourceType: r.sourceType,
          // For a prose hit this is the SECTION, not the paragraph the text
          // came from — the scene is what a writer recognises and can be taken
          // to. Safe to pass to read_scene.
          sourceId: r.sourceId,
          title: r.title,
          // The writer's own words. The only field that may be quoted.
          text: r.text,
          // What the system wrote ABOUT the passage: binder ancestors and cast.
          // Named `context` rather than `header` so it cannot be mistaken for
          // part of the excerpt, and never merged into `text` — quoting it
          // attributes invented sentences to the writer.
          context: r.header || undefined,
        })),
      };
    },
  },
];
