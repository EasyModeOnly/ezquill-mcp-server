#!/usr/bin/env node
/**
 * The remote entry point — MCP over Streamable HTTP, which is what "Add custom
 * connector" requires and the only transport that reaches claude.ai, iOS and
 * Android.
 *
 * # Stateless, and that is forced rather than chosen
 *
 * `sessionIdGenerator: undefined` and a fresh Server + transport per request.
 * This runs on Cloud Run with no session affinity, so a client's second request
 * routinely lands on an instance that never saw its session and would get a
 * 404; scale-to-zero drops every session anyway. Holding sessions in memory
 * would work perfectly on one instance and fail in production under exactly the
 * conditions that make production worth having.
 *
 * The consequence is accepted: GET (the SSE stream for server-initiated
 * messages) answers 405 with a reason. If that ever has to change, the fix is
 * an external event store, not in-memory sessions.
 *
 * # The credential belongs to the request
 *
 * Many people share this process, so the caller's own bearer token is put on
 * the request context and read in exactly one place. Nothing downstream knows
 * whether it came from here or from the local transport.
 */
import { createServer as createHttpServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createServer } from './lib/create-server.js';
import { withRequest } from './lib/request-context.js';

const PORT = Number(process.env.PORT || 8080);
const MCP_PATH = process.env.MCP_PATH || '/mcp';
const MAX_BODY_BYTES = 4 << 20;
const ISSUER = (process.env.EZQUILL_ISSUER || 'https://auth.ezquill.com/realms/ezquill').replace(/\/+$/, '');

/** RFC 6750: `Authorization: Bearer <token>`, scheme compared case-insensitively. */
function bearerToken(req) {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') return '';
  return token.trim();
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

const http = createHttpServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // Liveness only. It deliberately does NOT call the ezQuill API: a health
  // check that proxies turns somebody else's outage into this service being
  // marked unhealthy, and it makes a 404 from an ingress rule indistinguishable
  // from a missing route.
  if (url.pathname === '/health') return send(res, 200, { status: 'ok' });

  // RFC 9728 protected-resource metadata: how a client discovers WHICH
  // authorization server guards this resource, before it has any token.
  //
  // The path is the domain root plus the resource path — NOT the resource path
  // plus a suffix. `/mcp` publishes at `/.well-known/oauth-protected-resource/mcp`.
  //
  // ezmodo's hard-won lesson here was that a load balancer needs a SECOND
  // url-map rule for this, and that it is the one everybody forgets. It does
  // not apply to ezQuill: the services are exposed by Cloud Run DOMAIN
  // MAPPINGS rather than through a shared GCLB, so this path is on the same
  // host as /mcp and reaches the same container with no routing rule at all.
  // Worth saying out loud, because somebody arriving with that lesson will go
  // looking for a url-map that does not exist.
  //
  // Unauthenticated on purpose: a client reads it precisely because it has no
  // credential yet.
  if (url.pathname === metadataPath()) {
    return send(res, 200, protectedResourceMetadata(req));
  }

  if (url.pathname !== MCP_PATH) return send(res, 404, { error: 'not found' });

  if (req.method === 'GET' || req.method === 'DELETE') {
    return send(res, 405, {
      error: 'method not allowed',
      message:
        'This connector is stateless: it runs on autoscaled instances with no ' +
        'session affinity, so server-initiated streams and session teardown are ' +
        'not supported. POST a JSON-RPC request instead.',
    });
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

  // 401 BEFORE doing any work, and with WWW-Authenticate so a client can find
  // the authorization server. This is the response that starts the OAuth dance.
  const token = bearerToken(req);
  if (!token) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl(req)}"`,
    });
    return res.end(JSON.stringify({ error: 'unauthorized' }));
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return send(res, 400, { error: 'bad request', message: String(err.message ?? err) });
  }

  // A fresh server and transport per request. They are cheap — tool
  // registration is a Map build — and it is what makes statelessness real
  // rather than nominal.
  const server = createServer({ surface: 'remote' });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await withRequest({ token }, () => transport.handleRequest(req, res, body));
  } catch (err) {
    process.stderr.write(`[ezquill-mcp-http] ${err?.stack ?? err}\n`);
    if (!res.headersSent) send(res, 500, { error: 'internal error' });
  }
});

const metadataPath = () => `/.well-known/oauth-protected-resource${MCP_PATH}`;

/**
 * What a client needs in order to go and get a token.
 *
 * `scopes_supported` lists what this resource UNDERSTANDS, which is not the
 * same as what any given token was granted — a client asks for a subset and a
 * person consents to a subset of that. Advertising delete here is correct and
 * is not the same as requesting it.
 */
function protectedResourceMetadata(req) {
  const host = req.headers.host ?? `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] ?? 'https';

  return {
    resource: `${proto}://${host}${MCP_PATH}`,
    authorization_servers: [ISSUER],
    scopes_supported: ['ezquill:read', 'ezquill:write', 'ezquill:delete'],
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://github.com/EasyModeOnly/ezquill-mcp-server',
  };
}

function resourceMetadataUrl(req) {
  const host = req.headers.host ?? `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] ?? 'https';
  // Built from the same metadataPath() the route uses, so the challenge cannot
  // point somewhere this server does not answer.
  return `${proto}://${host}${metadataPath()}`;
}

http.listen(PORT, () => {
  // The BOUND port, not the configured one. PORT=0 asks the OS to choose,
  // which is what lets a test run without claiming a fixed port on a machine
  // that may already be using it.
  const bound = http.address()?.port ?? PORT;
  process.stderr.write(`[ezquill-mcp-http] listening on :${bound}${MCP_PATH}\n`);
});

// npm forwards no signals, so this process is started with `node`, not
// `npm start` — otherwise SIGTERM never arrives and every scale-down kills
// in-flight calls.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => http.close(() => process.exit(0)));
}
