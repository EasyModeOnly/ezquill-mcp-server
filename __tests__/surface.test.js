import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS } from '../src/tools/index.js';
import { REMOTE_SAFE, isRemoteSafe } from '../src/lib/remote-tools.js';
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

  test('this release is read-only, and says so in every annotation', () => {
    // Writes are task #274. A tool that mutates must not inherit readOnlyHint
    // from a neighbour, because a client uses it to decide whether to ask.
    for (const tool of TOOLS) {
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name}`);
    }
  });

  test('the allowlist drifts in BOTH directions', () => {
    // An unlisted tool would be silently absent from the remote surface; a
    // listed tool that no longer exists lets the list rot into a description of
    // code that is gone.
    for (const tool of TOOLS) {
      assert.ok(isRemoteSafe(tool.name), `${tool.name} is missing from REMOTE_SAFE`);
    }
    const names = new Set(TOOLS.map((t) => t.name));
    for (const listed of REMOTE_SAFE) {
      assert.ok(names.has(listed), `REMOTE_SAFE names ${listed}, which no longer exists`);
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
