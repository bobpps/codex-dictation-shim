import { readFile } from 'node:fs/promises';

import { recordingReadError, upstreamError, upstreamTimeoutError } from './errors.mjs';

/**
 * The one network call: the WAV goes to Codex's transcribe endpoint and comes
 * back as text.
 *
 * The endpoint is undocumented. `originator` and the client version in
 * `User-Agent` are what the shim presents itself as, and they are the first
 * thing that will need changing when old client builds start being turned away
 * — which is why they arrive as configuration and are never written here as
 * constants.
 */

/** Field names accepted for the transcript, in order of preference. */
const TEXT_FIELDS = ['text', 'transcript', 'transcription'];

/** How much of an upstream body is worth putting in a log line, once revealed. */
const ERROR_BODY_LIMIT = 500;

/**
 * Describe a response body for an error message, without quoting it by default.
 *
 * The endpoint's response shape is unverified, so "the body is not the
 * transcript" is exactly the kind of assumption this project cannot make: a 200
 * carrying plain text instead of JSON would put dictated speech into an error
 * message, and from there into the log, into `lastError`, and out through
 * `/health` — all with the privacy switch still off.
 *
 * The same rule covers error bodies too. An endpoint explaining a refusal is
 * very unlikely to quote what was said, but "very unlikely" about an
 * undocumented endpoint is a guess, and the cost of being wrong is speech in a
 * log file. What survives redaction — status, content type, and length — is
 * enough to tell an HTML interstitial from a JSON error from a plain-text
 * transcript, which is what these messages are actually for.
 */
function describeBody(raw, contentType, reveal) {
  const size = `${Buffer.byteLength(raw, 'utf8')} bytes of ${contentType ?? 'unknown content-type'}`;
  return reveal
    ? `${size}: ${truncate(raw, ERROR_BODY_LIMIT)}`
    : `${size} (set SHIM_LOG_TRANSCRIPTS=1 to include the body)`;
}

/**
 * `auto` is Handy's word for "no preference" and is not a language the endpoint
 * knows, so it is dropped rather than forwarded. The two script-qualified
 * Chinese tags are folded to `zh`, which is the tag the endpoint takes.
 */
export function normalizeLanguage(value) {
  if (typeof value !== 'string') return null;
  const language = value.trim();
  if (language === '' || language.toLowerCase() === 'auto') return null;
  // `\b` also matches at end of string, so this covers both `zh-Hans` and
  // region-qualified tags like `zh-Hant-TW`.
  if (/^zh-han[st]\b/i.test(language)) return 'zh';
  return language;
}

function describeUpstreamStatus(status) {
  if (status === 401 || status === 403) {
    return 'The token was rejected. Run `codex login status`, then `codex login` if that does not help.';
  }
  if (status === 413) return 'The recording is longer than the endpoint accepts.';
  if (status === 429) return 'Rate limited by the endpoint; the local transcript stands in for this one.';
  if (status >= 500) return 'The endpoint failed on its side; nothing to fix locally.';
  return undefined;
}

/**
 * @param {object} options
 * @param {Uint8Array} options.audio
 * @param {string} options.filename
 * @param {string} options.url
 * @param {string} options.accessToken
 * @param {string|null} options.accountId
 * @param {string} options.originator
 * @param {string} options.userAgent
 * @param {string|null} options.language
 * @param {number} options.timeoutMs
 * @returns {Promise<{ text: string, status: number, requestId: string|null, elapsedMs: number }>}
 */
export async function transcribe({
  audio,
  filename = 'handy.wav',
  url,
  accessToken,
  accountId = null,
  originator,
  userAgent,
  language = null,
  timeoutMs,
  revealBodies = false,
  fetchImpl = fetch,
  now = Date.now,
}) {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), filename);

  const normalizedLanguage = normalizeLanguage(language);
  if (normalizedLanguage !== null) form.append('language', normalizedLanguage);

  const headers = {
    authorization: `Bearer ${accessToken}`,
    originator,
    'user-agent': userAgent,
    accept: 'application/json',
  };
  // Only when the field exists: an empty header is not the same as no header,
  // and the endpoint is entitled to treat it differently.
  if (accountId !== null) headers['chatgpt-account-id'] = accountId;
  // Content-Type is left to fetch, which is the only party that knows the
  // multipart boundary it just generated.

  // The deadline covers the whole exchange, not just the headers.
  //
  // `fetch` resolves as soon as response headers arrive, so clearing the timer
  // at that point leaves the body read with no deadline at all: an endpoint that
  // sends headers and then stalls would hang this request forever. That is worse
  // than a slow transcription — Handy sets no client timeout of its own
  // (`create_client` in llm_client.rs), so the dictation would never finish, not
  // even by falling back to the local draft. The whole safety net depends on
  // this request always ending.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const startedAt = now();
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: form,
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw upstreamTimeoutError(
          `Codex transcribe did not answer within ${timeoutMs}ms.`,
          'Raise CODEX_TIMEOUT_MS if long dictations routinely hit this.',
        );
      }
      // `error.message` is never used here. Measured behaviour of Node's fetch:
      // a transport failure is the generic `fetch failed` with the real reason
      // on `error.cause`, while a failure to *build* the request quotes the
      // offending argument — and one of those arguments is
      // `Authorization: Bearer <token>`. Taking the detail only from `cause`
      // keeps the useful half and drops the half that can carry credentials.
      const cause = error?.cause;
      if (cause === null || cause === undefined) {
        throw upstreamError(
          `Cannot reach ${url}: the request could not be built (${error?.name ?? 'Error'}).`,
          'Details are withheld because this error quotes its arguments, one of which is the access token. ' +
            'A corrupted auth.json is the usual cause; run `codex login`.',
        );
      }
      throw upstreamError(
        `Cannot reach ${url}: ${cause.code ?? cause.message ?? String(cause)}`,
        'Check network access to the endpoint from this machine.',
      );
    }

    const requestId = response.headers?.get?.('x-request-id') ?? null;
    const contentType = response.headers?.get?.('content-type') ?? null;

    let raw;
    try {
      raw = await response.text();
    } catch (error) {
      if (timedOut) {
        throw upstreamTimeoutError(
          `Codex transcribe sent headers but did not finish its body within ${timeoutMs}ms.`,
          'The deadline covers the whole response, so Handy still gets an answer and falls back to the local transcript.',
        );
      }
      throw upstreamError(
        `Codex transcribe sent ${response.status} but its body could not be read (${error?.code ?? error?.name ?? 'Error'}).`,
        'The connection dropped part-way through the response.',
      );
    }

    const elapsedMs = now() - startedAt;

    if (!response.ok) {
      throw upstreamError(
        `Codex transcribe returned ${response.status} — ${describeBody(raw, contentType, revealBodies)}`,
        describeUpstreamStatus(response.status),
      );
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      // The parser's own message is deliberately dropped rather than quoted:
      // `JSON.parse` reports failures as `Unexpected token 's', "something "…`,
      // quoting the start of its input. If that input is a plain-text
      // transcript, the message carries the first words of it straight past the
      // redaction above.
      throw upstreamError(
        `Codex transcribe returned ${response.status} with a body that is not JSON.`,
        `Received ${describeBody(raw, contentType, revealBodies)}`,
      );
    }

    const text = extractText(payload);
    if (text === null) {
      // The response shape is one of the facts this plan could only verify on a
      // machine with network access to the endpoint, so when it does not match,
      // the error names the keys that did arrive. That turns "it broke" into a
      // one-line fix in this file.
      const keys =
        payload !== null && typeof payload === 'object'
          ? Object.keys(payload).join(', ')
          : typeof payload;
      throw upstreamError(
        `Codex transcribe returned no transcript. Tried ${TEXT_FIELDS.join('/')}; response keys: ${keys}.`,
        'The endpoint is undocumented and may have changed its response shape.',
      );
    }
    if (text.trim() === '') {
      throw upstreamError(
        'Codex transcribe returned an empty transcript.',
        'Falling back keeps the local draft rather than pasting nothing.',
      );
    }

    return { text, status: response.status, requestId, elapsedMs };
  } finally {
    clearTimeout(timer);
  }
}

function extractText(payload) {
  if (payload === null || typeof payload !== 'object') return null;
  for (const field of TEXT_FIELDS) {
    if (typeof payload[field] === 'string') return payload[field];
  }
  return null;
}

function truncate(text, limit) {
  const value = String(text);
  return value.length <= limit ? value : `${value.slice(0, limit)}… (${value.length} chars)`;
}

/** Read the claimed recording off disk, as bytes ready to upload. */
export async function readAudio(path, { readFileFn = readFile } = {}) {
  try {
    return await readFileFn(path);
  } catch (error) {
    throw recordingReadError(
      `Cannot read ${path}: ${error.message}`,
      'The recording was claimed and then disappeared; Handy retention may have removed it.',
    );
  }
}
