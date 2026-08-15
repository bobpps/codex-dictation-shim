#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeAuth, readAuth } from './auth.mjs';
import { readAudio, transcribe } from './codex.mjs';
import { loadConfig } from './config.mjs';
import { ShimError } from './errors.mjs';
import { describeRecordingsDir, resolveRecordingsDir } from './handy-paths.mjs';
import { createKeepalive } from './keepalive.mjs';
import { clip, createLogger } from './log.mjs';
import { claimRecording, createDedupeStore } from './recording.mjs';

/**
 * The shim itself: an OpenAI-compatible chat-completions endpoint that ignores
 * the text it is given, transcribes the audio that produced it, and hands the
 * result back in the shape Handy expects.
 *
 * Handy's post-processing step is the extension point. It is meant for tidying
 * up a transcript with a language model, so it receives text and no audio —
 * useless on its own. But it runs *after* the WAV is on disk, which is the
 * whole trick: the audio the request is about is sitting in `recordings/`, and
 * this process can go and get it.
 */

const VERSION = '0.1.0';

/**
 * Find the field name Handy will read the transcript out of.
 *
 * Handy asks for structured output and then pulls one named property out of the
 * JSON. Hardcoding that name would make the shim break the day upstream renames
 * it — and the feature is marked alpha, so that day is plausible. The name is
 * in the request the shim was just handed: `response_format.json_schema.schema`
 * carries `required: [<name>]` (see `actions.rs`), so the shim reads it from
 * there and answers in whatever shape it was asked for.
 *
 * Presence of a schema is what decides, not `response_format.type`: Handy's
 * legacy path omits `response_format` entirely, and that absence is the only
 * signal that matters.
 *
 * @returns {string|null} field name, or null for legacy plain-content mode.
 */
export function transcriptionFieldFromRequest(body) {
  const container = body?.response_format?.json_schema;
  if (container === null || typeof container !== 'object') return null;

  const schema =
    container.schema !== null && typeof container.schema === 'object' ? container.schema : container;

  const required = Array.isArray(schema.required)
    ? schema.required.filter((name) => typeof name === 'string' && name !== '')
    : [];
  if (required.length > 0) return required[0];

  // A schema with properties but no `required` is still a structured request;
  // the first property is the only reasonable reading of what it wants.
  const properties = schema.properties;
  if (properties !== null && typeof properties === 'object') {
    const names = Object.keys(properties);
    if (names.length > 0) return names[0];
  }

  return null;
}

/** The draft transcript Handy sent, used only for log correlation. */
export function draftFromRequest(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user' && typeof message.content === 'string') return message.content;
  }
  return null;
}

/**
 * Handy deserializes exactly `choices[0].message.content` and ignores the rest
 * (`llm_client.rs`). The rest is filled in anyway: this endpoint claims to be
 * OpenAI-compatible, and a client that believes the claim should not be
 * punished for it.
 */
export function chatCompletionEnvelope({ content, model, createdSec, id }) {
  return {
    id,
    object: 'chat.completion',
    created: createdSec,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, refusal: null },
        logprobs: null,
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** Strip the query string and an optional `/v1` prefix. */
export function normalizeRoute(url) {
  const path = (url ?? '/').split('?')[0];
  const withoutV1 = path.replace(/^\/v1(?=\/|$)/, '');
  const route = withoutV1 === '' ? '/' : withoutV1;
  return route.length > 1 && route.endsWith('/') ? route.slice(0, -1) : route;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res, error) {
  const status = error instanceof ShimError ? error.status : 500;
  const code = error instanceof ShimError ? error.code : 'shim_error';
  const message = error instanceof ShimError ? error.detail : `Unexpected shim failure: ${error.message}`;
  sendJson(res, status, { error: { message, type: code, code, param: null } });
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new ShimError(`Request body exceeded MAX_BODY_BYTES=${limit}.`, {
        status: 413,
        code: 'body_too_large',
        hint: 'Handy sends only the draft transcript; something else is calling this endpoint.',
      });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Build the server. Startup work that can fail — locating `recordings/` — is
 * done here rather than lazily, so a misconfigured machine refuses to start
 * instead of failing at the first dictation, when the only symptom is a
 * transcript that is quietly worse than it should have been.
 */
export async function createApp({ config, logger }) {
  const recordings = await resolveRecordingsDir({ override: config.recordingsDirOverride });
  logger.info('recordings directory resolved', {
    path: recordings.path,
    via: recordings.source,
  });

  // This endpoint has no authentication. Handy's API key is ignored on purpose
  // — Handy sends whatever string it is given, so checking it would prove
  // nothing — and off the loopback interface that means anyone who can reach
  // the port can ask for the transcript of whatever was just dictated. Someone
  // may have a reason to bind wider; nobody should do it by accident.
  if (!isLoopback(config.host)) {
    logger.warn('listening beyond localhost', {
      host: config.host,
      detail:
        'This endpoint requires no credentials and returns the transcript of the newest recording. ' +
        'Anyone who can reach this port can read what was just dictated.',
    });
  }

  const dedupe = createDedupeStore();
  const keepalive = createKeepalive({ config, logger });
  const startedAtMs = Date.now();

  /** @type {{ at: string, chars: number, file: string, elapsedMs: number }|null} */
  let lastTranscription = null;
  /** @type {{ at: string, code: string, message: string }|null} */
  let lastError = null;

  async function health() {
    const [auth, dir] = await Promise.all([
      describeAuth({ codexHome: config.codexHome }),
      describeRecordingsDir(recordings.path),
    ]);
    const ok = auth.ok && dir.readable;
    return {
      status: ok ? 'ok' : 'degraded',
      version: VERSION,
      uptimeSec: Math.floor((Date.now() - startedAtMs) / 1000),
      listen: `http://${config.host}:${config.port}`,
      recordings: { ...dir, via: recordings.source },
      auth,
      codex: {
        endpoint: config.transcribeUrl,
        originator: config.originator,
        userAgent: config.userAgent,
        language: config.language,
      },
      guards: {
        maxAgeSec: config.maxAgeSec,
        settleQuietMs: config.settleQuietMs,
        settleTimeoutMs: config.settleTimeoutMs,
        lastClaim:
          dedupe.last === null
            ? null
            : { file: baseName(dedupe.last.path), at: new Date(dedupe.last.at).toISOString() },
      },
      keepalive: keepalive.state,
      lastTranscription,
      lastError,
    };
  }

  async function handleCompletions(req, res, requestId) {
    const raw = await readBody(req, config.maxBodyBytes);

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      // 400 is deliberately reserved for this case. Handy cannot produce it —
      // it serializes its own struct — so a 400 here means a human with curl,
      // and it will not trigger Handy's retry-without-reasoning-fields path.
      //
      // The parser's message is left out for the same reason it is left out of
      // `auth.mjs` and `codex.mjs`: Node quotes the text around the failure,
      // and the text here is the draft transcript.
      throw new ShimError('Request body is not JSON.', {
        status: 400,
        code: 'invalid_request',
        hint: 'The parser message is withheld because it would quote the draft transcript.',
      });
    }

    const field = transcriptionFieldFromRequest(body);
    const draft = draftFromRequest(body);
    logger.info('dictation request', {
      request: requestId,
      mode: field === null ? 'legacy' : `schema:${clip(field, 64)}`,
      model: typeof body?.model === 'string' ? clip(body.model, 64) : '-',
      draft: logger.text(draft ?? ''),
    });

    // Every request, never cached: Codex rewrites this file on refresh.
    const auth = await readAuth({ codexHome: config.codexHome });
    for (const warning of auth.warnings) {
      logger.warn('credentials warning', { request: requestId, detail: warning });
    }

    const claim = await claimRecording({
      dir: recordings.path,
      maxAgeSec: config.maxAgeSec,
      settleQuietMs: config.settleQuietMs,
      settlePollMs: config.settlePollMs,
      settleTimeoutMs: config.settleTimeoutMs,
      dedupe,
      onSkip: (path, error) =>
        logger.debug('skipped a recording', { request: requestId, path, reason: error.message }),
    });
    logger.debug('claimed recording', {
      request: requestId,
      file: baseName(claim.path),
      bytes: claim.size,
      ageMs: Math.round(Date.now() - claim.mtimeMs),
    });

    const audio = await readAudio(claim.path);
    const result = await transcribe({
      audio,
      filename: baseName(claim.path),
      url: config.transcribeUrl,
      accessToken: auth.accessToken,
      accountId: auth.accountId,
      originator: config.originator,
      userAgent: config.userAgent,
      language: config.language,
      timeoutMs: config.requestTimeoutMs,
      // An unexpected response body could be the transcript itself, so it is
      // held to the same privacy switch as one.
      revealBodies: config.logTranscripts,
    });

    const content = field === null ? result.text : JSON.stringify({ [field]: result.text });

    lastTranscription = {
      at: new Date().toISOString(),
      chars: [...result.text].length,
      file: baseName(claim.path),
      elapsedMs: result.elapsedMs,
    };
    logger.info('dictation transcribed', {
      request: requestId,
      file: baseName(claim.path),
      chars: lastTranscription.chars,
      elapsedMs: result.elapsedMs,
      upstreamRequest: result.requestId,
      text: logger.text(result.text),
    });

    sendJson(
      res,
      200,
      chatCompletionEnvelope({
        content,
        model: typeof body?.model === 'string' && body.model !== '' ? body.model : 'codex-dictation-shim',
        createdSec: Math.floor(Date.now() / 1000),
        id: `chatcmpl-${randomUUID().replaceAll('-', '')}`,
      }),
    );
  }

  /**
   * Handy's settings UI lists models from `{base_url}/models`. The shim has
   * exactly one, and the name is cosmetic — the audio decides the output — but
   * answering keeps the setup screen from showing an error next to a provider
   * that is working fine.
   */
  function handleModels(res) {
    sendJson(res, 200, {
      object: 'list',
      data: [
        {
          id: 'codex-dictation-shim',
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'codex-dictation-shim',
        },
      ],
    });
  }

  async function route(req, res, requestId) {
    const path = normalizeRoute(req.url);
    const method = req.method ?? 'GET';

    if (method === 'POST' && path === '/chat/completions') return handleCompletions(req, res, requestId);
    if (method === 'GET' && path === '/models') return handleModels(res);
    if (method === 'GET' && path === '/health') {
      const report = await health();
      return sendJson(res, report.status === 'ok' ? 200 : 503, report);
    }

    throw new ShimError(`No route for ${clip(method, 16)} ${clip(path)}.`, {
      status: 404,
      code: 'not_found',
      hint: 'Handy\'s base URL should be http://host:port/v1 — the shim serves /v1/chat/completions.',
    });
  }

  const server = createServer((req, res) => {
    const requestId = randomUUID().slice(0, 8);
    route(req, res, requestId).catch((error) => {
      // The one catch in the whole shim, and it reports rather than swallows:
      // a non-2xx makes Handy paste the local draft instead of nothing, and the
      // log line is what stops "Codex sounds worse today" from being the only
      // symptom of a broken shim.
      const isShimError = error instanceof ShimError;
      lastError = {
        at: new Date().toISOString(),
        code: isShimError ? error.code : 'shim_error',
        message: isShimError ? error.detail : error.message,
      };
      logger.error('request failed', {
        request: requestId,
        status: isShimError ? error.status : 500,
        code: lastError.code,
        detail: lastError.message,
      });
      if (!isShimError) logger.error('unexpected failure stack', { request: requestId, stack: error.stack });

      if (!res.headersSent) sendError(res, error);
      else res.destroy();
    });
  });

  return {
    server,
    health,
    keepalive,
    recordingsDir: recordings.path,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.removeListener('error', reject);
          resolve(server.address());
        });
      });
    },
    async close() {
      keepalive.stop();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function baseName(path) {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1];
}

export function isLoopback(host) {
  const bare = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return bare === 'localhost' || bare === '::1' || /^127\.\d+\.\d+\.\d+$/.test(bare);
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const config = loadConfig(process.env, { dotEnvPath: join(here, '..', '.env') });
  const logger = createLogger({ level: config.logLevel, logTranscripts: config.logTranscripts });

  logger.info(`codex-dictation-shim ${VERSION} starting`, {
    node: process.version,
    dotenv: config.dotEnvLoaded ? config.dotEnvPath : 'none',
    transcripts: config.logTranscripts ? 'LOGGED' : 'redacted',
  });

  const app = await createApp({ config, logger });
  await app.listen();
  logger.info('listening', {
    url: `http://${config.host}:${config.port}`,
    handyBaseUrl: `http://${config.host}:${config.port}/v1`,
  });

  app.keepalive.start();

  const shutdown = (signal) => {
    logger.info('shutting down', { signal });
    app.close().then(
      () => process.exit(0),
      (error) => {
        logger.error('shutdown failed', { reason: error.message });
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A process in an unknown state should die and be restarted by the service
  // manager, not stay up answering requests from a state nobody can describe.
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { reason: error.message, stack: error.stack });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { reason: String(reason) });
    process.exit(1);
  });
}

/**
 * True when this file was started as the program, rather than imported.
 *
 * Compared through `realpathSync` because `package.json` declares a `bin`:
 * installed that way, `process.argv[1]` is the symlink the package manager
 * created, and a plain string comparison against this module's own path would
 * be false — the process would start, define everything, and exit without ever
 * listening.
 */
function startedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return fileURLToPath(import.meta.url) === process.argv[1];
  }
}

if (startedDirectly()) {
  main().catch((error) => {
    const detail = error instanceof ShimError ? error.detail : error.message;
    console.error(`${new Date().toISOString()} FATAL ${detail}`);
    if (!(error instanceof ShimError)) console.error(error.stack);
    process.exit(1);
  });
}
