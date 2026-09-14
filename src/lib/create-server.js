/**
 * The server both transports share.
 *
 * Two entry points that each registered their own handlers would be two tool
 * surfaces, and they would diverge the first time one was changed — which is
 * exactly the failure the allowlist below exists to prevent, so building it
 * twice would be self-defeating.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { TOOLS } from '../tools/index.js';
import { getInstructions } from './instructions.js';
import { isRemoteSafe } from './remote-tools.js';
import { ToolError, Code } from './errors.js';

export const SERVER_NAME = 'ezquill-mcp-server';
export const SERVER_VERSION = '0.1.0';

/**
 * @param {{surface?: 'local'|'remote'}} [options]
 */
export function createServer({ surface = 'local' } = {}) {
  // FILTERED ONCE, and the advertised list and the dispatch set are derived
  // from the SAME value. Filtering only tools/list would leave every excluded
  // handler callable by a client that simply guesses the name — which is not a
  // theoretical client, it is any model that has seen the local surface.
  const tools = surface === 'remote' ? TOOLS.filter((t) => isRemoteSafe(t.name)) : TOOLS;
  const byName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: getInstructions(surface),
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema, annotations }) => ({
      name,
      description,
      inputSchema,
      annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      // Same answer whether the tool does not exist or is not served on this
      // surface. Saying "that exists but not here" tells a caller what to go
      // looking for.
      return errorResult(
        new ToolError(Code.REQUEST_FAILED, `Unknown tool: ${request.params.name}`)
      );
    }

    try {
      const result = await tool.handler(request.params.arguments ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResult(err);
    }
  });

  return server;
}

/**
 * A failed call comes back as a RESULT carrying a code, not as a protocol
 * error.
 *
 * `isError` is set so a client can style it, but the code travels in the body
 * either way — some clients surface a protocol error to the user as a bare
 * failure and never show the model the reason, and the reason is the part the
 * model needs in order to do something else.
 */
function errorResult(err) {
  const payload =
    err instanceof ToolError
      ? err.toResult()
      : { error: Code.REQUEST_FAILED, message: String(err?.message ?? err) };

  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}
