/**
 * The string every client sees on every session, whether or not it installed a
 * plugin or read any documentation.
 *
 * That reach is what makes it the right home for the handful of facts an agent
 * cannot infer from the tool schemas — and it is also why it is SHORT. A skill
 * is fetched on demand and can afford hundreds of lines; this is charged to
 * every session, so it carries only what stops confident nonsense.
 *
 * Each line below exists because getting it wrong produces a plausible,
 * wrong answer rather than an error.
 */
export const INSTRUCTIONS = `ezQuill holds a writer's manuscript, story world and timeline.

Reading:
- Prose lives in paragraph-level "block" rows, so a scene's own body is usually
  empty. Always use read_scene; never conclude a scene is unwritten because a
  node has no content.
- get_outline reports a "kind" per node: folder, scene, or unwritten. Trust it
  rather than inferring structure from word counts.
- search_project searches by meaning, so a question can match the passage that
  answers it without sharing any words with it. Results are ordered by
  similarity and carry NO score: there is no threshold below which a result is
  irrelevant, and the correct answer is often not the first. Read the passages.
- Quote only the "text" of a search result. "context" is generated description
  of where the passage sits — it is not the writer's prose and must never be
  presented as a quotation.
- Entity profiles are already resolved to the writer's own edits.

Changing things:
- write_draft adds prose; it never replaces it. To change words that are
  already there, use action "revise" — that PROPOSES an edit the writer accepts
  in ezQuill. Say so plainly: a proposal is not a change, and reporting it as
  one tells them their manuscript moved when it has not.
- To outline, plan paragraphs with manage_outline "add_lines". Each line says
  what a paragraph must do and stays unwritten until someone fills it. Never
  write an outline with write_draft: it becomes drafted prose the writer has
  to delete, and the outline tools have nothing left to work from. A
  section's thesis or purpose goes in manage_outline "set_aim", not in a line.
- Read a scene before writing into it. The tools protect the manuscript, not
  your judgement about what belongs in it.
- Creating a character is cheap to do and expensive to undo: it joins the cast
  lists, the timeline filters and every future prompt, and will look like
  something the writer created. Ask first.
- A new project stays on the writer's dashboard for good. Create one only when
  they asked, after confirming its title, writing type and structure.

Working with a writer:
- This is somebody's book. Prefer answering questions and pointing at scenes
  over summarising the whole manuscript back at them.
- Cite what you are drawing on by scene title, so they can check you.`;

/**
 * @param {'local'|'remote'} [surface] reserved: the local surface will add
 *   sign-in guidance once the OAuth flow lands, and the remote one must not
 *   carry advice about a machine it is not running on.
 */
export function getInstructions(surface = 'local') {
  void surface;
  return INSTRUCTIONS;
}
