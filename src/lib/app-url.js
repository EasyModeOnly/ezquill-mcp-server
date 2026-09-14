/**
 * Where the ezQuill WEB APP lives, as opposed to its API.
 *
 * Separate from `baseUrl()` in api.js because it is a different thing: that one
 * is where this server sends requests, this one is where a PERSON is sent. The
 * two are not derivable from each other — api.dev.ezquill.com and
 * dev.ezquill.com share no transformation with api.ezquill.com and ezquill.com
 * — so this is configured, not computed.
 *
 * It exists because of the case task #319 is about. A person can complete the
 * whole OAuth flow, including REGISTERING, from the connector's own sign-in
 * page: the realm allows registration and the login screen carries the link. So
 * "create a project in the app first" can be said to somebody who has never
 * seen the app and has no idea where it is. A URL costs one field; leaving it
 * out costs them a search.
 */
const DEFAULT_APP_URL = 'https://ezquill.com';

export function appBaseUrl() {
  return (process.env.EZQUILL_APP_BASE_URL || DEFAULT_APP_URL).replace(/\/+$/, '');
}

/**
 * The page that creates a project.
 *
 * Deep-linked rather than pointing at the dashboard, because the whole reason
 * this URL is being handed over is that there is nothing on the dashboard yet.
 */
export function createProjectUrl() {
  return `${appBaseUrl()}/new/project`;
}
