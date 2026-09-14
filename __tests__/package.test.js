/**
 * Facts about package.json that are load-bearing at INSTALL time.
 *
 * Nothing here is exercised by running the server, which is exactly why it
 * needs a test: every one of these fails after publication, on somebody else's
 * machine, in a form that does not name the cause.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const plugin = JSON.parse(
  readFileSync(new URL('../plugin/.claude-plugin/plugin.json', import.meta.url), 'utf8')
);
const marketplace = JSON.parse(
  readFileSync(new URL('../.claude-plugin/marketplace.json', import.meta.url), 'utf8')
);

describe('package.json', () => {
  test('exactly one bin is named after the UNSCOPED package name', () => {
    // npx resolves a multi-bin package only when one bin matches the unscoped
    // name. ezmodo shipped three bins, none matching, and `npx @ezmodo/mcp-server`
    // exited 1 with "could not determine executable to run" — which Claude Code
    // surfaces as CONNECTION_CLOSED and nothing else. It broke every plugin
    // install until somebody went looking.
    //
    // Asserted against the name rather than hard-coded, so renaming the package
    // fails here instead of at somebody's first npx.
    const unscoped = pkg.name.replace(/^@[^/]+\//, '');
    assert.ok(
      pkg.bin?.[unscoped],
      `package.json needs a bin named "${unscoped}" for npx to resolve ${pkg.name}`
    );
  });

  test('every bin points at a file that ships', () => {
    // `files` is an allowlist. A bin outside it publishes a package whose
    // entry point is a path that does not exist in the tarball.
    for (const [name, target] of Object.entries(pkg.bin ?? {})) {
      const top = target.replace(/^\.\//, '').split('/')[0];
      assert.ok(
        pkg.files.includes(top),
        `bin "${name}" points at ${target}, which "files" does not include`
      );
    }
  });

  test('it is publishable, and says so consistently', () => {
    // A scoped package defaults to RESTRICTED, and a restricted publish on a
    // free org fails with a 402 that reads like a billing problem rather than
    // a missing flag.
    assert.equal(pkg.publishConfig?.access, 'public');
    assert.equal(pkg.private, false);

    // "UNLICENSED" on a package people are told to npx-install says nobody may
    // use it. npm unpublish is restricted after 72 hours, so the first publish
    // is close to the last word on this.
    assert.notEqual(pkg.license, 'UNLICENSED');
    assert.ok(pkg.files.includes('LICENSE'), 'the licence has to be in the tarball to be one');
  });
});

describe('the Claude Code plugin manifest', () => {
  test('the npx invocation pins the version this repo publishes', () => {
    // THE failure this test exists for. The plugin installs the connector from
    // the REGISTRY, pinned, so bumping package.json without bumping this arg
    // ships a plugin that silently keeps installing the old published version —
    // for ever, and with no error anywhere. Nothing else in the repo connects
    // these two numbers.
    const server = plugin.mcpServers?.ezquill;
    assert.ok(server, 'the plugin must declare the ezquill MCP server');

    const spec = server.args.find((a) => a.startsWith('@ezquill/mcp-server@'));
    assert.ok(spec, `no pinned package spec in ${JSON.stringify(server.args)}`);
    assert.equal(
      spec,
      `${pkg.name}@${pkg.version}`,
      'the plugin pins a different version from the one this repo publishes'
    );
  });

  test('it invokes the bin explicitly, not by package name alone', () => {
    // `npx -p <pkg> <bin>` rather than `npx <pkg>`: the long form keeps working
    // if a bin is ever renamed, and keeps working against versions already
    // published. See __tests__/package.test.js's bin test for what the short
    // form does when nothing matches.
    const { command, args } = plugin.mcpServers.ezquill;
    assert.equal(command, 'npx');
    assert.ok(args.includes('-p'), 'use the explicit `-p <package> <bin>` form');
    assert.equal(args.at(-1), pkg.name.replace(/^@[^/]+\//, ''));
  });

  test('the three versions do not drift', () => {
    assert.equal(plugin.version, pkg.version, 'plugin.json version');
    assert.equal(marketplace.plugins[0].version, pkg.version, 'marketplace entry version');
    assert.equal(marketplace.plugins[0].name, plugin.name, 'marketplace entry name');
  });
});
