/**
 * Putting words in a manuscript.
 *
 * # This tool does NOT expose the endpoint it uses, and that is the point
 *
 * `PUT /nodes/{id}/blocks` is a whole-section RECONCILE: the list you send
 * becomes the section, and **a block present in the database and absent from
 * the list is REMOVED**. That is exactly right for the editor, which holds the
 * entire document in memory and is describing its current state.
 *
 * It is catastrophic for an agent, which does not. Send three paragraphs to a
 * forty-paragraph scene and thirty-seven are soft-deleted — a correct call to a
 * correct endpoint that destroys most of a chapter.
 *
 * So the tool offers INTENT — append, fill_plan, revise — and composes the
 * reconcile itself from the section's current blocks. The dangerous shape is
 * not gated behind a confirmation somebody can click through; it is not
 * reachable.
 *
 * # Additive goes direct; overwriting becomes a suggestion
 *
 * `append` and `fill_plan` destroy nothing: one adds paragraphs after the last,
 * the other writes into a block that is planned and empty. Both are soft-
 * deletable afterwards, so refusing and undoing are cheap.
 *
 * `revise` replaces words a person wrote, which is the one that gets a
 * connector uninstalled. It creates a SUGGESTION instead — an anchored proposed
 * edit the writer accepts in ezQuill — and the connector has no tool that can
 * accept one.
 */
import { randomUUID } from 'node:crypto';
import { call } from '../lib/api.js';
import { ToolError, Code } from '../lib/errors.js';
import { refuseUnmigrated, sectionBlocks } from '../lib/sections.js';
import { locateQuote } from '../lib/quote-target.js';

/**
 * The Tiptap mark ezQuill records AI-written text with (ezquill epic #69).
 * Its name is fixed by the editor (`AI_TEXT_MARK`) and by the API's generated
 * `nodes.ai_chars`, which counts the characters under it. Never rename it.
 */
const AI_TEXT_MARK = 'aiText';

/**
 * One block is one top-level paragraph.
 *
 * Its text is marked as AI's: everything this tool writes was written by the
 * agent calling it, and this goes straight to `PUT /blocks`, never through the
 * editor that marks accepted AI text (ezquill #888). The writer's share of
 * their own manuscript is counted from this mark.
 */
const paragraph = (text) => ({
  document: {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: AI_TEXT_MARK }] }] },
    ],
  },
  plainText: text,
});

export const tools = [
  {
    name: 'write_draft',
    description:
      'Write prose into a scene. `append` adds paragraphs at the end; `fill_plan` writes ' +
      'a paragraph that was planned but not yet written; `revise` PROPOSES replacing ' +
      'existing words, which the writer accepts in ezQuill. Never replaces prose directly.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        nodeId: { type: 'string', description: 'The scene, from get_outline or a search result.' },
        action: { type: 'string', enum: ['append', 'fill_plan', 'revise'] },
        paragraphs: {
          type: 'array',
          items: { type: 'string' },
          description: 'For append: one entry per paragraph.',
        },
        blockId: {
          type: 'string',
          description: 'For fill_plan: which planned paragraph to write. From read_scene.',
        },
        text: { type: 'string', description: 'For fill_plan: the prose to write into it.' },
        quote: {
          type: 'string',
          description:
            'For revise: the exact existing words to replace. Must appear once in the scene.',
        },
        replacement: {
          type: 'string',
          description:
            'For revise: what to put there instead. An EMPTY string proposes cutting the ' +
            'passage, which is a real and common suggestion.',
        },
        note: { type: 'string', description: 'For revise: why. Shown to the writer.' },
      },
      required: ['projectId', 'nodeId', 'action'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },

    async handler(args) {
      const { projectId, nodeId, action } = args;

      if (action === 'revise') return propose(args);

      const blocks = await sectionBlocks(projectId, nodeId);

      if (action === 'append') {
        const texts = (args.paragraphs ?? []).filter((t) => typeof t === 'string' && t.trim());
        if (texts.length === 0) {
          throw new ToolError(Code.REQUEST_FAILED, 'append needs at least one paragraph.');
        }
        const adoptSectionProse = await refuseUnmigrated(projectId, nodeId, blocks);

        // Every existing block is sent back BY ID WITH NO CONTENT, which the
        // endpoint reads as "unchanged". Omitting them would delete them;
        // resending their prose would make the request scale with the section
        // rather than with the edit, and would re-save words nobody touched.
        const save = [
          ...blocks.map((b) => ({ id: b.id })),
          ...texts.map((t) => ({ id: randomUUID(), content: paragraph(t) })),
        ];

        return report(
          await call(`/projects/${projectId}/nodes/${nodeId}/blocks`, {
            method: 'PUT',
            body: { blocks: save, ...(adoptSectionProse ? { adoptSectionProse: true } : {}) },
          }),
          { added: texts.length }
        );
      }

      if (action === 'fill_plan') {
        const target = blocks.find((b) => b.id === args.blockId);
        if (!target) {
          throw new ToolError(
            Code.NOT_FOUND,
            `No planned paragraph ${args.blockId} in this scene. Use read_scene to list them.`
          );
        }
        // The line between additive and overwriting, enforced rather than
        // trusted. A block that already has words is somebody's prose, and
        // replacing it is what `revise` is for.
        if (target.hasProse) {
          throw new ToolError(
            Code.REQUEST_FAILED,
            'That paragraph is already written. Use action "revise" to propose a change to it, ' +
              'so the writer can accept or reject it.'
          );
        }
        if (!args.text?.trim()) {
          throw new ToolError(Code.REQUEST_FAILED, 'fill_plan needs text.');
        }

        const save = blocks.map((b) =>
          b.id === target.id
            ? {
                id: b.id,
                content: paragraph(args.text),
                // Guards THIS block alone. If somebody wrote into it between
                // the read and the write, this one is refused and reported
                // while every other paragraph in the save still lands.
                ...(typeof b.contentVersion === 'number'
                  ? { ifContentVersion: b.contentVersion }
                  : {}),
              }
            : { id: b.id }
        );

        return report(
          await call(`/projects/${projectId}/nodes/${nodeId}/blocks`, {
            method: 'PUT',
            body: { blocks: save },
          }),
          { filled: target.id }
        );
      }

      throw new ToolError(Code.REQUEST_FAILED, `Unknown action: ${action}`);
    },
  },
];

/**
 * Propose a change instead of making one.
 *
 * `comments.replacement` is an anchored proposed edit: it needs only Comment to
 * create, the writer accepts it in ezQuill with the diff in front of them, and
 * it PERSISTS — it survives this session ending, which no confirmation dialog
 * inside an agent can.
 */
async function propose({ projectId, nodeId, quote, replacement, note }) {
  if (typeof replacement !== 'string') {
    throw new ToolError(
      Code.REQUEST_FAILED,
      'revise needs a replacement. Use an empty string to propose cutting the passage.'
    );
  }
  if (!quote?.trim()) {
    throw new ToolError(Code.REQUEST_FAILED, 'revise needs the exact existing words to replace.');
  }
  if (quote === replacement) {
    throw new ToolError(
      Code.REQUEST_FAILED,
      'The replacement is identical to the quoted text — there is nothing to propose.'
    );
  }
  // A suggestion replaces TEXT. `> ` is markdown for a quote block, and as a
  // suggestion it would land as a literal ">" mid-paragraph: the line would
  // still not be dialogue, and the prompt would gain stray characters
  // (Saltpig shorts, shot 6). Changing a paragraph's kind is its own action.
  if (/^\s*>/.test(replacement)) {
    throw new ToolError(
      Code.REQUEST_FAILED,
      'A suggestion replaces text and cannot make a quote block — a leading ">" would be inserted literally. ' +
        'To mark a shot\'s line as dialogue, use manage_production action "mark_dialogue".'
    );
  }

  // Since prose moved into paragraph blocks, a comment belongs to the BLOCK
  // its words are in, anchored in that block's own document — that is the
  // node the Comments panel lists (ezquill #456). Posted on the scene, the
  // suggestion existed and nobody could see it. The quote must occur exactly
  // once in the section and inside one paragraph (lib/quote-target.js).
  const { target, anchor } = await locateQuote(projectId, nodeId, quote);

  const comment = await call(`/projects/${projectId}/nodes/${target}/comments`, {
    method: 'POST',
    body: {
      body: note?.trim() || 'Suggested edit',
      // `text` is the authoritative half: it is what stood there, and the
      // editor shows the comment as detached rather than guessing if the
      // positions stop matching it.
      anchor,
      replacement,
      // The comment is posted under the writer's own token, so its author is
      // a person either way. This is what tells ezQuill the words are an AI
      // assistant's, so accepting the proposal marks them as AI text
      // (ezquill #888). Needs an API that has comments.origin (000071).
      origin: 'ai',
    },
  });

  return {
    proposed: comment.id,
    quoted: quote,
    replacement,
    // Said plainly, because an agent that reports "done" here would be telling
    // the writer their manuscript changed when it has not.
    status:
      'Proposed, not applied. The writer sees this as a suggested edit in ezQuill and ' +
      'decides whether to accept it.',
  };
}

/**
 * Report what the save actually did, refusals included.
 *
 * A reconcile can partly succeed: one stale paragraph is refused while the rest
 * land. Claiming a clean result would hide that, and the refused words exist
 * nowhere the agent can see — though the server keeps them as a version, which
 * is worth telling the writer.
 */
function report(result, extra) {
  const refused = result?.refused ?? [];
  return {
    ...extra,
    blocks: (result?.blocks ?? []).length,
    ...(refused.length > 0
      ? {
          refused: refused.map((r) => ({ id: r.id, draftKept: r.draftKept })),
          warning:
            'Some paragraphs were not saved because somebody else changed them first. ' +
            'Their text was kept as a version in ezQuill. Re-read the scene before retrying.',
        }
      : {}),
  };
}
