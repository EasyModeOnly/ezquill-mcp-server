/**
 * The one place that talks to the ezQuill API, and the one place that reads a
 * credential.
 *
 * Keeping that to a single line is what makes the stdio and HTTP transports the
 * same server: the local one puts a cached OAuth token on the request context,
 * the remote one puts the caller's forwarded bearer token there, and nothing
 * downstream can tell the difference or needs to.
 */
import { resolveCredential } from './credentials.js';
import { Code, ToolError, codeForStatus } from './errors.js';

const DEFAULT_BASE_URL = 'https://api.ezquill.com';

export function baseUrl() {
  return (process.env.EZQUILL_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/**
 * One API call.
 *
 * @param {string} path under /api/v1 (or under the API root with `root`),
 *   leading slash included
 * @param {{method?: string, body?: unknown, query?: Record<string, unknown>, root?: boolean}} [opts]
 *
 * `root: true` drops the `/api/v1` prefix. The API registers the caller's own
 * account routes at its ROOT — `/me`, `/me/inbox`, `/me/words` — not under
 * `/api/v1`, and a wrong prefix is not an error anyone sees: it is a 404, which
 * a tool reports as "not found" about something that exists. So the choice is
 * made per call, visibly, rather than guessed from the path.
 */
export async function call(path, opts = {}) {
  // The ONE place a credential is read. Everything else — every tool, every
  // handler — stays unaware that one exists.
  const { token } = await resolveCredential();
  if (!token) {
    throw new ToolError(
      Code.NOT_AUTHENTICATED,
      'Not signed in to ezQuill.'
    );
  }

  const url = new URL(`${baseUrl()}${opts.root ? '' : '/api/v1'}${path}`);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    // Repeatable filters (kind, tag, status, nodeType) arrive as arrays and the
    // API reads every occurrence, so they are appended rather than joined.
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.append(key, String(v));
    }
  }

  const response = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  if (response.status === 204) return null;

  if (!response.ok) {
    const { message, body } = await readFailure(response);
    const err = new ToolError(codeForStatus(response.status), message, {
      status: response.status,
    });
    // The parsed body rides on the error for the few callers whose failure
    // body IS the answer — a dictionary 404 carries the spelling suggestions.
    // A property rather than `detail`, because detail is spread into the tool
    // result, and no other tool should start echoing raw API bodies at an
    // agent. A caller that wants it catches, checks `detail.status`, and reads
    // it, the same way search_project already handles its 503.
    err.body = body;
    throw err;
  }

  return response.json();
}

/**
 * The API's error body is `{error: {message, ...}}`. Fall back to the status
 * text rather than inventing a message, so a transcript never shows a
 * reassuring sentence this code made up.
 */
async function readFailure(response) {
  let body;
  try {
    body = await response.json();
    const message = body?.error?.message;
    if (typeof message === 'string' && message) return { message, body };
  } catch {
    // A non-JSON body (a proxy's HTML error page) is not worth reporting in
    // full; the status is the useful part.
  }
  return {
    message: `ezQuill API returned ${response.status} ${response.statusText}`.trim(),
    body,
  };
}

/**
 * Follow the API's `hasMore` until it stops saying there is more.
 *
 * `getProjectNodes` in the web app had this same bug and it is worth restating:
 * a project over the endpoint's page cap silently returns PART of itself, and
 * because nodes sort by `order` across the whole project rather than by tree
 * position, the part returned has holes through the middle rather than a
 * missing tail. Building a tree from that promotes every parentless node to a
 * root, and the result looks fine.
 *
 * @param {string} path
 * @param {string} key the domain-named array key (`nodes`, `entities`, ...)
 * @param {object} query
 * @param {number} [cap] stop after this many rows, so one call cannot hang
 */
export async function callPaged(path, key, query = {}, cap = 20000) {
  const rows = [];
  let offset = Number(query.offset) || 0;

  for (;;) {
    const page = await call(path, { query: { ...query, offset } });
    const batch = page?.[key] ?? [];
    rows.push(...batch);

    if (!page?.hasMore || batch.length === 0 || rows.length >= cap) break;
    offset += batch.length;
  }

  return rows;
}
