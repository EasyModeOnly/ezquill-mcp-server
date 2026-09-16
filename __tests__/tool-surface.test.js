/**
 * The tool surface cannot change without a release that tells machines to look.
 *
 * # The failure this exists for
 *
 * 0.3.0 added three actions to the outline tools. The plugin manifest stayed at
 * 0.2.1, so `/plugin marketplace update` had nothing to show and no installed
 * machine had any reason to reconnect — the new actions reached whoever
 * happened to reconnect for unrelated reasons, and Claude Code went on offering
 * the old tool definitions on two machines for a day. Nothing was red. Nothing
 * could be: the server was correct, the package was correct, and the only thing
 * wrong was a number in a file that describes none of it.
 *
 * Remembering to bump it is a thing to remember, and the release that forgets
 * is the release that changed something worth knowing about.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TOOLS } from '../src/tools/index.js';
import { toolSurface } from '../src/lib/tool-surface.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const stored = JSON.parse(readFileSync(new URL('./tool-surface.json', import.meta.url), 'utf8'));

describe('the recorded tool surface', () => {
  test('matches what the server actually serves', () => {
    // Derived by the SAME function the generator uses, so the file can never
    // record a surface computed a different way from the one checked.
    const current = toolSurface(TOOLS);

    const before = Object.keys(stored.tools);
    const after = Object.keys(current);
    const added = after.filter((n) => !before.includes(n));
    const removed = before.filter((n) => !after.includes(n));

    assert.deepEqual(
      current,
      stored.tools,
      'The tool surface changed.\n\n' +
        (added.length ? `  added:   ${added.join(', ')}\n` : '') +
        (removed.length ? `  removed: ${removed.join(', ')}\n` : '') +
        '\nIf that is deliberate, it is a release: every machine with the plugin\n' +
        'installed keeps advertising the recorded surface until the plugin\n' +
        'version moves. Bump, then record it:\n\n' +
        '  npm version minor && npm run fingerprint\n\n' +
        'The fingerprint covers tool names, action enums and top-level parameter\n' +
        'names only — a reworded description will not bring you here.'
    );
  });

  test('was recorded at the version being shipped', () => {
    // The generator refuses to record a CHANGED surface at an unchanged
    // version, which is what ties the two together. This asserts the other
    // half: the file was not hand-edited to a version that never shipped it.
    assert.equal(
      stored.version,
      pkg.version,
      `tool-surface.json says ${stored.version}, package.json says ${pkg.version} — run npm run fingerprint`
    );
  });
});
