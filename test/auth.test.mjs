import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { decodeJwtPayload, describeAuth, readAuth } from '../src/auth.mjs';
import { makeJwt, makeTempDir, removeDir, writeAuthFile } from './helpers.mjs';

/**
 * Credential failures are the ones most likely to be met with "it just stopped
 * working". Every case here is graded on whether the message tells the operator
 * what to type next.
 */

/** A private CODEX_HOME per test, so nothing leaks between them. */
async function withCodexHome(run) {
  const codexHome = await makeTempDir('shim-codex-');
  try {
    return await run(codexHome);
  } finally {
    await removeDir(codexHome);
  }
}

describe('reading auth.json', () => {
  it('returns the token and account id from a ChatGPT login', () =>
    withCodexHome(async (codexHome) => {
      await writeAuthFile(codexHome, { accountId: 'acct-42' });

      const auth = await readAuth({ codexHome });
      assert.equal(auth.authMode, 'chatgpt');
      assert.equal(auth.accountId, 'acct-42');
      assert.ok(auth.accessToken.length > 0);
      assert.ok(auth.expiresInSec > 0);
      assert.deepEqual(auth.warnings, []);
    }));

  it('re-reads the file on every call so a refresh is picked up', () =>
    withCodexHome(async (codexHome) => {
      // Codex rewrites auth.json when it refreshes. A value cached at startup
      // is a value that goes stale with no event to notice.
      await writeAuthFile(codexHome, { accountId: 'acct-before' });
      const before = await readAuth({ codexHome });

      await writeAuthFile(codexHome, { accountId: 'acct-after' });
      const after = await readAuth({ codexHome });

      assert.equal(before.accountId, 'acct-before');
      assert.equal(after.accountId, 'acct-after');
    }));
});

describe('credential failures', () => {
  it('names the file and the command when there is no auth.json', () =>
    withCodexHome(async (codexHome) => {
      await assert.rejects(readAuth({ codexHome }), (error) => {
        assert.equal(error.status, 503);
        assert.equal(error.code, 'codex_auth');
        assert.match(error.message, /No Codex credentials at/);
        assert.match(error.hint, /codex login/);
        return true;
      });
    }));

  it('explains an API-key login instead of throwing on undefined', () =>
    withCodexHome(async (codexHome) => {
      // `codex login --with-api-key` writes a different shape with no tokens
      // object. Reading `tokens.access_token` off it is a TypeError; saying
      // which login the endpoint needs is an answer.
      await writeFile(
        join(codexHome, 'auth.json'),
        JSON.stringify({ OPENAI_API_KEY: 'sk-test', auth_mode: 'apikey' }),
      );

      await assert.rejects(readAuth({ codexHome }), (error) => {
        assert.match(error.message, /has no "tokens" object \(auth_mode is "apikey"\)/);
        assert.match(error.hint, /without --with-api-key/);
        return true;
      });
    }));

  it('rejects an auth_mode that is not chatgpt even when tokens are present', () =>
    withCodexHome(async (codexHome) => {
      await writeAuthFile(codexHome, { authMode: 'apikey' });

      await assert.rejects(readAuth({ codexHome }), (error) => {
        assert.match(error.message, /auth_mode "apikey"/);
        return true;
      });
    }));

  it('says how long ago the token died, and what refreshes it', () =>
    withCodexHome(async (codexHome) => {
      await writeAuthFile(codexHome, { expiresInSec: -4 * 24 * 3600 });

      await assert.rejects(readAuth({ codexHome }), (error) => {
        assert.equal(error.status, 503);
        assert.match(error.message, /expired 4\.0 days ago/);
        assert.match(error.hint, /codex login status/);
        // The ten-day TTL plus a CLI that only refreshes while it runs is
        // exactly how a machine ends up with a token that died days before
        // anyone looked.
        assert.match(error.hint, /idle machine/);
        return true;
      });
    }));

  it('reports unreadable JSON rather than a parse stack', () =>
    withCodexHome(async (codexHome) => {
      await writeFile(join(codexHome, 'auth.json'), '{ not json');

      await assert.rejects(readAuth({ codexHome }), (error) => {
        assert.match(error.message, /is not valid JSON/);
        return true;
      });
    }));

  it('refuses an empty access token', () =>
    withCodexHome(async (codexHome) => {
      await writeFile(
        join(codexHome, 'auth.json'),
        JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: '  ' } }),
      );

      await assert.rejects(readAuth({ codexHome }), (error) => {
        assert.match(error.message, /no tokens\.access_token/);
        return true;
      });
    }));
});

describe('degraded but usable credentials', () => {
  it('warns about a missing account id instead of refusing', () =>
    withCodexHome(async (codexHome) => {
      // The header is only sent when the field exists. The endpoint may well
      // authorise from the token alone, so this is a warning, not a wall.
      await writeAuthFile(codexHome, { accountId: null });

      const auth = await readAuth({ codexHome });
      assert.equal(auth.accountId, null);
      assert.match(auth.warnings.join(' '), /account_id is missing/);
    }));

  it('warns when the token is not a readable JWT and proceeds anyway', () =>
    withCodexHome(async (codexHome) => {
      // The endpoint stays the authority on whether a token works. Losing the
      // local expiry check only costs the clear message, not the request.
      await writeAuthFile(codexHome, { accessToken: 'opaque-token-value' });

      const auth = await readAuth({ codexHome });
      assert.equal(auth.expiresAtMs, null);
      assert.equal(auth.expiresInSec, null);
      assert.match(auth.warnings.join(' '), /not a readable JWT/);
    }));

  it('warns when the token carries no exp claim', () =>
    withCodexHome(async (codexHome) => {
      await writeAuthFile(codexHome, { accessToken: makeJwt({ sub: 'user' }) });

      const auth = await readAuth({ codexHome });
      assert.equal(auth.expiresAtMs, null);
      assert.match(auth.warnings.join(' '), /no numeric "exp" claim/);
    }));
});

describe('decodeJwtPayload', () => {
  it('reads the payload without verifying the signature', () => {
    assert.deepEqual(decodeJwtPayload(makeJwt({ exp: 123, sub: 'me' })), { exp: 123, sub: 'me' });
  });

  it('rejects anything that is not three segments', () => {
    assert.throws(() => decodeJwtPayload('a.b'), /3 dot-separated segments/);
  });

  it('rejects a payload that is not a JSON object', () => {
    const token = `x.${Buffer.from('"a string"').toString('base64url')}.y`;
    assert.throws(() => decodeJwtPayload(token), /not a JSON object/);
  });
});

describe('describeAuth for /health', () => {
  it('reports expiry without ever exposing the token', () =>
    withCodexHome(async (codexHome) => {
      await writeAuthFile(codexHome, { accountId: 'acct-42' });

      const report = await describeAuth({ codexHome });
      assert.equal(report.ok, true);
      assert.equal(report.hasAccountId, true);
      assert.ok(report.expiresInSec > 0);
      // Health output is the thing most likely to be pasted into a chat window.
      const serialized = JSON.stringify(report);
      assert.ok(!serialized.includes('eyJ'), 'no JWT segment may appear in health output');
      assert.ok(!serialized.includes('refresh-token-value'));
    }));

  it('turns a failure into a readable field instead of an exception', () =>
    withCodexHome(async (codexHome) => {
      const report = await describeAuth({ codexHome });
      assert.equal(report.ok, false);
      assert.match(report.error, /No Codex credentials at/);
      assert.match(report.error, /codex login/);
    }));
});
