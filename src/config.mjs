import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { LOG_LEVELS } from './log.mjs';

/**
 * Configuration is read once at startup and then held. The single exception is
 * `auth.json`, which is deliberately *not* configuration and is re-read on
 * every request — see `auth.mjs` for why.
 *
 * Every parser here throws on a value it does not understand instead of
 * silently falling back to the default. A typo in `SHIM_PORT` should stop the
 * process at startup, not move the listener somewhere nobody is looking.
 */

export const DEFAULTS = Object.freeze({
  SHIM_HOST: '127.0.0.1',
  SHIM_PORT: '8756',
  CODEX_TRANSCRIBE_URL: 'https://chatgpt.com/backend-api/transcribe',
  CODEX_ORIGINATOR: 'codex_desktop',
  CODEX_USER_AGENT: 'Codex Desktop/26.611.62324',
  CODEX_TIMEOUT_MS: '120000',
  MAX_AGE_SEC: '60',
  SETTLE_QUIET_MS: '150',
  SETTLE_POLL_MS: '50',
  SETTLE_TIMEOUT_MS: '3000',
  MAX_BODY_BYTES: '1048576',
  SHIM_LOG_LEVEL: 'info',
  SHIM_LOG_TRANSCRIPTS: '0',
  KEEPALIVE_ENABLED: '1',
  KEEPALIVE_INTERVAL_HOURS: '24',
  KEEPALIVE_TIMEOUT_MS: '60000',
  CODEX_CLI_BIN: 'codex',
});

/**
 * `KEY=VALUE` per line; `#` comments only where a line starts; surrounding
 * quotes stripped. No interpolation, no `export`, no multi-line values.
 *
 * Small on purpose. A fuller dotenv dialect would be a dependency in disguise,
 * and the shim's whole shape — no build, no `npm install`, runs anywhere Node
 * is — comes from not having any.
 */
export function parseDotEnv(source) {
  const values = Object.create(null);
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(separator + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);

    values[key] = value;
  }
  return values;
}

/**
 * Merge a `.env` file into `env` without overwriting anything already set: a
 * service unit or a one-off `SHIM_PORT=9000 npm start` must win over the file.
 *
 * @returns {boolean} whether a file was found and applied.
 */
export function loadDotEnvInto(env, path) {
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  for (const [key, value] of Object.entries(parseDotEnv(source))) {
    if (env[key] === undefined) env[key] = value;
  }
  return true;
}

function readString(env, key) {
  const raw = env[key];
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value === '' ? (DEFAULTS[key] ?? '') : value;
}

function readOptionalString(env, key) {
  const raw = env[key];
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value === '' ? null : value;
}

function readInteger(env, key, { min, max }) {
  const value = readString(env, key);
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${key} must be a whole number, got "${value}".`);
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < min || parsed > max) {
    throw new Error(`${key} must be between ${min} and ${max}, got ${parsed}.`);
  }
  return parsed;
}

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);

function readBoolean(env, key) {
  const value = readString(env, key).toLowerCase();
  if (TRUE.has(value)) return true;
  if (FALSE.has(value)) return false;
  throw new Error(`${key} must be one of 1/0/true/false/yes/no/on/off, got "${value}".`);
}

function readUrl(env, key) {
  const value = readString(env, key);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be an absolute URL, got "${value}".`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${key} must be http or https, got "${url.protocol}".`);
  }
  return url.toString();
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ dotEnvPath?: string|null }} [options]
 */
export function loadConfig(env = process.env, { dotEnvPath = null } = {}) {
  const source = { ...env };
  const dotEnvLoaded = dotEnvPath === null ? false : loadDotEnvInto(source, dotEnvPath);

  const logLevel = readString(source, 'SHIM_LOG_LEVEL').toLowerCase();
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(`SHIM_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${logLevel}".`);
  }

  const settleQuietMs = readInteger(source, 'SETTLE_QUIET_MS', { min: 0, max: 60_000 });
  const settleTimeoutMs = readInteger(source, 'SETTLE_TIMEOUT_MS', { min: 0, max: 120_000 });
  if (settleTimeoutMs < settleQuietMs) {
    throw new Error(
      `SETTLE_TIMEOUT_MS (${settleTimeoutMs}) is below SETTLE_QUIET_MS (${settleQuietMs}), so a ` +
        'file could never be observed quiet for long enough to be accepted.',
    );
  }

  return {
    dotEnvLoaded,
    dotEnvPath,

    host: readString(source, 'SHIM_HOST'),
    // 0 asks the OS for a free port. Handy needs a fixed one, so this is only
    // useful to the tests, which bind an ephemeral port per case.
    port: readInteger(source, 'SHIM_PORT', { min: 0, max: 65_535 }),

    // Empty means "probe the platform candidates" — see handy-paths.mjs.
    recordingsDirOverride: (() => {
      const value = readOptionalString(source, 'HANDY_RECORDINGS_DIR');
      return value === null ? null : resolve(value);
    })(),

    codexHome: readOptionalString(source, 'CODEX_HOME') ?? join(homedir(), '.codex'),

    transcribeUrl: readUrl(source, 'CODEX_TRANSCRIBE_URL'),
    originator: readString(source, 'CODEX_ORIGINATOR'),
    userAgent: readString(source, 'CODEX_USER_AGENT'),
    language: readOptionalString(source, 'CODEX_LANGUAGE'),
    requestTimeoutMs: readInteger(source, 'CODEX_TIMEOUT_MS', { min: 1_000, max: 600_000 }),

    maxAgeSec: readInteger(source, 'MAX_AGE_SEC', { min: 1, max: 86_400 }),
    settleQuietMs,
    settlePollMs: readInteger(source, 'SETTLE_POLL_MS', { min: 1, max: 5_000 }),
    settleTimeoutMs,

    maxBodyBytes: readInteger(source, 'MAX_BODY_BYTES', { min: 1_024, max: 64 * 1024 * 1024 }),

    logLevel,
    logTranscripts: readBoolean(source, 'SHIM_LOG_TRANSCRIPTS'),

    keepalive: {
      enabled: readBoolean(source, 'KEEPALIVE_ENABLED'),
      intervalHours: readInteger(source, 'KEEPALIVE_INTERVAL_HOURS', { min: 1, max: 168 }),
      timeoutMs: readInteger(source, 'KEEPALIVE_TIMEOUT_MS', { min: 1_000, max: 600_000 }),
      bin: readString(source, 'CODEX_CLI_BIN'),
    },
  };
}
