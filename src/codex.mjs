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

/** How much of an upstream error body is worth putting in a log line. */
const ERROR_BODY_LIMIT = 500;

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

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const startedAt = now();
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
    throw upstreamError(
      `Cannot reach ${url}: ${error.message}`,
      'Check network access to the endpoint from this machine.',
    );
  } finally {
    clearTimeout(timer);
  }

  const elapsedMs = now() - startedAt;
  const requestId = response.headers?.get?.('x-request-id') ?? null;

  if (!response.ok) {
    const body = await readBodySafely(response);
    throw upstreamError(
      `Codex transcribe returned ${response.status}: ${truncate(body, ERROR_BODY_LIMIT)}`,
      describeUpstreamStatus(response.status),
    );
  }

  const raw = await readBodySafely(response);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw upstreamError(
      `Codex transcribe returned ${response.status} with a body that is not JSON: ${error.message}`,
      `First ${ERROR_BODY_LIMIT} characters: ${truncate(raw, ERROR_BODY_LIMIT)}`,
    );
  }

  const text = extractText(payload);
  if (text === null) {
    // The response shape is one of the facts this plan could only verify on a
    // machine with network access to the endpoint, so when it does not match,
    // the error names the keys that did arrive. That turns "it broke" into a
    // one-line fix in this file.
    const keys =
      payload !== null && typeof payload === 'object' ? Object.keys(payload).join(', ') : typeof payload;
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
}

function extractText(payload) {
  if (payload === null || typeof payload !== 'object') return null;
  for (const field of TEXT_FIELDS) {
    if (typeof payload[field] === 'string') return payload[field];
  }
  return null;
}

async function readBodySafely(response) {
  try {
    return await response.text();
  } catch (error) {
    return `<body could not be read: ${error.message}>`;
  }
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
