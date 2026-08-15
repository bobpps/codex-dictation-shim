import assert from 'node:assert/strict';
import { appendFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { claimRecording, createDedupeStore, waitUntilSettled } from '../src/recording.mjs';
import { makeTempDir, removeDir, writeRecording } from './helpers.mjs';

/**
 * The three guards. Each one is here because without it a specific wrong
 * transcript reaches the user's cursor looking exactly like a right one.
 */

const GUARDS = {
  maxAgeSec: 60,
  settleQuietMs: 40,
  settlePollMs: 5,
  settleTimeoutMs: 400,
};

/**
 * Each test gets its own directory and its own dedupe store, created and
 * removed inside the test rather than in a hook. Nothing is shared, so the
 * order tests run in cannot matter — and it works the same on every Node
 * version, since file-level hooks only became reliable in Node 20.
 */
async function withRecordings(run) {
  const dir = await makeTempDir('shim-recordings-');
  const dedupe = createDedupeStore();
  const claim = (overrides = {}) => claimRecording({ dir, dedupe, ...GUARDS, ...overrides });
  try {
    return await run({ dir, dedupe, claim });
  } finally {
    await removeDir(dir);
  }
}

describe('picking a recording', () => {
  it('takes the newest wav by mtime, not by name', () =>
    withRecordings(async ({ dir, claim }) => {
      await writeRecording(dir, 'handy-2000000000.wav', { ageSec: 30 });
      const expected = await writeRecording(dir, 'handy-1000000000.wav', { ageSec: 1 });

      assert.equal((await claim()).path, expected);
    }));

  it('ignores files that are not wav', () =>
    withRecordings(async ({ dir, claim }) => {
      await writeFile(join(dir, 'history.db'), 'not audio');
      await writeFile(join(dir, 'notes.txt'), 'not audio either');
      const expected = await writeRecording(dir, 'handy-1.wav');

      assert.equal((await claim()).path, expected);
    }));

  it('refuses when there is nothing to send', () =>
    withRecordings(async ({ claim }) => {
      await assert.rejects(claim(), (error) => {
        assert.equal(error.status, 409);
        assert.match(error.message, /No \.wav files/);
        return true;
      });
    }));
});

describe('guard: freshness', () => {
  it('refuses a recording older than MAX_AGE_SEC', () =>
    withRecordings(async ({ dir, claim }) => {
      // Handy writes the WAV before post-processing runs, so an old file means
      // this request is not about it — most likely audio retention is off and
      // the newest file is from some earlier dictation entirely.
      await writeRecording(dir, 'handy-old.wav', { ageSec: 3600 });

      await assert.rejects(claim(), (error) => {
        assert.equal(error.status, 409);
        assert.match(error.message, /older than MAX_AGE_SEC=60/);
        return true;
      });
    }));

  it('accepts a recording inside the window', () =>
    withRecordings(async ({ dir, claim }) => {
      await writeRecording(dir, 'handy-recent.wav', { ageSec: 55 });
      assert.ok((await claim()).path.endsWith('handy-recent.wav'));
    }));

  it('refuses a recording dated in the future', () =>
    withRecordings(async ({ dir, claim }) => {
      // The failure that looks like success: a negative age is never "older
      // than MAX_AGE_SEC", and the highest mtime always wins the newest-file
      // contest — so one stale, clock-skewed recording would be picked and
      // accepted for every dictation from then on. A clock stepped backwards or
      // a recordings directory on a filesystem with its own clock is enough.
      await writeRecording(dir, 'handy-from-the-future.wav', { ageSec: -3600 });

      await assert.rejects(claim(), (error) => {
        assert.equal(error.status, 409);
        assert.match(error.message, /dated 3600\.\ds in the future/);
        assert.match(error.hint, /clock has moved backwards/);
        return true;
      });
    }));

  it('tolerates the small skew a network filesystem can produce', () =>
    withRecordings(async ({ dir, claim }) => {
      await writeRecording(dir, 'handy-slightly-ahead.wav', { ageSec: -2 });
      assert.ok((await claim()).path.endsWith('handy-slightly-ahead.wav'));
    }));
});

describe('guard: still being written', () => {
  it('waits for a growing file and accepts it once it stops', () =>
    withRecordings(async ({ dir }) => {
      const path = await writeRecording(dir, 'handy-growing.wav');
      const stopAt = Date.now() + 120;
      const grow = (async () => {
        while (Date.now() < stopAt) {
          await appendFile(path, Buffer.alloc(1024));
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })();

      const settled = await waitUntilSettled(path, {
        quietMs: GUARDS.settleQuietMs,
        pollMs: GUARDS.settlePollMs,
        timeoutMs: 2000,
      });
      await grow;

      // Settled means the size stopped moving, so what was measured is the
      // whole file — the point of the guard is that a truncated WAV never goes
      // out.
      assert.ok(settled.size >= 1024);
    }));

  it('gives up rather than sending a truncated recording', () =>
    withRecordings(async ({ dir }) => {
      const path = await writeRecording(dir, 'handy-endless.wav');
      let growing = true;
      const grow = (async () => {
        while (growing) {
          await appendFile(path, Buffer.alloc(512));
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      })();

      await assert.rejects(
        waitUntilSettled(path, { quietMs: 200, pollMs: 5, timeoutMs: 300 }),
        (error) => {
          assert.equal(error.status, 409);
          assert.match(error.message, /still being written/);
          return true;
        },
      );

      growing = false;
      await grow;
    }));

  it('costs no waiting when the file finished writing a while ago', () =>
    withRecordings(async ({ dir }) => {
      // The normal path: actions.rs awaits and verifies the WAV before calling
      // post-processing, so by the time the shim is asked the file is long
      // done. If this guard cost its quiet window every time, it would be pure
      // latency added to every single dictation.
      const path = await writeRecording(dir, 'handy-done.wav', { ageSec: 5 });

      const startedAt = Date.now();
      await waitUntilSettled(path, { quietMs: 1000, pollMs: 50, timeoutMs: 5000 });
      assert.ok(Date.now() - startedAt < 100, 'settled file should not be waited on');
    }));
});

describe('guard: deduplication', () => {
  it('refuses the same recording twice', () =>
    withRecordings(async ({ dir, claim }) => {
      // Without this, a failure on the second dictation resends the first
      // one's audio and pastes the first one's words. Nothing about the result
      // looks wrong, which is what makes it worth a hard refusal.
      await writeRecording(dir, 'handy-1.wav', { ageSec: 1 });

      const first = await claim();
      assert.ok(first.path.endsWith('handy-1.wav'));

      await assert.rejects(claim(), (error) => {
        assert.equal(error.status, 409);
        assert.match(error.message, /already sent for transcription/);
        return true;
      });
    }));

  it('treats a re-recorded file at the same path as a new recording', () =>
    withRecordings(async ({ dir, claim }) => {
      // Handy names recordings by whole seconds, so two dictations inside one
      // second land on the same path. Different mtime, different recording.
      const path = await writeRecording(dir, 'handy-1.wav', { ageSec: 1 });
      await claim();

      await new Promise((resolve) => setTimeout(resolve, 20));
      await writeFile(path, Buffer.alloc(2048, 1));

      const second = await claim();
      assert.equal(second.path, path);
      assert.equal(second.size, 2048);
    }));

  it('claims before the caller does anything, so a retry cannot reuse the audio', () =>
    withRecordings(async ({ dir, dedupe, claim }) => {
      await writeRecording(dir, 'handy-1.wav', { ageSec: 1 });
      const claimed = await claim();

      assert.equal(dedupe.last.path, claimed.path);
      assert.equal(dedupe.last.mtimeMs, claimed.mtimeMs);
    }));

  it('lets a newer recording through while the previous one stays claimed', () =>
    withRecordings(async ({ dir, claim }) => {
      await writeRecording(dir, 'handy-1.wav', { ageSec: 2 });
      await claim();

      const next = await writeRecording(dir, 'handy-2.wav', { ageSec: 0 });
      assert.equal((await claim()).path, next);
    }));

  it('still refuses an earlier recording after a later one disappears', () =>
    withRecordings(async ({ dir, claim }) => {
      // Remembering only the last claim leaves this gap: claim A, then claim B,
      // then let B vanish — retention removing it, or the next recording never
      // being written — and A is the newest file on disk again while the store
      // only remembers B. A would go out a second time and the earlier
      // dictation's words would land in the current one.
      const a = await writeRecording(dir, 'handy-a.wav', { ageSec: 2 });
      assert.equal((await claim()).path, a);

      const b = await writeRecording(dir, 'handy-b.wav', { ageSec: 0 });
      assert.equal((await claim()).path, b);

      await unlink(b);

      await assert.rejects(claim(), (error) => {
        assert.equal(error.status, 409);
        assert.match(error.message, /already sent for transcription/);
        return true;
      });
    }));

  it('forgets claims once their recording is too old to be picked again', () => {
    // The set is bounded by the dictation window rather than by the session: a
    // recording older than MAX_AGE_SEC is already refused on freshness, so
    // remembering it buys nothing and would grow without limit.
    let clock = 1_000_000;
    const store = createDedupeStore({ maxAgeMs: 60_000, now: () => clock });

    store.remember({ path: '/r/handy-1.wav', mtimeMs: clock - 1_000, at: clock });
    assert.equal(store.isSame('/r/handy-1.wav', clock - 1_000), true);
    assert.equal(store.size, 1);

    clock += 120_000;
    assert.equal(store.isSame('/r/handy-1.wav', clock - 121_000), false);
    assert.equal(store.size, 0);
  });
});

describe('guard: not a wav at all', () => {
  it('refuses a file too small to hold a wav header', () =>
    withRecordings(async ({ dir, claim }) => {
      await writeRecording(dir, 'handy-empty.wav', { bytes: Buffer.alloc(0) });

      await assert.rejects(claim(), (error) => {
        assert.equal(error.status, 409);
        assert.match(error.message, /too small to be a WAV/);
        return true;
      });
    }));
});
