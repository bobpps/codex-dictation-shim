import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { loadConfig, loadDotEnvInto, parseDotEnv } from '../src/config.mjs';
import { makeTempDir, removeDir } from './helpers.mjs';

/**
 * Configuration parsing refuses values it does not understand instead of
 * falling back to a default. A typo in `SHIM_PORT` should stop the process at
 * startup, not quietly move the listener somewhere Handy is not looking.
 */

let dir;
before(async () => {
  dir = await makeTempDir('shim-config-');
});
after(async () => {
  await removeDir(dir);
});

describe('.env parsing', () => {
  it('reads keys, comments, and quotes', () => {
    const parsed = parseDotEnv(
      [
        '# a comment',
        '',
        'SHIM_PORT=9000',
        'CODEX_USER_AGENT="Codex Desktop/1.2.3"',
        "CODEX_ORIGINATOR='codex_cli'",
        '  SHIM_HOST = 0.0.0.0  ',
      ].join('\n'),
    );

    assert.equal(parsed.SHIM_PORT, '9000');
    assert.equal(parsed.CODEX_USER_AGENT, 'Codex Desktop/1.2.3');
    assert.equal(parsed.CODEX_ORIGINATOR, 'codex_cli');
    assert.equal(parsed.SHIM_HOST, '0.0.0.0');
  });

  it('keeps an empty value as empty rather than dropping the key', () => {
    assert.deepEqual({ ...parseDotEnv('CODEX_LANGUAGE=') }, { CODEX_LANGUAGE: '' });
  });

  it('skips lines that are not assignments', () => {
    assert.deepEqual({ ...parseDotEnv('just a line\n=novalue\n1BAD=x') }, {});
  });

  it('lets the real environment win over the file', async () => {
    // A service unit has to be able to override a value without editing a file
    // that is deliberately not in the repository.
    const path = join(dir, '.env');
    await writeFile(path, 'SHIM_PORT=9000\nSHIM_HOST=10.0.0.1\n');

    const env = { SHIM_PORT: '8756' };
    assert.equal(loadDotEnvInto(env, path), true);
    assert.equal(env.SHIM_PORT, '8756');
    assert.equal(env.SHIM_HOST, '10.0.0.1');
  });

  it('reports a missing file without throwing', () => {
    assert.equal(loadDotEnvInto({}, join(dir, 'nothing-here')), false);
  });
});

describe('defaults', () => {
  it('produces a working configuration from an empty environment', () => {
    const config = loadConfig({}, { dotEnvPath: null });

    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 8756);
    assert.equal(config.transcribeUrl, 'https://chatgpt.com/backend-api/transcribe');
    assert.equal(config.originator, 'codex_desktop');
    assert.equal(config.maxAgeSec, 60);
    assert.equal(config.language, null);
    assert.equal(config.recordingsDirOverride, null);
    assert.equal(config.logTranscripts, false, 'speech must not be logged unless asked for');
    assert.ok(config.codexHome.endsWith('.codex'));
  });

  it('keeps the client pin editable as configuration', () => {
    // This is the line that changes when old client builds start being turned
    // away. It must not require editing source.
    const config = loadConfig(
      { CODEX_ORIGINATOR: 'codex_cli', CODEX_USER_AGENT: 'Codex CLI/1.0' },
      { dotEnvPath: null },
    );
    assert.equal(config.originator, 'codex_cli');
    assert.equal(config.userAgent, 'Codex CLI/1.0');
  });
});

describe('rejected values', () => {
  const cases = [
    ['SHIM_PORT', 'eight-thousand', /whole number/],
    ['SHIM_PORT', '70000', /between 0 and 65535/],
    ['MAX_AGE_SEC', '0', /between 1 and 86400/],
    ['SHIM_LOG_TRANSCRIPTS', 'maybe', /1\/0\/true\/false/],
    ['SHIM_LOG_LEVEL', 'chatty', /error, warn, info, debug/],
    ['CODEX_TRANSCRIBE_URL', 'not-a-url', /absolute URL/],
    ['CODEX_TRANSCRIBE_URL', 'ftp://example.com', /http or https/],
    ['KEEPALIVE_INTERVAL_HOURS', '0', /between 1 and 168/],
  ];

  for (const [key, value, expected] of cases) {
    it(`refuses ${key}=${value}`, () => {
      assert.throws(() => loadConfig({ [key]: value }, { dotEnvPath: null }), expected);
    });
  }

  it('refuses a settle timeout shorter than the quiet window', () => {
    // Otherwise no file could ever be observed quiet for long enough, and every
    // dictation would fail on a guard that looks correct in isolation.
    assert.throws(
      () => loadConfig({ SETTLE_QUIET_MS: '500', SETTLE_TIMEOUT_MS: '100' }, { dotEnvPath: null }),
      /below SETTLE_QUIET_MS/,
    );
  });
});
