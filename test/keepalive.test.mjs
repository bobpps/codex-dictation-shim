import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createKeepalive } from '../src/keepalive.mjs';
import { recordingLogger } from './helpers.mjs';

/**
 * The keepalive exists because the access token lives ten days but the CLI only
 * refreshes it while a command runs. It must be loud when it fails and must not
 * take the shim down with it — a keepalive problem has days of slack, a dead
 * listener has none.
 */

function build({ execFileFn, bin = 'codex', enabled = true }) {
  const logger = recordingLogger();
  const keepalive = createKeepalive({
    config: { keepalive: { enabled, bin, intervalHours: 24, timeoutMs: 1000 } },
    logger,
    execFileFn,
  });
  return { keepalive, logger };
}

describe('the token keepalive', () => {
  it('does not keep the command output, which names the account', async () => {
    // `/health` publishes this state, and `codex login status` prints who is
    // signed in. The authoritative answer to "is the token alive" is the expiry
    // that /health already reads out of auth.json, so the prose adds nothing
    // worth publishing.
    const { keepalive } = build({
      execFileFn: (_bin, _args, _options, callback) =>
        callback(null, 'Logged in using ChatGPT (someone@example.com)\n', ''),
    });

    await keepalive.runOnce();

    assert.equal(keepalive.state.lastOk, true);
    assert.equal(keepalive.state.lastMessage, null);
    assert.ok(!JSON.stringify(keepalive.state).includes('example.com'));
    assert.ok(keepalive.state.lastRunAt !== null);
  });

  it('runs the supported command rather than touching auth.json itself', async () => {
    // Owning the refresh would mean racing Codex for the file. Deliberately
    // pinned: this is the whole reason there is no refresh flow.
    let invoked = null;
    const { keepalive } = build({
      bin: '/usr/local/bin/codex',
      execFileFn: (bin, args, _options, callback) => {
        invoked = { bin, args };
        callback(null, '', '');
      },
    });

    await keepalive.runOnce();

    assert.equal(invoked.bin, '/usr/local/bin/codex');
    assert.deepEqual(invoked.args, ['login', 'status']);
  });

  it('says loudly when the binary is not on the service manager\'s PATH', async () => {
    // launchd and systemd start with a minimal PATH, and a keepalive that never
    // ran is how the token quietly dies ten days later.
    const { keepalive, logger } = build({
      execFileFn: (_bin, _args, _options, callback) => {
        const error = new Error('spawn codex ENOENT');
        error.code = 'ENOENT';
        callback(error, '', '');
      },
    });

    await keepalive.runOnce();

    assert.equal(keepalive.state.lastOk, false);
    assert.match(keepalive.state.lastMessage, /not found on PATH/);
    assert.ok(logger.has('error', 'keepalive failed'));
    const failure = logger.lines.find((line) => line.message === 'keepalive failed');
    assert.match(failure.fields.hint, /CODEX_CLI_BIN/);
  });

  it('bounds what a failing command can write into the state', async () => {
    const { keepalive } = build({
      execFileFn: (_bin, _args, _options, callback) =>
        callback(new Error('failed'), '', 'x'.repeat(5000)),
    });

    await keepalive.runOnce();

    assert.equal(keepalive.state.lastMessage.length, 200);
  });

  it('reports being switched off without pretending it ran', () => {
    const { keepalive, logger } = build({
      enabled: false,
      execFileFn: () => assert.fail('must not run when disabled'),
    });

    keepalive.start();

    assert.equal(keepalive.state.enabled, false);
    assert.equal(keepalive.state.lastRunAt, null);
    assert.ok(logger.has('info', 'keepalive disabled'));
    keepalive.stop();
  });
});
