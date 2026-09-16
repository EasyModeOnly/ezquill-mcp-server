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

  test('it names the repository, which PROVENANCE verifies', () => {
    // Not metadata politeness. Trusted publishing signs a provenance statement
    // naming the building repository, and the registry then refuses the upload
    // unless package.json agrees:
    //
    //   422 Unprocessable Entity — Error verifying sigstore provenance bundle:
    //   "repository.url" is "", expected to match
    //   "https://github.com/EasyModeOnly/ezquill-mcp-server" from provenance
    //
    // It fails AFTER signing and after the signature is written to the public
    // transparency log, so the failure looks like a registry problem rather
    // than a missing field in a file nothing else reads.
    assert.ok(pkg.repository?.url, 'package.json needs a repository.url');
    assert.match(
      pkg.repository.url,
      /github\.com\/EasyModeOnly\/ezquill-mcp-server/,
      'repository.url must name the repo that builds it, or provenance rejects the publish'
    );
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

describe('the server it introduces itself as', () => {
  test('serverInfo.version is the version that was published', async () => {
    // A literal here drifted on the very first release — 0.1.1 shipped and
    // announced 0.1.0. Nothing else catches it: the package is right, the
    // tarball is right, the server runs, and the only casualty is somebody
    // trying to work out which build they are talking to.
    const { SERVER_VERSION } = await import('../src/lib/create-server.js');
    assert.equal(SERVER_VERSION, pkg.version);
  });
});

describe('the Claude Code plugin manifest', () => {
  test('it points at the connector, and at PRODUCTION', () => {
    // The guard that replaced the version-pin tests. A plugin shipped
    // pointing at the dev connector would route every installer's manuscript
    // through the dev stack — a dev-shaped mistake with a production-shaped
    // consequence, and one nothing else here would catch: dev answers, the
    // tools work, and the writer is simply in the wrong place.
    const server = plugin.mcpServers?.ezquill;
    assert.ok(server, 'the plugin must declare the ezquill MCP server');
    assert.equal(server.type, 'http');
    assert.equal(server.url, 'https://mcp.ezquill.com/mcp');
  });

  test('it carries the pre-registered OAuth client id', () => {
    // Without this the plugin cannot authenticate AT ALL, and the error names
    // neither the plugin nor the cause:
    //
    //   Dynamic Client Registration rejected (HTTP 403): insufficient_scope
    //   Policy 'Trusted Hosts' rejected request to client-registration service
    //
    // A client with no client_id tries to register one dynamically, and the
    // ezquill realm refuses DCR on purpose — it holds customer identities, and
    // allowlisting Anthropic's egress range would admit registration from
    // anyone with a claude.ai account. The realm's design assumes the client id
    // is SUPPLIED; this is where a plugin supplies it.
    const { oauth } = plugin.mcpServers.ezquill;
    assert.equal(oauth?.clientId, 'ezquill-mcp');
  });

  test('it declares no local process', () => {
    // The point of the remote connector: no Node, no npx, no version pin, and
    // no working-directory trap. `command` reappearing means somebody has
    // reintroduced the stdio path here rather than in the README, where the
    // `claude mcp add` route lives.
    const server = plugin.mcpServers.ezquill;
    assert.equal(server.command, undefined);
    assert.equal(server.args, undefined);
  });

  test('the marketplace entry does not drift from the plugin', () => {
    assert.equal(marketplace.plugins[0].version, plugin.version, 'version');
    assert.equal(marketplace.plugins[0].name, plugin.name, 'name');
  });

  test('its version tracks the package, because that is the signal to reconnect', () => {
    // This test used to say the opposite — that the plugin's version was
    // deliberately untied from npm, since the plugin ships a URL rather than a
    // package, so the npm version had nothing to say about it.
    //
    // That reasoning was about the plugin's CONTENTS, and the version is not
    // for its contents. The manifest is a pointer at a URL and almost never
    // changes; its version number is the only thing that tells an already
    // installed machine to go and look again. Untied, it never moved: 0.3.0
    // added three actions with both manifests left at 0.2.1, so
    // `/plugin marketplace update` had nothing to show and the new tools
    // reached only whoever happened to reconnect.
    //
    // `npm version` now bumps all three together (the `version` lifecycle
    // script). This is the guard that a hand-edited release cannot skip it.
    assert.equal(
      plugin.version,
      pkg.version,
      `plugin.json is ${plugin.version}, package.json is ${pkg.version} — run npm run sync-plugin-version`
    );
  });
});
