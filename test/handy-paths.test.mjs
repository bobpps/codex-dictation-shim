import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  appDataCandidates,
  describeRecordingsDir,
  recordingsDirCandidates,
  resolveRecordingsDir,
} from '../src/handy-paths.mjs';

/**
 * Locating `recordings/` by probing.
 *
 * This is the path every real installation takes: `HANDY_RECORDINGS_DIR` is an
 * escape hatch for portable mode, not the normal case, so the candidate lists
 * and the "first one that actually has recordings/" rule are what runs on a
 * machine nobody configured. The rest of the suite sets the override and so
 * never exercises any of it.
 *
 * `statFn` is injected rather than mocked globally: these assertions are about
 * which paths get tried and in what order, which is exactly what a temporary
 * directory could not tell us.
 */

const DIR = { isDirectory: () => true };
const FILE = { isDirectory: () => false };

/** A filesystem where only the listed paths are directories. */
function fsWith(...directories) {
  const present = new Set(directories);
  const tried = [];
  const statFn = async (path) => {
    tried.push(path);
    if (present.has(path)) return DIR;
    const error = new Error(`ENOENT: ${path}`);
    error.code = 'ENOENT';
    throw error;
  };
  return { statFn, tried };
}

describe('candidate lists per platform', () => {
  it('probes both bundle identifiers on macOS', () => {
    assert.deepEqual(appDataCandidates({ platform: 'darwin', env: {}, home: '/Users/x' }), [
      '/Users/x/Library/Application Support/com.pais.handy',
      '/Users/x/Library/Application Support/Handy',
    ]);
  });

  it('probes both APPDATA roots on Windows', () => {
    const candidates = appDataCandidates({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
      home: 'C:\\Users\\x',
    });
    assert.equal(candidates.length, 4);
    assert.ok(candidates[0].includes('Roaming'));
    assert.ok(candidates[2].includes('Local'));
  });

  it('skips Windows roots the environment does not define', () => {
    // A missing APPDATA must not become the literal string "undefined" in a path.
    const candidates = appDataCandidates({ platform: 'win32', env: {}, home: 'C:\\Users\\x' });
    assert.deepEqual(candidates, []);
  });

  it('honours the XDG variables on Linux, and falls back when they are unset', () => {
    assert.deepEqual(appDataCandidates({ platform: 'linux', env: {}, home: '/home/x' }), [
      '/home/x/.local/share/com.pais.handy',
      '/home/x/.local/share/Handy',
      '/home/x/.config/com.pais.handy',
      '/home/x/.config/Handy',
    ]);

    const xdg = appDataCandidates({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/data', XDG_CONFIG_HOME: '/conf' },
      home: '/home/x',
    });
    assert.equal(xdg[0], '/data/com.pais.handy');
    assert.equal(xdg[2], '/conf/com.pais.handy');
  });

  it('tests the recordings subdirectory, not the data directory', () => {
    // history.rs builds the path as `app_data_dir/recordings`, and looking for
    // that subdirectory specifically is what stops an unrelated directory of
    // the same name from being accepted.
    const candidates = recordingsDirCandidates({ platform: 'linux', env: {}, home: '/home/x' });
    assert.ok(candidates.every((path) => path.endsWith('/recordings')));
  });
});

describe('resolving the directory', () => {
  it('takes the first candidate that actually holds recordings', async () => {
    const { statFn, tried } = fsWith('/home/x/.config/Handy/recordings');

    const resolved = await resolveRecordingsDir({
      platform: 'linux',
      env: {},
      home: '/home/x',
      statFn,
    });

    assert.equal(resolved.path, '/home/x/.config/Handy/recordings');
    assert.equal(resolved.source, 'probe');
    // Order matters: the data directory is what Tauri documents, so it must be
    // tried before the config directory.
    assert.deepEqual(tried, [
      '/home/x/.local/share/com.pais.handy/recordings',
      '/home/x/.local/share/Handy/recordings',
      '/home/x/.config/com.pais.handy/recordings',
      '/home/x/.config/Handy/recordings',
    ]);
  });

  it('stops at the first match instead of preferring a later one', async () => {
    const { statFn, tried } = fsWith(
      '/home/x/.local/share/com.pais.handy/recordings',
      '/home/x/.config/Handy/recordings',
    );

    const resolved = await resolveRecordingsDir({ platform: 'linux', env: {}, home: '/home/x', statFn });

    assert.equal(resolved.path, '/home/x/.local/share/com.pais.handy/recordings');
    assert.equal(tried.length, 1);
  });

  it('names everything it tried when nothing matches', async () => {
    // This error is the whole reason resolution happens at startup: it has to
    // be actionable without a debugger.
    const { statFn } = fsWith();

    await assert.rejects(
      resolveRecordingsDir({ platform: 'linux', env: {}, home: '/home/x', statFn }),
      (error) => {
        assert.equal(error.status, 503);
        assert.equal(error.code, 'recordings_dir');
        assert.match(error.message, /\.local\/share\/com\.pais\.handy\/recordings/);
        assert.match(error.message, /\.config\/Handy\/recordings/);
        assert.match(error.hint, /HANDY_RECORDINGS_DIR/);
        return true;
      },
    );
  });

  it('reports a candidate it cannot read rather than calling it absent', async () => {
    // "Not found" would be the wrong diagnosis for a permissions problem, and
    // it would send the operator looking for a directory that is right there.
    const statFn = async () => {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    };

    await assert.rejects(
      resolveRecordingsDir({ platform: 'linux', env: {}, home: '/home/x', statFn }),
      (error) => {
        assert.match(error.message, /Cannot inspect/);
        assert.match(error.hint, /runs as the user/);
        return true;
      },
    );
  });
});

describe('the HANDY_RECORDINGS_DIR override', () => {
  it('is used as given, without probing anything', async () => {
    const { statFn, tried } = fsWith('/custom/recordings');

    const resolved = await resolveRecordingsDir({ override: '/custom/recordings', statFn });

    assert.equal(resolved.path, '/custom/recordings');
    assert.equal(resolved.source, 'override');
    assert.deepEqual(tried, ['/custom/recordings']);
  });

  it('says so plainly when it does not point at a directory', async () => {
    const statFn = async () => FILE;

    await assert.rejects(resolveRecordingsDir({ override: '/custom/notes.txt', statFn }), (error) => {
      assert.match(error.message, /not a directory/);
      // The usual mistake is pointing it at the data directory instead.
      assert.match(error.hint, /recordings directory itself/);
      return true;
    });
  });
});

describe('describeRecordingsDir for /health', () => {
  it('counts recordings without reading them', async () => {
    const readdirFn = async () => ['handy-1.wav', 'handy-2.WAV', 'history.db', 'notes.txt'];

    const report = await describeRecordingsDir('/somewhere', { readdirFn });

    assert.equal(report.readable, true);
    assert.equal(report.wavCount, 2, 'the extension check must not be case-sensitive');
    assert.equal(report.error, null);
  });

  it('turns an unreadable directory into a field rather than an exception', async () => {
    const readdirFn = async () => {
      throw new Error('ENOENT: no such directory');
    };

    const report = await describeRecordingsDir('/gone', { readdirFn });

    assert.equal(report.readable, false);
    assert.equal(report.wavCount, null);
    assert.match(report.error, /no such directory/);
  });
});
