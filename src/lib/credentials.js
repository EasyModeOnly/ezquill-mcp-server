/**
 * Which credential this process uses, and keeping it fresh.
 *
 * # Precedence, one way only
 *
 *   1. the request context   — the remote transport, per caller
 *   2. EZQUILL_TOKEN         — an explicit credential somebody configured
 *   3. a cached OAuth token  — what signing in through the server produced
 *
 * An EXPLICIT credential has to beat an implicit one. Somebody who sets
 * EZQUILL_TOKEN is stating which account this server acts as, and having a
 * cached sign-in quietly win would make that setting a lie — with no way to
 * tell from the outside which one was used.
 *
 * The consequence is handled rather than ignored: a 401 while EZQUILL_TOKEN is
 * set does NOT offer a browser sign-in, because a sign-in could not take
 * effect. Sending somebody on an errand that cannot work is worse than saying
 * nothing.
 */
import { chmod, mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { currentRequest } from './request-context.js';
import { refresh } from './oauth.js';

/**
 * Resolved on every call, not once at import.
 *
 * Read once, a later change to EZQUILL_TOKEN_PATH would be silently ignored and
 * the process would keep using a credential from a file the configuration no
 * longer names — which is the same class of bug as a stale memoised cache, and
 * just as quiet.
 */
const cachePathNow = () =>
  process.env.EZQUILL_TOKEN_PATH || join(homedir(), '.ezquill', 'mcp-token.json');

let cache = null;
/**
 * WHICH path the cache came from, rather than a boolean "loaded".
 *
 * The memoisation is worth having — a tool call must not stat the filesystem —
 * but it has to be keyed on the thing that decides the answer. A plain flag
 * means the first read wins for the life of the process even if the configured
 * path changes underneath it.
 */
let loadedFrom = null;

async function load() {
  const path = cachePathNow();
  if (loadedFrom === path) return cache;
  loadedFrom = path;
  try {
    cache = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    // Absent, unreadable or corrupt all mean the same thing: not signed in.
    cache = null;
  }
  return cache;
}

async function persist(tokens) {
  const path = cachePathNow();
  cache = tokens;
  loadedFrom = path;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(tokens), { mode: 0o600 });
  // writeFile's mode applies only on CREATE, so an existing file keeps whatever
  // permissions it had. Setting it explicitly means a cache written before this
  // code existed, or by a different umask, is tightened rather than trusted.
  await chmod(path, 0o600);
}

export async function storeTokens(tokens) {
  await persist(tokens);
  return tokens;
}

export async function forgetTokens() {
  const path = cachePathNow();
  cache = null;
  loadedFrom = path;
  try {
    await unlink(path);
  } catch {
    // Already gone is the desired state.
  }
}

/**
 * Refreshing is SINGLE-FLIGHT.
 *
 * Keycloak rotates refresh tokens: issuing a new one kills the old. Two
 * concurrent refreshes therefore race to invalidate each other and the loser
 * signs the person out. Tool calls run concurrently, so this is a real race
 * rather than a theoretical one — an agent that fires three reads at once is
 * the ordinary case, not the edge.
 */
let inFlight = null;

async function refreshOnce(tokens) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      return await persist(await refresh(tokens.refreshToken)).then(() => cache);
    } catch (err) {
      // Only a dead grant clears the cache. A network blip must not sign
      // somebody out.
      if (err.grantDead) await forgetTokens();
      throw err;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * The token to use for this request, or '' when there is none.
 *
 * @returns {Promise<{token: string, source: 'request'|'env'|'oauth'|'none'}>}
 */
export async function resolveCredential() {
  const { token: requestToken } = currentRequest();
  if (requestToken) return { token: requestToken, source: 'request' };

  const envToken = process.env.EZQUILL_TOKEN;
  if (envToken) return { token: envToken, source: 'env' };

  const tokens = await load();
  if (!tokens?.accessToken) return { token: '', source: 'none' };

  if (tokens.expiresAt && tokens.expiresAt <= Date.now() && tokens.refreshToken) {
    try {
      const fresh = await refreshOnce(tokens);
      return { token: fresh.accessToken, source: 'oauth' };
    } catch {
      // Fall through with what we have. An expired token produces a 401, which
      // the dispatch funnel turns into a sign-in prompt — a better outcome than
      // a refresh error the person cannot act on.
    }
  }

  return { token: tokens.accessToken, source: 'oauth' };
}

/** Whether an explicit credential is configured, which forecloses signing in. */
export const hasExplicitCredential = () => Boolean(process.env.EZQUILL_TOKEN);

export const cachePath = () => cachePathNow();
