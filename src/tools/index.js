/**
 * Every tool this server has, in one list.
 *
 * The ORDER is the order a client shows them, so it runs roughly the way a
 * writer would work: find the project, understand it, search it, then read.
 */
import { tools as projects } from './projects.js';
import { tools as search } from './search.js';
import { tools as outline } from './outline.js';
import { tools as storyWorld } from './story-world.js';
import { tools as timeline } from './timeline.js';
import { tools as feedback } from './feedback.js';
import { tools as dictionary } from './dictionary.js';
import { tools as writeProjects } from './write-projects.js';
import { tools as writeOutline } from './write-outline.js';
import { tools as writeDraft } from './write-draft.js';
import { tools as writeStoryWorld } from './write-story-world.js';
import { tools as writeTimeline } from './write-timeline.js';
import { tools as writeFeedback } from './write-feedback.js';
import { tools as auth } from './auth.js';

export const TOOLS = [
  ...projects,
  ...search,
  ...outline,
  ...storyWorld,
  ...timeline,
  ...feedback,
  // Last among the reads: the dictionary is reference, not the manuscript —
  // something an agent reaches for mid-draft, not where it starts.
  ...dictionary,
  // Writes after reads, because that is the order the work happens in: an
  // agent that changes a manuscript it has not read is the thing this surface
  // is shaped to discourage.
  // Creating a project first among the writes: it is the one that makes the
  // others possible for somebody who has nothing yet.
  ...writeProjects,
  ...writeOutline,
  ...writeDraft,
  ...writeStoryWorld,
  ...writeTimeline,
  ...writeFeedback,
  // Last: signing in is not what the surface is FOR, and a client that shows
  // tools in order should lead with the manuscript.
  ...auth,
];
