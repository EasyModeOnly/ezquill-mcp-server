#!/usr/bin/env node
/**
 * Record the current tool surface as the one a released version serves.
 *
 * Run deliberately, after changing what the tools offer:
 *
 *   npm version minor          # the surface changed, so the plugin must move
 *   npm run fingerprint
 *
 * # It REFUSES to record a changed surface at an unchanged version
 *
 * That refusal is the whole mechanism. The test fails when the surface drifts
 * from this file; if regenerating were always allowed, the fix would be to
 * regenerate, and the bump — the part that actually reaches installed machines
 * — would be exactly as forgettable as it was before. So the only way to make
 * the test green again is to bump, which is what everyone with the plugin
 * installed is waiting for.
 *
 * `--force` exists for the one honest exception: the fingerprint file itself
 * being wrong (a bad merge, a bug in the derivation) with no surface change to
 * release.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

import { TOOLS } from '../src/tools/index.js';
import { toolSurface } from '../src/lib/tool-surface.js';

const root = new URL('../', import.meta.url);
const fingerprintUrl = new URL('__tests__/tool-surface.json', root);

const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const tools = toolSurface(TOOLS);

let stored = null;
try {
  stored = JSON.parse(readFileSync(fingerprintUrl, 'utf8'));
} catch {
  // No file yet. The first run records whatever is there, which is correct:
  // there is no previous surface to have changed from.
}

const force = process.argv.includes('--force');
const surfaceChanged = stored && JSON.stringify(stored.tools) !== JSON.stringify(tools);

if (surfaceChanged && stored.version === version && !force) {
  console.error(
    `The tool surface changed but package.json is still ${version}.\n\n` +
      'Every machine with the plugin installed keeps advertising the recorded\n' +
      'surface until the plugin version moves, and the plugin version follows\n' +
      'this one. Bump first:\n\n' +
      '  npm version minor && npm run fingerprint\n\n' +
      'Use --force only to correct the fingerprint file itself.'
  );
  process.exit(1);
}

writeFileSync(fingerprintUrl, `${JSON.stringify({ version, tools }, null, 2)}\n`);

// Staged for the same reason sync-plugin-version.mjs stages: under `npm
// version` this runs between the bump and the commit, and npm commits the
// index.
try {
  execFileSync('git', ['add', fingerprintUrl.pathname], { stdio: 'ignore' });
} catch {
  // Not a repository. Writing the file was the job; staging is a convenience.
}

const names = Object.keys(tools);
console.log(`recorded ${names.length} tools at ${version}`);
if (surfaceChanged) {
  const before = new Set(Object.keys(stored.tools));
  const added = names.filter((n) => !before.has(n));
  const removed = [...before].filter((n) => !(n in tools));
  if (added.length) console.log(`  added:   ${added.join(', ')}`);
  if (removed.length) console.log(`  removed: ${removed.join(', ')}`);
}
