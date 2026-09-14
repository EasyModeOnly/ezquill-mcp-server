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
import { tools as auth } from './auth.js';

export const TOOLS = [
  ...projects,
  ...search,
  ...outline,
  ...storyWorld,
  ...timeline,
  ...feedback,
  // Last: signing in is not what the surface is FOR, and a client that shows
  // tools in order should lead with the manuscript.
  ...auth,
];
