import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { authError } from './errors.mjs';
import { clip } from './log.mjs';

/**
 * Reading Codex credentials.
 *
 * `auth.json` is read on **every** request and never cached. Codex rewrites the
 * whole file when it refreshes the token, so a value cached at startup is a
 * value that goes stale without any event to notice — the exact shape of "it
 * quietly stopped working one Tuesday". The file is a few kilobytes on local
 * disk; re-reading it per dictation costs nothing worth saving.
 *
 * Only `tokens.access_token` and `tokens.account_id` are used. `refresh_token`
 * and `id_token` are deliberately never touched: refreshing would mean racing
 * Codex for ownership of this file, and the plan's answer to an expired token
 * is a clear error plus Handy's fallback, not a second refresh implementation.
 */

/** Shape written by `codex login` with a ChatGPT account (OAuth). */
const CHATGPT_AUTH_MODE = 'chatgpt';

/**
 * Printable ASCII: what may legally travel in an HTTP header value.
 *
 * A JWT is base64url and an account id is a UUID, so neither has any business
 * containing anything else. The check exists because of what happens when one
 * does: Node's `fetch` refuses the header with
 * `Headers.append: "Bearer <the whole token>" is an invalid header value.`
 * Caught here, a corrupted token is a clear instruction to log in again. Caught
 * at the request, it is a network error carrying the token into the log, the
 * HTTP response, and `/health` — and a token broken only by a stray newline is
 * still a working token to whoever reads it back out.
 */
const HEADER_SAFE = /^[\x20-\x7e]+$/;

export function authFilePath(codexHome) {
  return join(codexHome, 'auth.json');
}

/**
 * Decode a JWT payload without verifying the signature.
 *
 * Unverified is fine and is the only honest option here: the shim is not
 * authorising anything, it is reading an expiry so it can say "your token died
 * four days ago" instead of surfacing an opaque 401. The endpoint remains the
 * only thing that decides whether the token is good.
 */
export function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error(`expected 3 dot-separated segments, got ${parts.length}`);
  }
  const json = Buffer.from(parts[1], 'base64url').toString('utf8');

  let payload;
  try {
    payload = JSON.parse(json);
  } catch {
    // The parser's own message can quote the text it choked on, and that text
    // is decoded token material. This message reaches a warning that `/health`
    // publishes, so it says what failed and nothing about what was in it.
    throw new Error('payload segment is not JSON');
  }

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('payload is not a JSON object');
  }
  return payload;
}

/**
 * Read and validate the credentials.
 *
 * @param {object} options
 * @param {string} options.codexHome  Directory holding `auth.json`.
 * @param {() => number} [options.now]
 * @param {(path: string, encoding: string) => Promise<string>} [options.read]
 * @returns {Promise<{
 *   path: string, authMode: string, accessToken: string, accountId: string|null,
 *   expiresAtMs: number|null, expiresInSec: number|null, lastRefresh: string|null,
 *   warnings: string[],
 * }>}
 */
export async function readAuth({ codexHome, now = Date.now, read = readFile }) {
  const path = authFilePath(codexHome);
  const warnings = [];

  let raw;
  try {
    raw = await read(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw authError(
        `No Codex credentials at ${path}.`,
        'Run `codex login` on this machine, or point CODEX_HOME at the directory that has auth.json.',
      );
    }
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      throw authError(
        `Cannot read ${path}: permission denied.`,
        'The shim must run as the user that owns ~/.codex.',
      );
    }
    throw authError(`Cannot read ${path}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Deliberately without the parser's message. Node quotes the text around
    // the failure, and in this file that text is an access token or a refresh
    // token — which would then be in the log, in the HTTP response, and in
    // `/health`. The operator can look at the file directly; the log cannot.
    throw authError(
      `${path} is not valid JSON.`,
      `Run \`codex login\` to rewrite it, or inspect it yourself with \`jq . ${path}\`.`,
    );
  }

  // An API-key login writes a different file shape with no `tokens` object at
  // all. Saying so beats a TypeError on `undefined.access_token`, and it points
  // at the real problem: the transcribe endpoint authorises a ChatGPT account,
  // which an API key is not.
  const authMode = typeof parsed?.auth_mode === 'string' ? parsed.auth_mode : null;
  const tokens = parsed?.tokens;
  if (tokens === null || typeof tokens !== 'object') {
    const detail = authMode === null ? 'no auth_mode field' : `auth_mode is "${clip(authMode, 32)}"`;
    throw authError(
      `${path} has no "tokens" object (${detail}).`,
      'The transcribe endpoint needs a ChatGPT login. Run `codex login` without --with-api-key.',
    );
  }
  if (authMode !== null && authMode !== CHATGPT_AUTH_MODE) {
    throw authError(
      `${path} has auth_mode "${clip(authMode, 32)}", not "${CHATGPT_AUTH_MODE}".`,
      'The transcribe endpoint needs a ChatGPT login. Run `codex login` without --with-api-key.',
    );
  }

  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token.trim() : '';
  if (accessToken === '') {
    throw authError(
      `${path} has no tokens.access_token.`,
      'Run `codex login` to rewrite it.',
    );
  }

  if (!HEADER_SAFE.test(accessToken)) {
    throw authError(
      `${path} holds an access token with characters that cannot be sent in an HTTP header.`,
      'The file looks corrupted; run `codex login` to rewrite it. The token itself is deliberately not quoted here.',
    );
  }

  const accountId =
    typeof tokens.account_id === 'string' && tokens.account_id.trim() !== ''
      ? tokens.account_id.trim()
      : null;
  if (accountId !== null && !HEADER_SAFE.test(accountId)) {
    throw authError(
      `${path} holds an account id with characters that cannot be sent in an HTTP header.`,
      'The file looks corrupted; run `codex login` to rewrite it.',
    );
  }
  if (accountId === null) {
    // Not fatal: the header is only sent when the field exists, and the
    // endpoint may well authorise from the token alone. Worth a line, because
    // if the endpoint does not, this is the reason.
    warnings.push('tokens.account_id is missing; the ChatGPT-Account-Id header will not be sent');
  }

  let expiresAtMs = null;
  try {
    const payload = decodeJwtPayload(accessToken);
    if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
      expiresAtMs = payload.exp * 1000;
    } else {
      warnings.push('access token has no numeric "exp" claim; expiry cannot be checked locally');
    }
  } catch (error) {
    // The endpoint is still the authority on whether the token works, so an
    // unreadable token is a warning rather than a refusal. It does mean the
    // clear "your token expired" message is unavailable for this one.
    warnings.push(`access token is not a readable JWT (${error.message}); expiry cannot be checked`);
  }

  if (expiresAtMs !== null && expiresAtMs <= now()) {
    const daysAgo = ((now() - expiresAtMs) / 86_400_000).toFixed(1);
    throw authError(
      `Codex access token expired ${daysAgo} days ago (${new Date(expiresAtMs).toISOString()}).`,
      'Run `codex login status` to refresh it, or `codex login` if that is not enough. ' +
        'The CLI only refreshes the token while a command runs, so an idle machine goes stale.',
    );
  }

  return {
    path,
    authMode: authMode ?? CHATGPT_AUTH_MODE,
    accessToken,
    accountId,
    expiresAtMs,
    expiresInSec: expiresAtMs === null ? null : Math.floor((expiresAtMs - now()) / 1000),
    lastRefresh: typeof parsed?.last_refresh === 'string' ? parsed.last_refresh : null,
    warnings,
  };
}

/**
 * The same read, shaped for `/health`: a failure is the answer rather than an
 * exception, and nothing secret is in the result. The token itself never leaves
 * this module except as a header value in `codex.mjs`.
 */
export async function describeAuth(options) {
  try {
    const auth = await readAuth(options);
    return {
      ok: true,
      path: auth.path,
      authMode: auth.authMode,
      hasAccountId: auth.accountId !== null,
      expiresAt: auth.expiresAtMs === null ? null : new Date(auth.expiresAtMs).toISOString(),
      expiresInSec: auth.expiresInSec,
      lastRefresh: auth.lastRefresh,
      warnings: auth.warnings,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      path: authFilePath(options.codexHome),
      authMode: null,
      hasAccountId: false,
      expiresAt: null,
      expiresInSec: null,
      lastRefresh: null,
      warnings: [],
      error: error instanceof Error ? (error.detail ?? error.message) : String(error),
    };
  }
}
