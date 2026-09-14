/**
 * Talking to the people working on a manuscript.
 *
 * # There is no accept action, and its absence is the design
 *
 * Proposing a suggested edit needs Comment; accepting one needs Write. But a
 * connector granted `ezquill:write` holds BOTH — the consent vocabulary is
 * deliberately coarser than the access matrix. So an agent able to propose is
 * also able to accept, and a suggestion it could accept itself is not a
 * confirmation at all; it is a write with extra steps.
 *
 * The fix is absence rather than permission. The advertised tool list and the
 * dispatch set are built from the same value, so a client that guesses
 * `accept_suggestion` gets nothing. If this ever needs to change, the honest
 * way is a fourth consent scope somebody agrees to on a screen — not a widening
 * of `ezquill:write`.
 */
import { call } from '../lib/api.js';
import { ToolError, Code } from '../lib/errors.js';

export const tools = [
  {
    name: 'manage_feedback',
    description:
      'Leave a comment on a passage, reply to a thread, or mark one resolved. To propose ' +
      'a change to the words themselves, use write_draft with action "revise".',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        action: { type: 'string', enum: ['comment', 'reply', 'resolve', 'unresolve'] },
        nodeId: { type: 'string', description: 'For comment: the scene.' },
        quote: {
          type: 'string',
          description: 'For comment: the exact passage being commented on.',
        },
        body: { type: 'string', description: 'What to say.' },
        commentId: { type: 'string', description: 'For reply, resolve and unresolve.' },
      },
      required: ['projectId', 'action'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },

    async handler(args) {
      const { projectId, action } = args;

      if (action === 'comment') {
        if (!args.nodeId || !args.body || !args.quote) {
          throw new ToolError(
            Code.REQUEST_FAILED,
            'comment needs a nodeId, the quoted passage, and a body.'
          );
        }
        const created = await call(`/projects/${projectId}/nodes/${args.nodeId}/comments`, {
          method: 'POST',
          body: {
            body: args.body,
            // An anchor is REQUIRED on a thread head and forbidden on a reply.
            // See write-draft.js for why an approximate range with an exact
            // quote is the right bargain.
            anchor: { from: 0, to: args.quote.length, text: args.quote },
          },
        });
        return { commented: created.id };
      }

      if (!args.commentId) {
        throw new ToolError(Code.REQUEST_FAILED, `${action} needs a commentId.`);
      }

      if (action === 'reply') {
        if (!args.body) throw new ToolError(Code.REQUEST_FAILED, 'reply needs a body.');
        // A reply may only answer a thread HEAD, and carries no anchor — the
        // API refuses a reply to a reply rather than quietly flattening it, so
        // the shape on screen matches the shape stored.
        const thread = await findThread(projectId, args.commentId);
        const reply = await call(`/projects/${projectId}/nodes/${thread.nodeId}/comments`, {
          method: 'POST',
          body: { parentId: args.commentId, body: args.body },
        });
        return { replied: reply.id, toThread: args.commentId };
      }

      if (action === 'resolve' || action === 'unresolve') {
        await call(`/projects/${projectId}/comments/${args.commentId}/resolve`, {
          method: action === 'resolve' ? 'POST' : 'DELETE',
          ...(action === 'resolve' ? { body: {} } : {}),
        });
        return { [action === 'resolve' ? 'resolved' : 'unresolved']: args.commentId };
      }

      throw new ToolError(Code.REQUEST_FAILED, `Unknown action: ${action}`);
    },
  },
];

/** A reply is posted under the thread's node, so the node has to be found. */
async function findThread(projectId, commentId) {
  const body = await call(`/projects/${projectId}/comments`);
  const thread = (body?.comments ?? []).find((c) => c.id === commentId);
  if (!thread) {
    throw new ToolError(
      Code.NOT_FOUND,
      `No open thread ${commentId} in this project. Use list_feedback to see what is there.`
    );
  }
  return thread;
}
