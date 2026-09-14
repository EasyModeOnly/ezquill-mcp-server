/**
 * Signing in from the MCP server itself, so installing IS the whole install.
 *
 * Without this, a local install means "go to a settings page, mint a
 * credential, paste it into a JSON file" — three steps before anything works,
 * and the step most people get wrong. With it the first tool call hands back a
 * link, the person clicks, and the agent retries.
 *
 * Authorization Code + PKCE against Keycloak, with the client id shipped in
 * this package. It is a PUBLIC client: there is no secret to leak, which is
 * what makes shipping it fine.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { once } from 'node:events';

const DEFAULT_ISSUER = 'https://auth.ezquill.com/realms/ezquill';
export const CLIENT_ID = process.env.EZQUILL_CLIENT_ID || 'ezquill-mcp';

export const issuer = () =>
  (process.env.EZQUILL_ISSUER || DEFAULT_ISSUER).replace(/\/+$/, '');

/**
 * The scopes requested by default.
 *
 * DELETE IS NOT HERE, and that is deliberate. Keycloak's consent screen is
 * accept-or-decline over the whole requested set, so including it would make
 * "Permanently delete your scenes, characters, timeline events and projects" a
 * condition of installing an MCP server. Somebody who wants an agent that can
 * delete asks for it.
 */
export const DEFAULT_SCOPES = ['openid', 'ezquill:read', 'ezquill:write'];

/** RFC 7636 S256. base64url, no padding. */
function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

let discovered = null;
export async function endpoints() {
  if (discovered) return discovered;
  const response = await fetch(`${issuer()}/.well-known/openid-configuration`);
  if (!response.ok) {
    throw new Error(`cannot reach the ezQuill sign-in service (${response.status})`);
  }
  const doc = await response.json();
  discovered = {
    authorization: doc.authorization_endpoint,
    token: doc.token_endpoint,
    endSession: doc.end_session_endpoint,
  };
  return discovered;
}

/**
 * A sign-in in progress.
 *
 * Held so a SECOND request while one is pending returns the SAME url rather
 * than starting another. Two live flows means two loopback listeners and two
 * states, and whichever url the person did not click sits there until it times
 * out — then they are told their sign-in failed when it did not.
 */
let pending = null;

export const pendingSignIn = () => pending;

/**
 * Start a sign-in and return the url immediately.
 *
 * NEVER blocks on the browser round trip. MCP clients time tool calls out at
 * wildly different limits, and one that gives up at thirty seconds would report
 * a failure for a sign-in that then succeeds in the background.
 */
export async function startSignIn({ scopes = DEFAULT_SCOPES, openBrowser = true } = {}) {
  if (pending) return { authUrl: pending.authUrl, browserOpened: pending.browserOpened, resumed: true };

  const { authorization } = await endpoints();
  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString('base64url');

  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const url = new URL(authorization);
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  const authUrl = url.toString();

  const completion = awaitCallback(server, { state, verifier, redirectUri });

  // A convenience, not the contract. Launch failure is EXPECTED over SSH and in
  // containers and is not an error — the url is what the caller relays, and
  // browserOpened only tells the agent how prominently to show it.
  const browserOpened = openBrowser ? await launchBrowser(authUrl) : false;

  pending = { authUrl, browserOpened, completion, server };
  completion.finally(() => {
    if (pending?.completion === completion) pending = null;
  });

  return { authUrl, browserOpened, resumed: false };
}

/** Abandon a sign-in in progress, so a stale listener cannot complete later. */
export function cancelSignIn() {
  if (!pending) return false;
  pending.server.close();
  pending = null;
  return true;
}

function awaitCallback(server, { state, verifier, redirectUri }) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('sign-in timed out'));
    }, 5 * 60 * 1000);
    // UNREF'd, both of them. A pending sign-in must not be the reason a process
    // refuses to exit: somebody who abandons the browser tab should still be
    // able to close their editor, and a host that stops the server should not
    // wait five minutes for a listener nobody is going to use.
    timer.unref();
    server.unref();

    server.on('request', async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }

      const finish = (status, title, body) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page(title, body));
        clearTimeout(timer);
        server.close();
      };

      if (url.searchParams.get('state') !== state) {
        finish(400, 'Sign-in failed', 'The response did not match this request. Please try again.');
        reject(new Error('state mismatch'));
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        const detail = url.searchParams.get('error_description') || url.searchParams.get('error') || 'no code returned';
        finish(400, 'Sign-in failed', escapeHtml(detail));
        reject(new Error(detail));
        return;
      }

      try {
        const tokens = await exchange({ code, verifier, redirectUri });
        // The page is written AFTER the exchange, on purpose. Written before,
        // it can name nobody — and it would cheerfully say "signed in" after an
        // exchange that failed. This matters most in the case that looks like
        // nothing happened: with an existing Keycloak session there is no login
        // and no consent screen, the tab just flashes, and without a page that
        // names the account somebody closes it believing it did not work.
        finish(200, 'Signed in to ezQuill', `You are signed in as <strong>${escapeHtml(tokens.email ?? 'your account')}</strong>. You can close this tab and return to your assistant.`);
        resolve(tokens);
      } catch (err) {
        finish(400, 'Sign-in failed', escapeHtml(String(err.message ?? err)));
        reject(err);
      }
    });
  });
}

export async function exchange({ code, verifier, redirectUri }) {
  const { token } = await endpoints();
  const response = await fetch(token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!response.ok) {
    throw new Error(`token exchange failed (${response.status})`);
  }
  return shapeTokens(await response.json());
}

export async function refresh(refreshToken) {
  const { token } = await endpoints();
  const response = await fetch(token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) {
    const error = new Error(`refresh failed (${response.status})`);
    // A 400 means the grant is dead — revoked, expired, or already rotated
    // away. Anything else may be transient, so the caller keeps the tokens and
    // retries rather than signing somebody out over a blip.
    error.grantDead = response.status === 400;
    throw error;
  }
  return shapeTokens(await response.json());
}

function shapeTokens(body) {
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    // A margin, so a token is renewed slightly early rather than on the first
    // request that discovers it expired mid-flight.
    expiresAt: Date.now() + Math.max(0, (body.expires_in ?? 300) - 30) * 1000,
    email: emailFromToken(body.access_token),
  };
}

/**
 * Read the email out of the access token WITHOUT verifying it.
 *
 * Safe because it is used for one thing: telling the person which account they
 * just signed in as. Nothing is authorised on it — the API verifies the token
 * itself, which is the only place that judgement belongs.
 */
export function emailFromToken(token) {
  try {
    const payload = token.split('.')[1];
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    return JSON.parse(json).email;
  } catch {
    return undefined;
  }
}

/** execFile, never exec: no shell, so an authorize url cannot be read as shell syntax. */
function launchBrowser(url) {
  // Opt out entirely. Wanted on a headless box, over SSH, in CI and in tests —
  // anywhere a window appearing is a surprise rather than a convenience. The
  // url is still returned, which is the actual contract.
  if (process.env.EZQUILL_NO_BROWSER) return Promise.resolve(false);

  const [command, args] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];

  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: 5000 }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const page = (title, body) => `<!doctype html><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:14vh auto;padding:0 1.5rem;color:#2b2a27}
h1{font:600 1.4rem/1.3 Georgia,serif;margin:0 0 .5rem}p{margin:0;color:#57534e}</style>
<h1>${escapeHtml(title)}</h1><p>${body}</p>`;
