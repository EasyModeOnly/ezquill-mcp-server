#!/usr/bin/env node
/**
 * Put the package version into the two plugin manifests.
 *
 * Wired to npm's `version` LIFECYCLE hook, which runs after package.json is
 * bumped and before the version commit is made — so `npm version minor`
 * rewrites all three files and commits them together. Anything this script
 * `git add`s lands in that commit; that is the documented contract, and it is
 * the whole reason this is a hook rather than something to remember.
 *
 * The plugin's version is not a statement about the plugin's own contents: the
 * manifest is a pointer at a URL and hardly ever changes. It is the signal an
 * INSTALLED machine reads to decide it should reconnect. 0.3.0 added three
 * actions with the manifests left at 0.2.1, so no machine had any reason to
 * look, and the new tools reached whoever happened to reconnect for unrelated
 * reasons.
 *
 * A test pins the three together, so forgetting this script is caught rather
 * than shipped. Running it by hand is fine: `npm run sync-plugin-version`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));

// Two spaces and a trailing newline, matching what npm itself writes and what
// is already in these files — so a bump is a one-line diff rather than a
// reformat that hides it.
const write = (path, value) =>
  writeFileSync(new URL(path, root), `${JSON.stringify(value, null, 2)}\n`);

const { version } = read('package.json');

const pluginPath = 'plugin/.claude-plugin/plugin.json';
const marketplacePath = '.claude-plugin/marketplace.json';

const plugin = read(pluginPath);
const marketplace = read(marketplacePath);

const changed = [];

if (plugin.version !== version) {
  changed.push(`${pluginPath}: ${plugin.version} → ${version}`);
  plugin.version = version;
  write(pluginPath, plugin);
}

// By NAME, not by index. The marketplace lists plugins and this repo happens to
// ship one; addressing it positionally would silently version the wrong entry
// the day it ships two.
const entry = marketplace.plugins?.find((p) => p.name === plugin.name);
if (!entry) {
  console.error(`No marketplace entry named "${plugin.name}" in ${marketplacePath}`);
  process.exit(1);
}

if (entry.version !== version) {
  changed.push(`${marketplacePath}: ${entry.version} → ${version}`);
  entry.version = version;
  write(marketplacePath, marketplace);
}

if (changed.length === 0) {
  console.log(`plugin manifests already at ${version}`);
  process.exit(0);
}

for (const line of changed) console.log(line);

// STAGED, because under `npm version` this script runs between the bump and
// the commit, and npm commits what is in the index. A file written and not
// added is a file left dirty in the working tree while the release commit
// claims to have bumped it — the exact drift this exists to stop, one step
// later.
//
// Not fatal outside a repository: `npm run sync-plugin-version` in a tarball or
// a copied directory should still do its job.
try {
  execFileSync('git', ['add', pluginPath, marketplacePath], {
    cwd: new URL('.', root).pathname,
    stdio: 'ignore',
  });
} catch {
  console.log('(not staged — no git repository here)');
}
