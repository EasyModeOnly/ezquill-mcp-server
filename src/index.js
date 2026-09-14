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
import { setDefaultRequest } from './lib/request-context.js';
import { baseUrl } from './lib/api.js';

async function main() {
  const token = process.env.EZQUILL_TOKEN ?? '';

  // Say WHICH credential is in use, on stderr, at startup. A server that
  // silently authenticates as whoever happens to be configured, with no way to
  // tell, is worse than one that fails.
  process.stderr.write(
    `[ezquill-mcp] api=${baseUrl()} credential=${token ? 'EZQUILL_TOKEN' : 'none'}\n`
  );
  if (!token) {
    // Not fatal: the tools answer NOT_AUTHENTICATED as a tool result, which is
    // the only channel that reaches the person. Dying here would surface to the
    // client as an opaque CONNECTION_CLOSED instead.
    process.stderr.write(
      '[ezquill-mcp] no credential set — tools will report NOT_AUTHENTICATED until one is.\n'
    );
  }

  const server = createServer({ surface: 'local' });
  const transport = new StdioServerTransport();

  // A process-wide credential rather than a request store, because the store
  // would not survive: the transport reads stdin through an event listener,
  // and AsyncLocalStorage does not cross an EventEmitter. On stdio there is
  // exactly one caller, so the process credential IS the request credential.
  // See setDefaultRequest.
  setDefaultRequest({ token });
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[ezquill-mcp] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
