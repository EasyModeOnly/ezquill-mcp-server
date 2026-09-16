/**
 * Which build this is — the two facts, in one place.
 *
 * They live here rather than in create-server.js because three things need
 * them and one of those is instructions.js, which create-server.js imports.
 * Reading the version back out of create-server.js would be an import cycle
 * for a string constant.
 */
import { readFileSync } from 'node:fs';

/**
 * Read from package.json rather than typed here.
 *
 * It was a literal, and it had already drifted by the first release: 0.1.1
 * published from this repo and introduced itself over MCP as 0.1.0. Nothing
 * catches that — the package is correct, the tarball is correct, the server
 * runs, and the only symptom is that `serverInfo.version` lies to whoever is
 * trying to work out which build they are talking to. Which is exactly when
 * somebody reads it.
 *
 * package.json is always in the tarball regardless of `files`, so this
 * resolves for an installed copy as well as from a checkout.
 */
export const SERVER_VERSION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
).version;

/**
 * The commit the running container was deployed from, or null.
 *
 * NULL, never a placeholder string: a local `node src/http.js` and an npx
 * install have no sha, and the one thing worse than not knowing which commit
 * is running is a field that looks like it answered. The deploy check compares
 * this against the sha it just deployed, so anything unequal — including null —
 * is correctly a failure.
 *
 * It arrives as an env var set by the DEPLOY rather than baked in at build
 * time, because deploy.yml pushes one image per sha and also moves `:latest`;
 * the question this answers is "what is running here now", which only the
 * deploy knows.
 */
export const BUILD_SHA = process.env.EZQUILL_BUILD_SHA || null;
