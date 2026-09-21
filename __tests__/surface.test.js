import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS } from '../src/tools/index.js';
import { LOCAL_ONLY, REMOTE_SAFE, isRemoteSafe } from '../src/lib/remote-tools.js';
import { INSTRUCTIONS } from '../src/lib/instructions.js';

describe('the tool surface', () => {
  test('every tool has a name, a description, a schema and a handler', () => {
    for (const tool of TOOLS) {
      assert.ok(tool.name, 'a tool has no name');
      assert.ok(tool.description?.length > 20, `${tool.name} needs a real description`);
      assert.equal(tool.inputSchema?.type, 'object', `${tool.name} schema`);
      assert.equal(typeof tool.handler, 'function', `${tool.name} handler`);
    }
  });

  test('tool names are unique', () => {
    const names = TOOLS.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
  });

  test('every tool declares readOnlyHint, truthfully', () => {
    // A client uses this to decide whether to ask the person first, so a tool
    // that mutates must never inherit `true` from a neighbour. Read tools are
    // named explicitly rather than inferred, so ADDING a write tool cannot
    // quietly land in the read list.
    const readOnly = new Set([
      'list_projects', 'get_project', 'search_project', 'get_outline', 'read_scene',
      'list_entities', 'get_entity', 'get_timeline', 'list_feedback',
      'lookup_word', 'list_word_favorites',
    ]);

    for (const tool of TOOLS) {
      assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean',
        `${tool.name} must declare readOnlyHint either way`);
      assert.equal(tool.annotations.readOnlyHint, readOnly.has(tool.name),
        `${tool.name} declares readOnlyHint=${tool.annotations.readOnlyHint}`);
    }
  });

  test('there is no tool that can accept a suggestion', () => {
    // The whole reason write_draft's `revise` is a real safeguard rather than a
    // gesture. A connector granted ezquill:write holds both Comment and Write,
    // so an agent able to propose would also be able to accept — and a
    // suggestion it can accept itself is a write with extra steps.
    for (const tool of TOOLS) {
      assert.ok(!/accept/i.test(tool.name), `${tool.name} looks like it can accept a proposal`);
      assert.ok(
        !/accept/i.test(JSON.stringify(tool.inputSchema?.properties?.action ?? {})),
        `${tool.name} offers an accept action`
      );
    }
  });

  test('every tool is classified, and the lists do not rot', () => {
    // Three directions. A tool in NEITHER list fails, so adding one forces the
    // decision instead of defaulting it — which is the whole reason the remote
    // surface is an allowlist. A tool in BOTH is a contradiction. And a listed
    // name with no tool lets a list decay into a description of code that is
    // gone.
    for (const tool of TOOLS) {
      const remote = isRemoteSafe(tool.name);
      const local = LOCAL_ONLY.has(tool.name);
      assert.ok(remote || local, `${tool.name} is in neither REMOTE_SAFE nor LOCAL_ONLY`);
      assert.ok(!(remote && local), `${tool.name} is in both lists`);
    }

    const names = new Set(TOOLS.map((t) => t.name));
    for (const listed of [...REMOTE_SAFE, ...LOCAL_ONLY]) {
      assert.ok(names.has(listed), `${listed} is listed but no longer exists`);
    }
  });

  test('the remote surface serves no sign-in tool', () => {
    // Over a connector the CLIENT owns the OAuth flow. A sign-in offered here
    // would sign the SERVER in as somebody, which is not what the caller asked
    // for.
    for (const name of LOCAL_ONLY) {
      assert.ok(!isRemoteSafe(name), `${name} must not be remote-safe`);
    }
  });
});

describe('instructions', () => {
  test('stays within its budget', () => {
    // Charged to every session on every client, unlike a skill, which is
    // fetched on demand and can afford hundreds of lines.
    assert.ok(Buffer.byteLength(INSTRUCTIONS, 'utf8') < 6000);
  });

  test('carries the facts an agent cannot infer from the schemas', () => {
    for (const fragment of ['read_scene', 'block', 'NO score', 'context']) {
      assert.ok(INSTRUCTIONS.includes(fragment), `instructions must mention ${fragment}`);
    }
  });

  test('names the running version, so a stale client is visible in-session', async () => {
    // A client caching an older tool list looks exactly like a server that
    // never had the tool. Asserted against package.json rather than a literal,
    // for the same reason SERVER_VERSION is read from it.
    const { SERVER_VERSION } = await import('../src/lib/version.js');
    assert.ok(
      INSTRUCTIONS.includes(SERVER_VERSION),
      `instructions must name the running version (${SERVER_VERSION})`
    );
  });
});
