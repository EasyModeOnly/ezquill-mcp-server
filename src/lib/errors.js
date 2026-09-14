/**
 * Failures an agent has to be able to act on, named by CODE rather than prose.
 *
 * Every one of these reaches a language model, and the model has to decide what
 * to do next: sign in, pick a different project, stop asking. Matching on a
 * message string works until somebody improves the wording, and then it fails
 * INVISIBLY — the agent keeps running and quietly does the wrong thing. So the
 * code is the contract and the message is for the human reading the transcript.
 */

export const Code = {
  /** No usable credential. The client should sign in and retry. */
  NOT_AUTHENTICATED: 'NOT_AUTHENTICATED',
  /** Signed in, but this connection was not granted what the call needs. */
  FORBIDDEN_SCOPE: 'FORBIDDEN_SCOPE',
  /** Signed in and permitted, but the person has no projects yet. */
  NO_PROJECTS: 'NO_PROJECTS',
  /**
   * Semantic search is not configured in this deployment.
   *
   * Deliberately NOT an empty result list. An empty list is a claim about the
   * writer's own manuscript — that it contains nothing relevant — and reporting
   * a missing service as that claim is how an agent tells somebody their book
   * is empty.
   */
  SEARCH_UNAVAILABLE: 'SEARCH_UNAVAILABLE',
  /** The caller cannot see this, or it does not exist. Deliberately one code. */
  NOT_FOUND: 'NOT_FOUND',
  /** Somebody else changed the prose since it was read. */
  STALE_CONTENT: 'STALE_CONTENT',
  /** Anything the API refused that does not fit above. */
  REQUEST_FAILED: 'REQUEST_FAILED',
};

export class ToolError extends Error {
  /**
   * @param {string} code one of Code
   * @param {string} message for a person reading the transcript
   * @param {object} [detail] extra fields an agent may use
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.detail = detail;
  }

  /** The shape a tool result carries, so the code survives serialisation. */
  toResult() {
    return { error: this.code, message: this.message, ...this.detail };
  }
}

/**
 * Map an API status onto a code.
 *
 * 403 is deliberately distinguished from 401. A connection that was never
 * granted a scope cannot be fixed by signing in again, and sending somebody
 * through a sign-in that cannot help is worse than saying nothing.
 */
export function codeForStatus(status) {
  if (status === 401) return Code.NOT_AUTHENTICATED;
  if (status === 403) return Code.FORBIDDEN_SCOPE;
  if (status === 404) return Code.NOT_FOUND;
  if (status === 409) return Code.STALE_CONTENT;
  if (status === 503) return Code.SEARCH_UNAVAILABLE;
  return Code.REQUEST_FAILED;
}
