import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { guardError, recordingsDirError } from './errors.mjs';

/**
 * Choosing which recording the current request is about.
 *
 * The shim has no request identifier to work with. Handy's post-processing call
 * carries the draft transcript and nothing else, and the history row for the
 * dictation does not exist yet — `actions.rs` writes it *after* post-processing
 * returns. The filesystem is therefore the only source, and "newest WAV in
 * recordings/" is a heuristic, not an identity.
 *
 * That is what the three guards are for. None of them is optional, and the
 * expensive one to skip is the third: without it, a failure on the second
 * dictation pastes the text of the first, and nothing about the result looks
 * wrong.
 */

/** Smallest possible canonical WAV: RIFF header plus an empty data chunk. */
const MIN_WAV_BYTES = 44;

export function createDedupeStore() {
  let last = null;
  return {
    /** The claim that was last handed out, or null. */
    get last() {
      return last;
    },
    isSame(path, mtimeMs) {
      return last !== null && last.path === path && last.mtimeMs === mtimeMs;
    },
    remember(claim) {
      last = claim;
    },
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until a file has stopped growing.
 *
 * Handy writes the WAV concurrently with local transcription, then awaits and
 * verifies it before post-processing runs — so in the normal path the file is
 * already complete when this is called, and the first stat returns immediately
 * with nothing waited for. The guard exists for the path where that ordering
 * does not hold: a future upstream change, a slow disk, or a file dropped into
 * `recordings/` by hand during a contract test.
 *
 * Quiet is established two ways. `mtime` older than the quiet window is the
 * cheap one and is what makes the normal case free. Observing the same
 * (size, mtime) pair across the quiet window is the fallback, and it is what
 * keeps the guard working if the filesystem clock disagrees with this process's
 * clock — otherwise skew alone could make every file look eternally fresh.
 */
export async function waitUntilSettled(
  path,
  { quietMs, pollMs, timeoutMs, now = Date.now, statFn = stat, sleepFn = defaultSleep },
) {
  const startedAt = now();
  /** @type {{size: number, mtimeMs: number, at: number}|null} */
  let firstSeenInThisState = null;

  for (;;) {
    const at = now();
    const stats = await statFn(path);

    const unchanged =
      firstSeenInThisState !== null &&
      firstSeenInThisState.size === stats.size &&
      firstSeenInThisState.mtimeMs === stats.mtimeMs;

    const quietByMtime = at - stats.mtimeMs >= quietMs;
    const quietByObservation = unchanged && at - firstSeenInThisState.at >= quietMs;

    if (quietByMtime || quietByObservation) return stats;

    if (at - startedAt >= timeoutMs) {
      throw guardError(
        `${path} was still being written after ${timeoutMs}ms (${stats.size} bytes and growing).`,
        'Sending it now would transcribe a truncated recording.',
      );
    }

    if (!unchanged) firstSeenInThisState = { size: stats.size, mtimeMs: stats.mtimeMs, at };
    await sleepFn(Math.min(pollMs, Math.max(0, startedAt + timeoutMs - now())));
  }
}

/** Newest `*.wav` in the directory, by mtime. */
async function newestWav(dir, { readdirFn, statFn, onSkip }) {
  let names;
  try {
    names = await readdirFn(dir);
  } catch (error) {
    throw recordingsDirError(
      `Cannot read ${dir}: ${error.message}`,
      'Handy may have been uninstalled, or HANDY_RECORDINGS_DIR may be pointing somewhere else now.',
    );
  }

  let newest = null;
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.wav')) continue;
    const path = join(dir, name);

    let stats;
    try {
      stats = await statFn(path);
    } catch (error) {
      // Handy's retention deletes old recordings, so a file can vanish between
      // the readdir and the stat. That race is expected; it is still reported,
      // because the same log line is what a permissions problem looks like.
      onSkip(path, error);
      continue;
    }
    if (!stats.isFile()) continue;

    if (newest === null || stats.mtimeMs > newest.mtimeMs) {
      newest = { path, mtimeMs: stats.mtimeMs, size: stats.size };
    }
  }
  return newest;
}

/**
 * Claim the recording this request is about, applying all three guards.
 *
 * This *claims* rather than merely picks: on success the file is recorded in
 * the dedupe store before the caller has done anything with it. That ordering
 * is deliberate. Any failure of the structured-output request makes Handy call
 * the shim a second time in legacy mode (`actions.rs`), and the second call
 * must not be able to re-send audio that the first call already took
 * responsibility for. Claiming up front turns that retry into a clean guard
 * rejection and a fallback to the local transcript, which is the outcome the
 * plan asks for: the same audio is never transcribed twice under two different
 * requests.
 *
 * The cost of that choice is that a genuinely transient upstream failure is not
 * retried within one dictation. That is the intended trade: a lost improvement
 * is visible as "Handy pasted the Whisper draft", while a mis-attributed
 * recording is invisible.
 *
 * @returns {Promise<{path: string, mtimeMs: number, size: number, at: number}>}
 */
export async function claimRecording({
  dir,
  maxAgeSec,
  settleQuietMs,
  settlePollMs,
  settleTimeoutMs,
  dedupe,
  now = Date.now,
  readdirFn = readdir,
  statFn = stat,
  sleepFn = defaultSleep,
  onSkip = () => {},
}) {
  const candidate = await newestWav(dir, { readdirFn, statFn, onSkip });
  if (candidate === null) {
    throw guardError(
      `No .wav files in ${dir}.`,
      'Handy only writes a recording when audio retention is on and the dictation produced samples.',
    );
  }

  // Guard 1, first pass: reject an old file before spending the settle window
  // on it. Re-checked after settling, since settling can only make it older.
  assertFresh(candidate, { maxAgeSec, now });

  // Guard 2.
  const settled = await waitUntilSettled(candidate.path, {
    quietMs: settleQuietMs,
    pollMs: settlePollMs,
    timeoutMs: settleTimeoutMs,
    now,
    statFn,
    sleepFn,
  });

  const claim = {
    path: candidate.path,
    mtimeMs: settled.mtimeMs,
    size: settled.size,
    at: now(),
  };

  if (claim.size < MIN_WAV_BYTES) {
    throw guardError(
      `${claim.path} is ${claim.size} bytes, too small to be a WAV file.`,
      'The recording was never written properly; there is nothing to transcribe.',
    );
  }

  assertFresh(claim, { maxAgeSec, now });

  // Guard 3. Compared against the settled mtime, so a re-recorded file at the
  // same path counts as a new recording, which is what it is.
  //
  // The check and the claim below are one synchronous block with no `await`
  // between them, so two overlapping requests cannot both pass it: the second
  // one runs after the first has already recorded its claim.
  if (dedupe.isSame(claim.path, claim.mtimeMs)) {
    throw guardError(
      `${claim.path} was already sent for transcription.`,
      'Refusing to transcribe the same recording twice: the text would belong to the previous dictation.',
    );
  }

  dedupe.remember(claim);
  return claim;
}

function assertFresh({ path, mtimeMs }, { maxAgeSec, now }) {
  const ageSec = (now() - mtimeMs) / 1000;
  if (ageSec > maxAgeSec) {
    throw guardError(
      `Newest recording ${path} is ${ageSec.toFixed(1)}s old, older than MAX_AGE_SEC=${maxAgeSec}.`,
      'This request is not about that recording. Handy may have audio retention turned off.',
    );
  }
}
