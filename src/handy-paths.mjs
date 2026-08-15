import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { recordingsDirError } from './errors.mjs';

/**
 * Finding Handy's `recordings/` directory.
 *
 * Tauri v2 names the application data directory after the bundle identifier,
 * but "names it after" is not the same as "we know what it is on this machine":
 * the identifier can change between releases, and Handy also has a portable
 * mode that puts the data directory next to the executable. So the shim probes
 * candidates and picks the first one that actually contains `recordings/`,
 * rather than trusting a guess.
 *
 * `history.rs` builds the path as `app_data_dir/recordings`, which is why the
 * probe looks for that subdirectory specifically rather than for loose WAVs.
 */

const BUNDLE_DIR_NAMES = ['com.pais.handy', 'Handy'];

/** Ordered list of app-data directories to probe on this platform. */
export function appDataCandidates({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const bases = [];

  if (platform === 'darwin') {
    bases.push(join(home, 'Library', 'Application Support'));
  } else if (platform === 'win32') {
    if (env.APPDATA) bases.push(env.APPDATA);
    if (env.LOCALAPPDATA) bases.push(env.LOCALAPPDATA);
  } else {
    // Tauri's app_data_dir is XDG_DATA_HOME on Linux, but Handy has shipped
    // with the config directory too, so both get probed.
    bases.push(env.XDG_DATA_HOME || join(home, '.local', 'share'));
    bases.push(env.XDG_CONFIG_HOME || join(home, '.config'));
  }

  const candidates = [];
  for (const base of bases) {
    for (const name of BUNDLE_DIR_NAMES) candidates.push(join(base, name));
  }
  return candidates;
}

/** The same list, as the `recordings/` paths that are actually being tested. */
export function recordingsDirCandidates(options) {
  return appDataCandidates(options).map((dir) => join(dir, 'recordings'));
}

async function isDirectory(path, statFn) {
  try {
    return (await statFn(path)).isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    // A candidate that exists but cannot be read is worth reporting rather than
    // skipping in silence — "not found" would be the wrong diagnosis.
    throw recordingsDirError(
      `Cannot inspect ${path}: ${error.message}`,
      'Check that the shim runs as the user that owns Handy\'s data directory.',
    );
  }
}

/**
 * Resolve the recordings directory once, at startup.
 *
 * Failing here is the point: a shim that starts happily and only discovers at
 * the first dictation that it has nowhere to look has moved the error from a
 * log line nobody had to hunt for into a dictation that silently degraded.
 *
 * @returns {Promise<{ path: string, probed: string[], source: 'override'|'probe' }>}
 */
export async function resolveRecordingsDir({
  override = null,
  platform = process.platform,
  env = process.env,
  home = homedir(),
  statFn = stat,
} = {}) {
  if (override !== null) {
    if (await isDirectory(override, statFn)) {
      return { path: override, probed: [override], source: 'override' };
    }
    throw recordingsDirError(
      `HANDY_RECORDINGS_DIR points at ${override}, which is not a directory.`,
      'It must be the recordings directory itself, not Handy\'s data directory.',
    );
  }

  const probed = recordingsDirCandidates({ platform, env, home });
  for (const candidate of probed) {
    if (await isDirectory(candidate, statFn)) {
      return { path: candidate, probed, source: 'probe' };
    }
  }

  throw recordingsDirError(
    `Could not find Handy's recordings directory. Probed: ${probed.join(', ')}.`,
    'Dictate once so Handy creates it, or set HANDY_RECORDINGS_DIR to the directory it actually uses.',
  );
}

/** Non-throwing view of the directory for `/health`. */
export async function describeRecordingsDir(path, { readdirFn = readdir } = {}) {
  try {
    const entries = await readdirFn(path);
    return {
      path,
      readable: true,
      wavCount: entries.filter((name) => name.toLowerCase().endsWith('.wav')).length,
      error: null,
    };
  } catch (error) {
    return { path, readable: false, wavCount: null, error: error.message };
  }
}
