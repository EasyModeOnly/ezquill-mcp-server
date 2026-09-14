/**
 * Which tools may be served over the REMOTE transport.
 *
 * # An allowlist, not a denylist, and that is the whole point
 *
 * Every tool in this server today is a call to the ezQuill REST API, so nothing
 * is unsafe to expose and this list is currently total. It exists anyway,
 * because the two shapes fail in opposite directions:
 *
 *   - a denylist means every tool added from now on is remotely exposed BY
 *     DEFAULT, and the mistake is invisible — nothing fails, a capability is
 *     simply reachable from the internet that nobody meant to publish.
 *   - an allowlist means a new tool is local-only until somebody adds it here,
 *     and the mistake is a missing tool, which gets reported.
 *
 * ezmodo learned this the expensive way: six of their tools operated on the
 * local machine, and one interpolated caller-supplied strings into a shell.
 * Over stdio the blast radius is the caller's own shell; over a remote
 * connector it was arbitrary command execution reachable by any authenticated
 * caller. Two of their tools also LOOKED local and were not, so judging by name
 * would have gutted the connector.
 *
 * The rule for adding one: trace the handler. If it only calls the ezQuill API,
 * it belongs here. If it touches the filesystem, a child process or the working
 * directory, it does not.
 */
export const REMOTE_SAFE = new Set([
  'list_projects',
  'get_project',
  'search_project',
  'get_outline',
  'read_scene',
  'list_entities',
  'get_entity',
  'get_timeline',
  'list_feedback',
]);

export const isRemoteSafe = (name) => REMOTE_SAFE.has(name);
