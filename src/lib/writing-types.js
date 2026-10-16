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
let universal = [];

/** Every writing type's levels. Fetched once per process. */
export async function loadWritingTypes() {
  if (cached) return cached;
  const body = await call('/writing-types');
  const byKey = new Map((body?.writingTypes ?? []).map((w) => [w.key, w]));
  universal = Array.isArray(body?.universalLevels) ? body.universalLevels : [];
  cached = byKey;
  return byKey;
}

/** For tests: forget what was fetched. */
export function resetWritingTypes() {
  cached = null;
  universal = [];
}

/** One writing type's registry entry, or undefined if the API does not know it. */
export async function writingType(key) {
  return (await loadWritingTypes()).get(key);
}

/**
 * The chain for a writing type — or for a PROJECT, whose shape and production
 * switch pick a script's levels (ezquill epic #48).
 *
 * A script's entry carries `variants`, one per (shape, production), each
 * already resolved by the API's registry; this only looks one up. A bare key
 * gets the entry's own levels, which are its default variant's (a feature,
 * written) — right for a type with one shape, and the reason a caller holding
 * a project passes the project.
 */
async function chainFor(ref) {
  const key = typeof ref === 'string' ? ref : ref?.writingType;
  const entry = await writingType(key);
  if (!entry) return undefined;
  if (typeof ref === 'string' || !Array.isArray(entry.variants) || entry.variants.length === 0) return entry;
  const production = ref.production === true;
  const shape = entry.variants.some((v) => v.shape === ref.shape) ? ref.shape : entry.variants[0].shape;
  return entry.variants.find((v) => v.shape === shape && v.production === production) ?? entry;
}

/**
 * The levels of a writing type or a project, outermost first. Empty for an
 * unknown type.
 */
export async function levelsFor(ref) {
  return (await chainFor(ref))?.levels ?? [];
}

/** The shapes a writing type may take, default first; empty for a type with one. */
export async function shapesFor(key) {
  const variants = (await writingType(key))?.variants ?? [];
  return [...new Set(variants.map((v) => v.shape))];
}

/**
 * Every node type a writer may ADD in this writing type: its levels, then the
 * universal ones every type shares — today the unnumbered `group` folder
 * ("Specials", "Unproduced scripts").
 *
 * Kept apart from `levelsFor` on purpose: that is the planting chain, and a
 * group is never planted.
 */
export async function addableLevelsFor(ref) {
  const levels = await levelsFor(ref);
  return [...levels, ...universal.filter((u) => !levels.some((l) => l.key === u.key))];
}

/** The levels the web wizard plants for this type: the chain down to the first prose level. */
export async function plantedLevelsFor(ref) {
  return (await chainFor(ref))?.plantedLevels ?? [];
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
export async function isKnownNodeType(ref, nodeType) {
  return (await levelsFor(ref)).some((level) => level.key === nodeType);
}
