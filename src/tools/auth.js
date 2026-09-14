/**
 * Signing in and out.
 *
 * LOCAL ONLY — neither tool appears on the remote surface. Over a connector the
 * client runs its own OAuth against this service, so a second sign-in offered
 * inside it is inert and confusing; and these bind a loopback port and open a
 * browser, neither of which means anything in a container.
 */
import {
  DEFAULT_SCOPES,
  cancelSignIn,
  pendingSignIn,
  startSignIn,
} from '../lib/oauth.js';
import { forgetTokens, hasExplicitCredential, resolveCredential } from '../lib/credentials.js';
import { emailFromToken } from '../lib/oauth.js';

export const tools = [
  {
    name: 'authenticate',
    description:
      'Sign in to ezQuill. Returns a link for the person to open. Call this only if a ' +
      'tool reports NOT_AUTHENTICATED and no link was already given.',
    inputSchema: {
      type: 'object',
      properties: {
        includeDelete: {
          type: 'boolean',
          description:
            'Also request permission to delete. Off by default — ask the person first.',
        },
      },
    },
    annotations: { readOnlyHint: false, openWorldHint: true },

    async handler({ includeDelete }) {
      if (hasExplicitCredential()) {
        return {
          status: 'not_applicable',
          message:
            'EZQUILL_TOKEN is set, so this server always uses that credential and ' +
            'signing in through the browser would have no effect. Unset it to sign in here.',
        };
      }

      const { token, source } = await resolveCredential();
      if (token && source === 'oauth') {
        return { status: 'already_signed_in', account: emailFromToken(token) };
      }

      const scopes = includeDelete ? [...DEFAULT_SCOPES, 'ezquill:delete'] : DEFAULT_SCOPES;
      const { authUrl, browserOpened, resumed } = await startSignIn({ scopes });

      return {
        status: 'sign_in_required',
        authUrl,
        browserOpened,
        resumed,
        message: browserOpened
          ? 'A browser window should have opened. If not, open this link to sign in to ezQuill.'
          : 'Open this link to sign in to ezQuill.',
      };
    },
  },

  {
    name: 'sign_out',
    description: 'Forget the stored ezQuill sign-in on this machine.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false },

    async handler() {
      // Cancel first: a live loopback listener would otherwise complete the
      // very sign-in the person just abandoned, and write its tokens back.
      const cancelled = cancelSignIn();
      await forgetTokens();
      return {
        status: 'signed_out',
        cancelledPendingSignIn: cancelled,
        note: hasExplicitCredential()
          ? 'EZQUILL_TOKEN is still set, so this server remains authenticated by it.'
          : undefined,
      };
    },
  },
];

export const pending = pendingSignIn;
