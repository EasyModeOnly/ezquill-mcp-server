#!/usr/bin/env node
/**
 * The stdio entry point — what an editor or desktop client launches.
 *
 * # Nothing may be written to stdout
 *
 * stdout IS the protocol channel. A stray console.log corrupts the JSON-RPC
 * stream and the client reports a connection failure with no hint of the cause.
 * Diagnostics go to stderr, and anything a PERSON has to read goes back as a
 * tool result — stderr is a log nobody opens, which is how a perfectly clear
 * error message can be invisible in practice.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './lib/create-server.js';
import { baseUrl } from './lib/api.js';
import { resolveCredential } from './lib/credentials.js';

async function main() {
  // Say WHICH credential is in use, on stderr, at startup. A server that
  // silently authenticates as whoever happens to be configured, with no way to
  // tell, is worse than one that fails outright.
  const { source } = await resolveCredential().catch(() => ({ source: 'none' }));
  process.stderr.write(`[ezquill-mcp] api=${baseUrl()} credential=${source}\n`);

  if (source === 'none') {
    // Not fatal, deliberately. The tools answer NOT_AUTHENTICATED as a tool
    // RESULT — which starts a sign-in and hands back a link, the only channel
    // that reaches a person. Dying here would surface to the client as an
    // opaque CONNECTION_CLOSED, which is how ezmodo's clearest error message
    // became invisible.
    process.stderr.write(
      '[ezquill-mcp] not signed in — the first tool call will return a sign-in link.\n'
    );
  }

  const server = createServer({ surface: 'local' });
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`[ezquill-mcp] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
