import { execFile } from 'node:child_process';

/**
 * Keeping the access token alive.
 *
 * The token is good for ten days, which sounds like plenty until you notice
 * *when* it gets refreshed: the desktop client refreshes in the background, but
 * the CLI only does it while a command is running. A machine where nobody types
 * `codex` for a fortnight has a token that died four days ago, and the first
 * symptom is a dictation that quietly falls back to the Whisper draft.
 *
 * The plan's answer is a timer rather than a refresh implementation. Owning the
 * refresh flow would mean racing Codex for `auth.json` and impersonating the
 * official client one step further than the shim already does; running the
 * supported command on a schedule costs one process a day.
 *
 * Whether `codex login status` actually refreshes the token, as opposed to only
 * reporting on it, is one of the facts the plan marks as unverified. If it
 * turns out to only report, this is the single place that changes — and
 * `/health` reports the remaining token life either way, so the difference is
 * observable rather than theoretical.
 */

const HOUR_MS = 3_600_000;

export function createKeepalive({ config, logger, execFileFn = execFile }) {
  const settings = config.keepalive;
  /** @type {{ enabled: boolean, lastRunAt: string|null, lastOk: boolean|null, lastMessage: string|null }} */
  const state = {
    enabled: settings.enabled,
    lastRunAt: null,
    lastOk: null,
    lastMessage: null,
  };
  let timer = null;

  function run(bin, args) {
    return new Promise((resolve) => {
      execFileFn(
        bin,
        args,
        { timeout: settings.timeoutMs, windowsHide: true, encoding: 'utf8' },
        (error, _stdout, stderr) => {
          if (error) {
            const reason =
              error.code === 'ENOENT'
                ? `${bin} not found on PATH`
                : (stderr || error.message || 'unknown failure').trim();
            resolve({ ok: false, message: reason.slice(0, 200) });
            return;
          }
          // The command's own output is not kept. `codex login status` names
          // the signed-in account, and this value is published by `/health`;
          // meanwhile the authoritative answer to "is the token alive" is the
          // expiry `/health` already reports straight from auth.json, which
          // beats parsing a CLI's prose for it.
          resolve({ ok: true, message: null });
        },
      );
    });
  }

  async function runOnce() {
    const result = await run(settings.bin, ['login', 'status']);
    state.lastRunAt = new Date().toISOString();
    state.lastOk = result.ok;
    state.lastMessage = result.message;

    if (result.ok) {
      logger.info('keepalive ran', { command: `${settings.bin} login status` });
    } else {
      // Not fatal: the shim still works right up until the token expires, and
      // killing the listener over a keepalive failure would take dictation down
      // for a problem that has days of slack in it. Loud, though — a keepalive
      // that has been failing silently is exactly how the token dies.
      logger.error('keepalive failed', {
        command: `${settings.bin} login status`,
        reason: result.message,
        hint: 'Set CODEX_CLI_BIN to an absolute path; service managers start with a minimal PATH.',
      });
    }
    return result;
  }

  return {
    state,
    runOnce,
    start() {
      if (!settings.enabled) {
        logger.info('keepalive disabled', { via: 'KEEPALIVE_ENABLED=0' });
        return;
      }
      void runOnce();
      timer = setInterval(() => void runOnce(), settings.intervalHours * HOUR_MS);
      // The HTTP listener is what keeps this process alive; the keepalive timer
      // must not be able to hold it open on its own.
      timer.unref?.();
      logger.info('keepalive scheduled', { everyHours: settings.intervalHours });
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
