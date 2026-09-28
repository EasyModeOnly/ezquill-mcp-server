/**
 * The entity kinds and fields a PROJECT defines, beside the ones ezQuill ships
 * (ezquill epic #38, task #405).
 *
 * They live on `projects.metadata.entityTemplates[kind]`. The API accepts any
 * kind string and any profile key, so without these an agent has no way to
 * know that this project's "Format" carries "The beats", or that its characters
 * have a "Catchphrase" — and fills in nothing, or invents keys the form never
 * shows.
 *
 * Reported in a flattened shape an agent can act on: each field's `key` is
 * what goes in `profile` (or in `production`, for production fields) when
 * calling manage_entity. Malformed entries are dropped, never passed through,
 * for the same reason the web app's reader is total.
 */

const SHAPES = {
  text: 'short text',
  longtext: 'paragraph',
  url: 'link',
  enum: 'one of the options (any value allowed)',
  multi: 'array of the options (any values allowed)',
  number: 'number',
  bool: 'true or false',
  date: 'date',
  list: 'array of short strings',
};

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function readFields(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const f of raw) {
    const key = str(f?.key);
    const label = str(f?.label);
    const t = f?.spec?.t;
    if (!key || !label || !SHAPES[t]) continue;
    out.push({
      key,
      label,
      type: SHAPES[t],
      ...(Array.isArray(f.spec.options) && f.spec.options.length ? { options: f.spec.options } : {}),
      ...(str(f.hint) ? { hint: str(f.hint) } : {}),
    });
  }
  return out;
}

/**
 * @param {unknown} metadata a project's raw metadata
 * @returns {Record<string, {label: string, pluralLabel: string, supporting: boolean,
 *   fields: object[], productionFields: object[]}>}
 */
export function readEntityTemplates(metadata) {
  const raw = metadata && typeof metadata === 'object' ? metadata.entityTemplates : undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [kind, t] of Object.entries(raw)) {
    const label = str(t?.label);
    if (!label) continue;
    out[kind] = {
      label,
      pluralLabel: str(t.pluralLabel) ?? label,
      supporting: t.supporting === true,
      fields: readFields(t.authoredFields),
      productionFields: readFields(t.productionFields),
    };
  }
  return out;
}
