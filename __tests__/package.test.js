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
