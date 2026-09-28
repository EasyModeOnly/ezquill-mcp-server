/**
 * An entity's PRODUCTION fields — what a video generator needs to draw it: a
 * look line, a reference-asset id, a voice, a set's geography. Shortform-video
 * projects only.
 *
 * Two layers, like a profile (ezQuill Decision 620aaa97):
 *
 * - `metadata.bible` is written by the show-bible import, which refreshes it on
 *   every re-import.
 * - `metadata.production` is written by a person in the app, or by this
 *   connector. It wins, key by key, so an edit survives a re-import.
 *
 * The prompt compiler reads through that rule (`lib/showbible/assets.ts` in the
 * web app), and this is the connector's copy of it. It is NOT the profile:
 * writing a look line into `profile` puts it where the compiler never looks,
 * which is exactly how a customer's whole cast came out un-drawable.
 *
 * `metadata` is ASSIGNED on PATCH (`metadata = $n`), so a write rebuilds the
 * whole object from the row that was read — the import's key, its rules and
 * everything else — and changes only `production`.
 */

const asObject = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

const isEmpty = (value) =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0);

// `false` over a bible that says nothing states nothing: every flag is read as
// `=== true` by the compiler.
const same = (a, b) =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((v, i) => v === b[i])
    : a === b || (a === false && b === undefined);

/**
 * The production values a reader should see: the edit where there is one, the
 * bible's otherwise. `rules` are not production fields and are left out.
 *
 * @param {unknown} metadata the raw `metadata` blob off the wire
 * @returns {Record<string, unknown>}
 */
export function resolveProduction(metadata) {
  const { rules: _rules, ...bible } = asObject(asObject(metadata).bible);
  const resolved = { ...bible, ...asObject(asObject(metadata).production) };
  for (const [key, value] of Object.entries(resolved)) {
    if (isEmpty(value)) delete resolved[key];
  }
  return resolved;
}

/**
 * The whole metadata object to PATCH back, with `values` written into
 * `production`.
 *
 * An empty value — or one equal to what the bible already says — REMOVES the
 * key, which is how a caller says "use the bible's". Storing it would shadow
 * every later bible change while appearing to agree with it.
 *
 * @param {unknown} metadata the row's current metadata
 * @param {Record<string, unknown>} values
 * @returns {Record<string, unknown>}
 */
export function withProduction(metadata, values) {
  const base = asObject(metadata);
  const bible = asObject(base.bible);
  const production = { ...asObject(base.production) };

  for (const [key, raw] of Object.entries(values)) {
    const value = typeof raw === 'string' ? raw.trim() : raw;
    if (isEmpty(value) || same(value, bible[key])) delete production[key];
    else production[key] = value;
  }

  const { production: _old, ...rest } = base;
  return Object.keys(production).length > 0 ? { ...rest, production } : rest;
}
