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
import { hasExplicitCredential } from './credentials.js';
import { startSignIn } from './oauth.js';
import { SERVER_VERSION } from './version.js';

export const SERVER_NAME = 'ezquill-mcp-server';

// Re-exported because this is where callers have always read it from, and it
// is what `serverInfo.version` reports. It now LIVES in version.js — see the
// comment there for why.
export { SERVER_VERSION };

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
      if (surface === 'local' && needsSignIn(err)) {
        const prompt = await signInPrompt(err);
        if (prompt) return prompt;
      }
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

/**
 * Whether a failure means "sign in", funnelled at the SINGLE dispatch point so
 * no tool can be missed and none can drift.
 *
 * 401 is included because a credential that WAS valid can stop being one, and
 * that is indistinguishable from never having had one from the caller's side.
 *
 * 403 is DELIBERATELY EXCLUDED. It means signed in but not permitted — a scope
 * that was never granted, or a project this person cannot reach. Sending
 * somebody back through a sign-in that cannot fix it is worse than saying
 * nothing, because it hides the real reason behind a familiar-looking prompt.
 */
function needsSignIn(err) {
  return err instanceof ToolError && err.code === Code.NOT_AUTHENTICATED;
}

/**
 * Start the sign-in and hand the url back as a RESULT.
 *
 * Two things here are load-bearing and were both wrong in ezmodo's first
 * version:
 *
 *   - it starts the flow ITSELF rather than telling the agent to call another
 *     tool. Two hops means the person waits through an exchange that says
 *     nothing to them.
 *   - it returns a PLAIN result, not an error. A client that treats isError as
 *     a failure would otherwise swallow the link, which defeats the whole
 *     point: the tool result is the only channel that reaches a person, since
 *     stdout is the protocol and stderr is a log nobody opens.
 */
async function signInPrompt(err) {
  // An explicit credential outranks a cached sign-in, so a browser flow could
  // not take effect. Report the real problem instead of offering an errand
  // that cannot work.
  if (hasExplicitCredential()) return null;

  try {
    const { authUrl, browserOpened } = await startSignIn();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              status: 'sign_in_required',
              message:
                'Not signed in to ezQuill. Ask the person to open this link, then try again.',
              authUrl,
              browserOpened,
              originalError: err.code,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch {
    // If the sign-in cannot even be started — no network, discovery down — the
    // ordinary error is more honest than a link that goes nowhere.
    return null;
  }
}
