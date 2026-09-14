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

/**
 * The process-wide fallback, for a transport that cannot carry a store.
 *
 * # Why this exists, which is not obvious and cost an end-to-end run to find
 *
 * AsyncLocalStorage propagates through async resources created INSIDE a run().
 * It does not survive an EventEmitter: a listener attached inside a context is
 * invoked later in the context of whatever emitted, not of whatever registered
 * it. The stdio transport reads stdin through exactly such a listener, so
 * wrapping `server.connect()` in a store leaves every later tool call outside
 * it — and the tools all answer NOT_AUTHENTICATED while the credential sits
 * right there.
 *
 * Every unit test missed this, because a test calls a handler directly and is
 * therefore genuinely inside the run().
 *
 * This is safe precisely where it is used and nowhere else. The stdio server
 * serves ONE person on one process, so a process-wide credential IS that
 * request's credential. The HTTP server serves many and never touches this: it
 * always runs inside a store, which wins below.
 */
let fallback = null;

/**
 * Set the credential used when no request store is active.
 *
 * Never call this from a multi-tenant transport. The store always takes
 * precedence, so a per-request credential cannot be overridden by one.
 */
export function setDefaultRequest(context) {
  fallback = context;
}

/** Run fn with this request's credential in scope. */
export function withRequest(context, fn) {
  return storage.run(context, fn);
}

/**
 * The current request's context.
 *
 * The store first, always — that is the per-request credential and it must
 * never lose to a process-wide one.
 */
export function currentRequest() {
  return storage.getStore() ?? fallback ?? {};
}
