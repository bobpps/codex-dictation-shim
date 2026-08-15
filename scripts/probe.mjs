#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readAuth } from '../src/auth.mjs';
import { normalizeLanguage } from '../src/codex.mjs';
import { loadConfig } from '../src/config.mjs';

/**
 * Verification step 01: the endpoint reconnaissance, as a command.
 *
 * The plan asks for a curl against the transcribe endpoint before any of this
 * is trusted — response code, response shape, real token TTL, the audio length
 * limit, and what happens without the `originator` header. None of that can be
 * answered from a development box: `chatgpt.com` answers 403 in 45ms from the
 * sandbox this was written in, which proves nothing about the endpoint.
 *
 * So it ships as a script to run on the machine that has network access. It
 * deliberately reuses `auth.mjs` and the same header set the shim sends, so
 * what it measures is what the shim will do, not an approximation of it.
 *
 *   node scripts/probe.mjs recording.wav
 *   node scripts/probe.mjs recording.wav --language en
 *   node scripts/probe.mjs recording.wav --compare   (also try without originator)
 *   node scripts/probe.mjs recording.wav --reveal    (print the transcript itself)
 *
 * A successful response contains what you said into the microphone, and this
 * output usually ends up in terminal scrollback. So by default it reports the
 * response's status, type, size, and keys — everything needed to learn the
 * shape — and prints the text only when asked.
 */

const USAGE =
  'Usage: node scripts/probe.mjs <recording.wav> [--language xx] [--compare] [--reveal]';

function parseArgs(argv) {
  const args = { file: null, language: null, compare: false, reveal: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--compare') args.compare = true;
    else if (arg === '--reveal') args.reveal = true;
    else if (arg === '--language') args.language = argv[++index] ?? null;
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}. ${USAGE}`);
    else if (args.file === null) args.file = arg;
    else throw new Error(`Give exactly one WAV file. ${USAGE}`);
  }
  if (args.file === null) throw new Error(USAGE);
  return args;
}

async function attempt(label, { url, audio, filename, headers, language, timeoutMs, reveal }) {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), filename);
  if (language !== null) form.append('language', language);

  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    console.log(`\n── ${label}`);
    console.log(`   failed after ${Date.now() - startedAt}ms: ${error.message}`);
    return;
  }

  const body = await response.text();
  console.log(`\n── ${label}`);
  console.log(`   status   ${response.status} ${response.statusText} in ${Date.now() - startedAt}ms`);
  console.log(`   headers  ${JSON.stringify(Object.fromEntries(response.headers))}`);
  console.log(
    `   size     ${Buffer.byteLength(body, 'utf8')} bytes of ` +
      `${response.headers.get('content-type') ?? 'unknown content-type'}`,
  );

  // Key names describe the shape, which is the point of the probe; the values
  // are the speech, which is not.
  try {
    const parsed = JSON.parse(body);
    if (parsed !== null && typeof parsed === 'object') {
      console.log(`   keys     ${Object.keys(parsed).join(', ')}`);
    } else {
      console.log(`   keys     (body is JSON, but a ${typeof parsed} rather than an object)`);
    }
  } catch {
    console.log('   keys     (body is not JSON)');
  }

  if (reveal) {
    console.log(`   body     ${body.length > 2000 ? `${body.slice(0, 2000)}… (${body.length} chars)` : body}`);
  } else {
    console.log('   body     hidden — it contains what you said. Rerun with --reveal to print it.');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // The same `.env` the shim reads, from the same place. A probe configured
  // differently from the thing it is probing answers a question nobody asked:
  // it could look for credentials in the wrong CODEX_HOME, or test the endpoint
  // with headers the shim will never send.
  const here = dirname(fileURLToPath(import.meta.url));
  const config = loadConfig(process.env, { dotEnvPath: join(here, '..', '.env') });
  if (config.dotEnvLoaded) console.log(`── using ${config.dotEnvPath}\n`);

  const auth = await readAuth({ codexHome: config.codexHome });
  const audioStat = await stat(args.file);
  const audio = await readFile(args.file);

  console.log('── credentials');
  console.log(`   file        ${auth.path}`);
  console.log(`   auth_mode   ${auth.authMode}`);
  console.log(`   account id  ${auth.accountId === null ? 'MISSING' : 'present'}`);
  console.log(`   last_refresh ${auth.lastRefresh ?? '-'}`);
  console.log(
    `   expires     ${
      auth.expiresAtMs === null
        ? 'unknown (token is not a readable JWT)'
        : `${new Date(auth.expiresAtMs).toISOString()} — ${(auth.expiresInSec / 86400).toFixed(2)} days left`
    }`,
  );
  for (const warning of auth.warnings) console.log(`   warning     ${warning}`);

  console.log('\n── audio');
  console.log(`   ${args.file} — ${audioStat.size} bytes`);
  console.log('   (rerun with a long recording to find the length limit; that is the one');
  console.log('    fact this script cannot discover on its own)');

  const headers = {
    authorization: `Bearer ${auth.accessToken}`,
    originator: config.originator,
    'user-agent': config.userAgent,
    accept: 'application/json',
  };
  if (auth.accountId !== null) headers['chatgpt-account-id'] = auth.accountId;

  const request = {
    url: config.transcribeUrl,
    audio,
    filename: basename(args.file),
    language: normalizeLanguage(args.language ?? config.language),
    timeoutMs: config.requestTimeoutMs,
    // Same privacy switch the shim uses, plus an explicit flag for this run.
    reveal: args.reveal || config.logTranscripts,
  };

  console.log(`\n── POST ${config.transcribeUrl}`);
  console.log(`   originator ${config.originator} · user-agent ${config.userAgent}`);
  await attempt('as the shim sends it', { ...request, headers });

  if (args.compare) {
    // The plan asks specifically what happens without this header, because
    // sending it is the part that impersonates the desktop client. If the
    // endpoint does not care, the shim can stop claiming to be something it
    // is not.
    const { originator, ...withoutOriginator } = headers;
    await attempt('without the originator header', { ...request, headers: withoutOriginator });
  }
}

main().catch((error) => {
  console.error(`\nprobe failed: ${error.detail ?? error.message}`);
  process.exit(1);
});
