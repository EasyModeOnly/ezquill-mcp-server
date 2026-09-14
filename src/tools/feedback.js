import { call } from '../lib/api.js';

export const tools = [
  {
    name: 'list_feedback',
    description:
      'Open comment threads and suggested edits on a project. Read this before revising ' +
      'a chapter — it is what the writer\'s collaborators have already said about it.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        nodeId: { type: 'string', description: 'Only threads on this node.' },
        includeResolved: { type: 'boolean', description: 'Default false.' },
      },
      required: ['projectId'],
    },
    annotations: { readOnlyHint: true },

    async handler({ projectId, nodeId, includeResolved }) {
      const body = nodeId
        ? await call(`/projects/${projectId}/nodes/${nodeId}/comments`, {
            query: { includeResolved: includeResolved || undefined },
          })
        : await call(`/projects/${projectId}/comments`);

      return { threads: (body?.comments ?? []).map(thread) };
    },
  },
];

function thread(c) {
  return {
    id: c.id,
    nodeId: c.nodeId,
    // Empty when the account has been erased. There is deliberately no way to
    // turn an author id into a person, so an absent name stays absent.
    author: c.authorName || undefined,
    body: c.body,
    // The passage the thread is attached to.
    quoted: c.anchor?.text ?? undefined,
    // `replacement` is a POINTER and the empty string is MEANINGFUL — it
    // proposes cutting the passage. Testing truthiness here would silently turn
    // "cut this" into an ordinary remark, taking the whole suggestion with it.
    isSuggestion: c.replacement !== undefined && c.replacement !== null,
    replacement: c.replacement ?? undefined,
    accepted: Boolean(c.acceptedAt),
    resolved: Boolean(c.resolvedAt),
    replies: (c.replies ?? []).map((r) => ({
      author: r.authorName || undefined,
      body: r.body,
    })),
  };
}
