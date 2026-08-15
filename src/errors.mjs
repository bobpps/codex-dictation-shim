/**
 * Every failure the shim can produce, carried as one error type.
 *
 * The status code is part of the failure, not a detail the HTTP layer invents
 * later, because which code we return changes what Handy does next. From
 * `src-tauri/src/llm_client.rs`:
 *
 *   - 400 and 422 make Handy retry the same request once with the
 *     reasoning-disable fields stripped, on the assumption that those fields
 *     were what the endpoint rejected. The shim ignores those fields entirely,
 *     so that retry can only ever fail the same way — it is pure noise, one
 *     more pass over the same guards and one more line in the log.
 *   - Any non-success status makes Handy abandon structured output and call the
 *     shim a second time in legacy mode, without `response_format`.
 *
 * So shim-side failures deliberately avoid 400/422. 400 is reserved for a body
 * that is not JSON at all, which is a case Handy cannot produce and which
 * therefore means someone is calling this endpoint by hand.
 */
export class ShimError extends Error {
  /**
   * @param {string} message  What went wrong, in a form worth reading in a log.
   * @param {object} options
   * @param {number} options.status  HTTP status to answer Handy with.
   * @param {string} options.code    Stable machine-readable label.
   * @param {string} [options.hint]  What the operator should do about it.
   * @param {unknown} [options.cause]
   */
  constructor(message, { status, code, hint, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ShimError';
    this.status = status ?? 500;
    this.code = code ?? 'shim_error';
    this.hint = hint ?? null;
  }

  /** The log line and the HTTP body should say the same thing. */
  get detail() {
    return this.hint ? `${this.message} ${this.hint}` : this.message;
  }
}

/** Credentials are missing, malformed, or expired. */
export const authError = (message, hint) =>
  new ShimError(message, { status: 503, code: 'codex_auth', hint });

/** Handy's `recordings/` directory could not be located or read. */
export const recordingsDirError = (message, hint) =>
  new ShimError(message, { status: 503, code: 'recordings_dir', hint });

/** A guard refused the candidate WAV. This is the shim working, not failing. */
export const guardError = (message, hint) =>
  new ShimError(message, { status: 409, code: 'recording_guard', hint });

/** The claimed WAV could not be read off disk. */
export const recordingReadError = (message, hint) =>
  new ShimError(message, { status: 503, code: 'recording_read', hint });

/** The Codex endpoint answered, and the answer was unusable. */
export const upstreamError = (message, hint) =>
  new ShimError(message, { status: 502, code: 'codex_upstream', hint });

/** The Codex endpoint did not answer in time. */
export const upstreamTimeoutError = (message, hint) =>
  new ShimError(message, { status: 504, code: 'codex_timeout', hint });
