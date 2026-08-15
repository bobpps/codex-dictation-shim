import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared fixtures.
 *
 * The endpoint this shim talks to cannot be reached from a development box —
 * the plan measured `chatgpt.com` answering 403 in 46ms from the sandbox that
 * wrote it — so the tests stand a real HTTP server in its place and point
 * `CODEX_TRANSCRIBE_URL` at it. Real server, real multipart body, real socket:
 * everything except the far end is the production path.
 */

export const SAMPLE_WAV = fileURLToPath(new URL('./fixtures/sample.wav', import.meta.url));

const base64url = (value) => Buffer.from(value).toString('base64url');

/**
 * A structurally valid JWT with an unverifiable signature. That is exactly what
 * `auth.mjs` expects to handle: it reads `exp` to produce a good error message
 * and never pretends to validate anything.
 */
export function makeJwt(payload) {
  return [
    base64url(JSON.stringify({ alg: 'none', typ: 'JWT' })),
    base64url(JSON.stringify(payload)),
    'not-a-real-signature',
  ].join('.');
}

export async function makeTempDir(prefix = 'shim-test-') {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeDir(path) {
  await rm(path, { recursive: true, force: true });
}

/**
 * Write a `~/.codex/auth.json` lookalike.
 *
 * @param {string} dir CODEX_HOME
 * @param {object} [options]
 * @param {number} [options.expiresInSec] Negative values produce a dead token.
 */
export async function writeAuthFile(dir, options = {}) {
  const {
    expiresInSec = 10 * 24 * 3600,
    accountId = 'acct-000000000000000000000000000000000',
    authMode = 'chatgpt',
    accessToken,
    omitTokens = false,
    lastRefresh = new Date().toISOString(),
  } = options;

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    OPENAI_API_KEY: null,
    last_refresh: lastRefresh,
  };
  if (authMode !== null) payload.auth_mode = authMode;
  if (!omitTokens) {
    payload.tokens = {
      id_token: makeJwt({ sub: 'user', exp: now + expiresInSec }),
      access_token:
        accessToken ?? makeJwt({ sub: 'user', iat: now, exp: now + expiresInSec }),
      refresh_token: 'refresh-token-value',
    };
    if (accountId !== null) payload.tokens.account_id = accountId;
  }

  const path = join(dir, 'auth.json');
  await writeFile(path, JSON.stringify(payload, null, 2));
  return path;
}

/** Write a WAV into `dir` and optionally backdate it. */
export async function writeRecording(dir, name, { bytes, ageSec = 0 } = {}) {
  const path = join(dir, name);
  const content = bytes ?? (await readFile(SAMPLE_WAV));
  await writeFile(path, content);
  if (ageSec !== 0) {
    const when = new Date(Date.now() - ageSec * 1000);
    await utimes(path, when, when);
  }
  return path;
}

/**
 * Stand-in for `chatgpt.com/backend-api/transcribe`.
 *
 * `respond` receives the recorded request and returns `{ status, body, headers }`.
 * The raw multipart body is kept as a Buffer so tests can assert on the
 * filename and the WAV magic without a multipart parser standing between the
 * assertion and what actually went over the wire.
 */
export async function startFakeTranscribe(respond = () => ({ status: 200, body: { text: 'codex heard this' } })) {
  const requests = [];

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const recorded = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(recorded);

      const reply = (await respond(recorded, requests.length)) ?? { status: 200, body: {} };
      if (reply.hang) return; // never answers: exercises the timeout path

      const payload = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
      res.writeHead(reply.status ?? 200, {
        'content-type': reply.contentType ?? 'application/json',
        'x-request-id': 'req_fake_0001',
        ...(reply.headers ?? {}),
      });
      res.end(payload);
    });
  });

  // A `hang` response deliberately never finishes, so closing has to be able to
  // pull the socket out from under it rather than wait politely.
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/backend-api/transcribe`,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Minimal logger that records instead of printing. */
export function recordingLogger() {
  const lines = [];
  const push = (level) => (message, fields) => lines.push({ level, message, fields });
  return {
    lines,
    logTranscripts: false,
    error: push('error'),
    warn: push('warn'),
    info: push('info'),
    debug: push('debug'),
    text: (value) => `<${[...String(value ?? '')].length} chars>`,
    has: (level, fragment) =>
      lines.some((line) => line.level === level && line.message.includes(fragment)),
  };
}

/** The request body Handy sends when it asks for structured output. */
export function handyStructuredRequest(draft = 'local whisper draft', field = 'transcription') {
  return {
    model: 'whatever',
    stream: false,
    messages: [
      { role: 'system', content: 'Clean up the transcript.' },
      { role: 'user', content: draft },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'transcription_output',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            [field]: { type: 'string', description: 'The cleaned and processed transcription text' },
          },
          required: [field],
          additionalProperties: false,
        },
      },
    },
  };
}

/** The request body Handy sends after structured output has failed once. */
export function handyLegacyRequest(draft = 'local whisper draft') {
  return {
    model: 'whatever',
    stream: false,
    messages: [{ role: 'user', content: `Clean this up: ${draft}` }],
  };
}
