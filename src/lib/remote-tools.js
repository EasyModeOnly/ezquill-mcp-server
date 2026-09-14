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
 *
 * A tool must appear in exactly ONE of the two lists below, and a test fails if
 * any tool appears in neither — so adding one forces the decision to be made
 * rather than defaulted.
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
  // Writes. Remote-safe for the same reason the reads are: every one is a call
  // to the ezQuill API, constrained by the consent scopes on the caller's own
  // token. Nothing here touches this machine.
  'manage_outline',
  'write_draft',
  'manage_entity',
  'manage_cast',
  'manage_timeline',
  'manage_feedback',
]);

export const isRemoteSafe = (name) => REMOTE_SAFE.has(name);

/**
 * Tools served ONLY on the local surface, each with the reason it is excluded.
 *
 * Both of these bind a loopback port and shell out to a browser, neither of
 * which means anything inside a container. And over a remote connector the
 * CLIENT runs its own OAuth against this service, so a second sign-in offered
 * inside the tool surface is inert — it would sign the SERVER in as somebody,
 * which is not what the caller is asking for and would be a confusing thing to
 * let them do.
 */
export const LOCAL_ONLY = new Set(['authenticate', 'sign_out']);

export const isLocalOnly = (name) => LOCAL_ONLY.has(name);
