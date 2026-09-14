/**
 * An entity profile has two layers, and reading the wrong one silently ignores
 * the writer.
 *
 * `profile.authored` holds what a person filled in through the per-kind form.
 * The Resonance engine writes ITS keys at the top level and never touches that
 * namespace, which is what lets an edit to an imported character survive
 * re-importing the bundle.
 *
 * **The writer's value wins.** Code that reads `profile.role` directly gets the
 * imported value and ignores the edit — no error, no warning, just a stale
 * answer that looks authoritative. The Go API stores the blob raw and resolves
 * nothing, so every reader has to do this, and this is the connector's copy of
 * a rule that otherwise lives only in `lib/types/compendium.ts`.
 *
 * **An EMPTY authored value falls through to the engine's**, rather than
 * masking it. Clearing a field means "I have nothing to say about this", not
 * "this character has no faction" — and masking would leave an empty string
 * permanently hiding an imported value with no way to get it back.
 */

const isEmpty = (value) =>
  value === undefined ||
  value === null ||
  value === '' ||
  (Array.isArray(value) && value.length === 0);

/**
 * Flatten a profile to the values a reader should see.
 *
 * @param {unknown} profile the raw `profile` blob off the wire
 * @returns {Record<string, unknown>}
 */
export function resolveProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return {};

  const engine = profile;
  const authored =
    engine.authored && typeof engine.authored === 'object' && !Array.isArray(engine.authored)
      ? engine.authored
      : {};

  const resolved = {};
  for (const key of new Set([...Object.keys(engine), ...Object.keys(authored)])) {
    // `authored` is the namespace, not a field. Emitting it would hand the
    // caller both layers again and invite them to pick the wrong one.
    if (key === 'authored') continue;

    const value = isEmpty(authored[key]) ? engine[key] : authored[key];
    if (!isEmpty(value)) resolved[key] = value;
  }

  return resolved;
}
