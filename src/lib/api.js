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
import { appBaseUrl } from './app-url.js';

const DEFAULT_BASE_URL = 'https://api.ezquill.com';

export function baseUrl() {
  return (process.env.EZQUILL_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/**
 * One API call.
 *
 * @param {string} path under /api/v1 (or under the API root with `root`),
 *   leading slash included
 * @param {{method?: string, body?: unknown, query?: Record<string, unknown>, root?: boolean, app?: boolean}} [opts]
 *
 * `root: true` drops the `/api/v1` prefix. The API registers the caller's own
 * account routes at its ROOT — `/me`, `/me/inbox`, `/me/words` — not under
 * `/api/v1`, and a wrong prefix is not an error anyone sees: it is a 404, which
 * a tool reports as "not found" about something that exists. So the choice is
 * made per call, visibly, rather than guessed from the path.
 *
 * `app: true` targets the WEB APP instead (EZQUILL_APP_BASE_URL), at the path
 * given. A few answers are computed by the web app's own TypeScript — compiling
 * a shot's prompt, the production dashboard — and porting them here would be a
 * second copy to drift (ezquill epic #38). Same bearer token: the web route
 * forwards it to the API, which applies the same access rules.
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

  const url = new URL(
    opts.app ? `${appBaseUrl()}${path}` : `${baseUrl()}${opts.root ? '' : '/api/v1'}${path}`
  );
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    // Repeatable filters (kind, tag, status, nodeType) arrive as arrays and the
    // API reads every occurrence, so they are appended rather than joined.
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.append(key, String(v));
    }
  }

  const send = () =>
    fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });

  let response = await send();
  let attempts = 1;
  for (;;) {
    if (response.status !== 429 || attempts >= retry.attempts) break;
    const wait = waitBeforeRetry(response, attempts);
    if (wait === null) break;
    await retry.sleep(wait);
    response = await send();
    attempts += 1;
  }

  if (response.status === 204) return null;

  if (!response.ok) {
    const { message, body } = await readFailure(response);
    const err = new ToolError(codeForStatus(response.status), message, {
      status: response.status,
      ...(attempts > 1 ? { attempts } : {}),
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
 * How a 429 is retried, and the clock it waits on (tests replace `sleep` and
 * `random` so they take no real time).
 *
 * An agent recording a production run fires a few dozen calls inside a second
 * and meets the API's per-user burst limit (ezquill #233). Failing the tool
 * there hands the agent a problem it can only solve by retrying blindly, and
 * usually too fast.
 *
 * Retrying is safe for EVERY method, POST included: the API refuses in
 * middleware (`ratelimit.go`, `tooManyRequests`) before any handler runs, so a
 * refused write did nothing and replaying it cannot write twice.
 *
 * - `attempts` counts the first call, so 3 means at most two retries.
 * - `fallbackMs` is used when there is no usable Retry-After. The web app's
 *   routes (`app: true`) pass an API 429's status through without the header.
 * - `maxWaitMs`: a server asking for longer than this is refused outright
 *   rather than waited on. The remote transport holds the agent's MCP request
 *   open while this sleeps, and a limit that long is not a burst.
 */
export const retry = {
  attempts: 3,
  fallbackMs: 1000,
  maxWaitMs: 5000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

/**
 * Milliseconds to wait before retry number `attempt`, or null to give up.
 *
 * The server's hint is a floor, never shortened: returning earlier than
 * Retry-After is being refused again. It doubles per retry, and random jitter
 * of up to the same again goes on top. Without the jitter, thirty calls
 * refused together all return in the same instant and meet the same limit.
 */
function waitBeforeRetry(response, attempt) {
  const asked = retryAfterMs(response.headers?.get?.('Retry-After'));
  if (asked !== null && asked > retry.maxWaitMs) return null;
  const base = (asked ?? retry.fallbackMs) * 2 ** (attempt - 1);
  return Math.round(base + retry.random() * base);
}

/** Retry-After is either delta-seconds or an HTTP date (RFC 9110 §10.2.3). */
function retryAfterMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
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
    // The API nests the message; the web app's routes send it bare.
    const message = typeof body?.error === 'string' ? body.error : body?.error?.message;
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
