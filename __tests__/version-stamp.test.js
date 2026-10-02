/**
 * A stale schema has to be recognisable (ezquill #440).
 *
 * After a restart, Saltpig's agent had the three tools new in 0.9.0 and the
 * pre-0.6.0 schemas of manage_entity and manage_outline: a resumed conversation
 * keeps the schemas it loaded earlier, while the client refreshes only the list
 * of names. The server cannot push a change (stateless HTTP, no list_changed),
 * so every description carries the version it was served at, and the
 * instructions tell the agent what an older one means.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createServer } from '../src/lib/create-server.js';
import { getInstructions } from '../src/lib/instructions.js';
import { SERVER_VERSION } from '../src/lib/version.js';

test('every listed tool says which version served it', async () => {
  const server = createServer({ surface: 'remote' });
  const list = server._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
  const { tools } = await list({ method: 'tools/list', params: {} }, {});
  assert.ok(tools.length > 0);
  for (const t of tools) {
    assert.ok(t.description.endsWith(`[ezquill-mcp-server ${SERVER_VERSION}]`), `${t.name} is not stamped`);
  }
});

test('the instructions say what an older stamp means', () => {
  const text = getInstructions('remote');
  assert.match(text, new RegExp(`ezquill-mcp-server ${SERVER_VERSION.replace(/\./g, '\\.')}`));
  assert.match(text, /names an older one, it was loaded earlier in this conversation and is stale/);
});
