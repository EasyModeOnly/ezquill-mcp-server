/**
 * The caller's credential, per request, without threading it through every
 * function that might one day need it.
 *
 * The remote transport serves many people from one process: a token belongs to
 * a REQUEST, not to the server. A module-level variable would be a
 * cross-contamination bug that only appears under concurrency, which is the
 * worst kind to find in production.
 *
 * AsyncLocalStorage is the right tool because exactly ONE line ever reads the
 * credential (`api.js`, building the Authorization header). Everything else —
 * every tool, every handler — stays unaware that a credential exists at all.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/** Run fn with this request's credential in scope. */
export function withRequest(context, fn) {
  return storage.run(context, fn);
}

/** The current request's context, or an empty object off-request. */
export function currentRequest() {
  return storage.getStore() ?? {};
}
