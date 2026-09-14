/**
 * The structural vocabulary of each writing type, as the API serves it.
 *
 * # Why this is fetched rather than written down here
 *
 * `nodes.node_type` is open TEXT and the API stores whatever it is given, so a
 * wrong level is never refused — it is planted, and nobody notices until a
 * writer opens a binder of `fiction`-typed folders. The registry that says what
 * a novel's levels ARE lives in the ezQuill repo, where the creation wizard
 * reads it too. A copy here would be the third, and the one furthest from the
 * other two, which is how a vocabulary rots (the web app has already paid for a
 * second copy of a registry map once).
 *
 * So the connector asks `GET /writing-types` and checks against the answer.
 *
 * # Cached in-process, but never a failure
 *
 * The vocabulary changes only with a deploy of the API, so one fetch per
 * process is plenty. A FAILED fetch is not cached: caching it would turn one
 * cold-start blip into a connector that refuses every creation until restart.
 */
import { call } from './api.js';

let cached = null;

/** Every writing type's levels. Fetched once per process. */
export async function loadWritingTypes() {
  if (cached) return cached;
  const body = await call('/writing-types');
  const byKey = new Map((body?.writingTypes ?? []).map((w) => [w.key, w]));
  cached = byKey;
  return byKey;
}

/** For tests: forget what was fetched. */
export function resetWritingTypes() {
  cached = null;
}

/** One writing type's registry entry, or undefined if the API does not know it. */
export async function writingType(key) {
  return (await loadWritingTypes()).get(key);
}

/** The levels of a writing type, outermost first. Empty for an unknown type. */
export async function levelsFor(key) {
  return (await writingType(key))?.levels ?? [];
}

/** The levels the web wizard plants for this type: the chain down to the first prose level. */
export async function plantedLevelsFor(key) {
  return (await writingType(key))?.plantedLevels ?? [];
}

/**
 * Whether a node type belongs to this writing type's vocabulary.
 *
 * Membership only, not nesting. The registry's `children` is a convention — the
 * tree is recursive and a writer who wants to split a scene may — so refusing a
 * scene under a scene would block something legitimate. What IS never
 * legitimate is a word the writing type does not have, which is the silent
 * failure this exists to catch.
 */
export async function isKnownNodeType(key, nodeType) {
  return (await levelsFor(key)).some((level) => level.key === nodeType);
}
