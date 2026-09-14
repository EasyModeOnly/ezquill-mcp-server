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

  test('every manuscript tool is annotated read-only', () => {
    // Writes are task #274, so nothing here may claim otherwise. A tool that
    // mutates must not inherit readOnlyHint from a neighbour, because a client
    // uses it to decide whether to ask the person first. The sign-in tools are
    // exempt: they change state on this machine, and say so.
    for (const tool of TOOLS) {
      if (LOCAL_ONLY.has(tool.name)) {
        assert.notEqual(tool.annotations?.readOnlyHint, true,
          `${tool.name} changes local state and must not claim to be read-only`);
        continue;
      }
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name}`);
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
});
