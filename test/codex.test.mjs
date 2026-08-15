import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { normalizeLanguage, readAudio, transcribe } from '../src/codex.mjs';
import { SAMPLE_WAV, startFakeTranscribe } from './helpers.mjs';

/**
 * The request to Codex, checked against a real HTTP server rather than a mock
 * of `fetch`. What matters here is what goes over the wire — the headers the
 * endpoint authorises on, and a multipart body that actually contains the WAV —
 * and a stubbed `fetch` would let all of that be wrong while the test passed.
 */

const BASE = {
  accessToken: 'token-value',
  accountId: 'acct-42',
  originator: 'codex_desktop',
  userAgent: 'Codex Desktop/26.611.62324',
  timeoutMs: 5000,
};

async function withServer(respond, run) {
  const server = await startFakeTranscribe(respond);
  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

describe('the transcribe request', () => {
  it('sends the audio with the headers the endpoint authorises on', async () => {
    const audio = await readFile(SAMPLE_WAV);

    await withServer(undefined, async (server) => {
      const result = await transcribe({ ...BASE, audio, filename: 'handy-1.wav', url: server.url });

      assert.equal(result.text, 'codex heard this');
      assert.equal(result.status, 200);
      assert.equal(result.requestId, 'req_fake_0001');

      const [sent] = server.requests;
      assert.equal(sent.method, 'POST');
      assert.equal(sent.headers.authorization, 'Bearer token-value');
      assert.equal(sent.headers['chatgpt-account-id'], 'acct-42');
      assert.equal(sent.headers.originator, 'codex_desktop');
      assert.equal(sent.headers['user-agent'], 'Codex Desktop/26.611.62324');
      assert.match(sent.headers['content-type'], /^multipart\/form-data; boundary=/);

      const body = sent.body.toString('latin1');
      assert.match(body, /name="file"; filename="handy-1\.wav"/);
      assert.match(body, /Content-Type: audio\/wav/i);
      assert.ok(body.includes('RIFF'), 'the WAV bytes must actually be in the body');
      assert.ok(sent.body.length > audio.length, 'body must carry the whole file');
    });
  });

  it('omits the account header when auth.json has no account id', async () => {
    // An empty header is not the same as no header, and the endpoint is
    // entitled to treat them differently.
    await withServer(undefined, async (server) => {
      await transcribe({ ...BASE, accountId: null, audio: await readFile(SAMPLE_WAV), url: server.url });
      assert.equal('chatgpt-account-id' in server.requests[0].headers, false);
    });
  });

  it('sends a language hint only when there is a real one', async () => {
    const audio = await readFile(SAMPLE_WAV);

    await withServer(undefined, async (server) => {
      await transcribe({ ...BASE, audio, url: server.url, language: 'en' });
      await transcribe({ ...BASE, audio, url: server.url, language: 'auto' });
      await transcribe({ ...BASE, audio, url: server.url, language: 'zh-Hant-TW' });

      const bodies = server.requests.map((request) => request.body.toString('latin1'));
      assert.match(bodies[0], /name="language"\r\n\r\nen/);
      assert.ok(!bodies[1].includes('name="language"'), '"auto" is not a language the endpoint knows');
      assert.match(bodies[2], /name="language"\r\n\r\nzh/);
    });
  });
});

describe('when the endpoint refuses', () => {
  it('turns 401 into an error that names the fix', async () => {
    await withServer(() => ({ status: 401, body: { detail: 'invalid token' } }), async (server) => {
      await assert.rejects(
        transcribe({ ...BASE, audio: await readFile(SAMPLE_WAV), url: server.url }),
        (error) => {
          assert.equal(error.status, 502);
          assert.equal(error.code, 'codex_upstream');
          assert.match(error.message, /returned 401/);
          assert.match(error.hint, /codex login status/);
          return true;
        },
      );
    });
  });

  it('explains a 413 as an audio-length limit', async () => {
    await withServer(() => ({ status: 413, body: 'too long' }), async (server) => {
      await assert.rejects(
        transcribe({ ...BASE, audio: await readFile(SAMPLE_WAV), url: server.url }),
        (error) => {
          assert.match(error.hint, /longer than the endpoint accepts/);
          return true;
        },
      );
    });
  });

  it('reports a non-JSON body by its shape, without quoting it', async () => {
    await withServer(
      () => ({ status: 200, body: '<html>blocked</html>', contentType: 'text/html' }),
      async (server) => {
        await assert.rejects(
          transcribe({ ...BASE, audio: await readFile(SAMPLE_WAV), url: server.url }),
          (error) => {
            assert.match(error.message, /body that is not JSON/);
            // Status, type, and length are enough to tell an HTML interstitial
            // from a JSON error from a plain-text transcript.
            assert.match(error.hint, /20 bytes of text\/html/);
            assert.ok(!error.hint.includes('blocked'));
            assert.match(error.hint, /SHIM_LOG_TRANSCRIPTS=1/);
            return true;
          },
        );
      },
    );
  });

  it('never puts a plain-text success body into an error, log, or /health', async () => {
    // The leak this guards against: the response shape is unverified, so a 200
    // carrying text instead of JSON is possible — and that text is the speech.
    // Without redaction it would reach the log and /health with the privacy
    // switch still off, which is precisely what AGENTS.md forbids.
    const spoken = 'my bank card number is written on the fridge';

    await withServer(() => ({ status: 200, body: spoken, contentType: 'text/plain' }), async (server) => {
      await assert.rejects(
        transcribe({ ...BASE, audio: await readFile(SAMPLE_WAV), url: server.url }),
        (error) => {
          // Checked as every run of eight characters rather than as the whole
          // string, because the leak that got through review the first time was
          // a fragment: `JSON.parse` names the start of its input in the error
          // it throws, so quoting that message quotes the speech.
          for (let at = 0; at + 8 <= spoken.length; at += 1) {
            const fragment = spoken.slice(at, at + 8);
            assert.ok(!error.detail.includes(fragment), `speech fragment "${fragment}" leaked`);
          }
          assert.match(error.detail, new RegExp(`${Buffer.byteLength(spoken)} bytes of text/plain`));
          return true;
        },
      );
    });
  });

  it('quotes the body once the operator asks for it', async () => {
    await withServer(
      () => ({ status: 200, body: '<html>blocked</html>', contentType: 'text/html' }),
      async (server) => {
        await assert.rejects(
          transcribe({
            ...BASE,
            audio: await readFile(SAMPLE_WAV),
            url: server.url,
            revealBodies: true,
          }),
          (error) => {
            assert.match(error.hint, /<html>blocked<\/html>/);
            return true;
          },
        );
      },
    );
  });

  it('holds error bodies to the same rule', async () => {
    await withServer(() => ({ status: 400, body: { detail: 'bad audio' } }), async (server) => {
      await assert.rejects(
        transcribe({ ...BASE, audio: await readFile(SAMPLE_WAV), url: server.url }),
        (error) => {
          assert.match(error.message, /returned 400/);
          assert.ok(!error.message.includes('bad audio'));
          return true;
        },
      );
    });
  });

  it('names the keys it did get when the response shape has moved', async () => {
    // The response shape is one of the facts the plan could not verify without
    // network access to the endpoint. When it turns out to be wrong, the error
    // should be a one-line fix rather than a debugging session.
    await withServer(() => ({ status: 200, body: { result: { content: 'hi' } } }), async (server) => {
      await assert.rejects(
        transcribe({ ...BASE, audio: await readFile(SAMPLE_WAV), url: server.url }),
        (error) => {
          assert.match(error.message, /Tried text\/transcript\/transcription/);
          assert.match(error.message, /response keys: result/);
          return true;
        },
      );
    });
  });

  it('accepts the alternative field names it knows about', async () => {
    await withServer(() => ({ status: 200, body: { transcript: 'from another shape' } }), async (server) => {
      const result = await transcribe({ ...BASE, audio: await readFile(SAMPLE_WAV), url: server.url });
      assert.equal(result.text, 'from another shape');
    });
  });

  it('treats an empty transcript as a failure so the local draft survives', async () => {
    await withServer(() => ({ status: 200, body: { text: '   ' } }), async (server) => {
      await assert.rejects(
        transcribe({ ...BASE, audio: await readFile(SAMPLE_WAV), url: server.url }),
        (error) => {
          assert.match(error.message, /empty transcript/);
          return true;
        },
      );
    });
  });

  it('times out with its own status rather than hanging', async () => {
    await withServer(() => ({ hang: true }), async (server) => {
      await assert.rejects(
        transcribe({ ...BASE, audio: await readFile(SAMPLE_WAV), url: server.url, timeoutMs: 150 }),
        (error) => {
          assert.equal(error.status, 504);
          assert.equal(error.code, 'codex_timeout');
          assert.match(error.hint, /CODEX_TIMEOUT_MS/);
          return true;
        },
      );
    });
  });

  it('times out on a response that starts and then stalls', async () => {
    // The nastier shape, and the one that used to hang forever: `fetch`
    // resolves as soon as headers arrive, so a deadline that stops there leaves
    // the body read unbounded. Handy sets no client timeout of its own, so the
    // dictation would never finish — not even by falling back to the draft,
    // which is the one guarantee this whole design rests on.
    await withServer(() => ({ stallBody: true }), async (server) => {
      const startedAt = Date.now();

      await assert.rejects(
        transcribe({ ...BASE, audio: await readFile(SAMPLE_WAV), url: server.url, timeoutMs: 120 }),
        (error) => {
          assert.equal(error.status, 504);
          assert.equal(error.code, 'codex_timeout');
          assert.match(error.message, /did not finish its body/);
          return true;
        },
      );

      // The deadline has to actually bound it, not merely be reported later.
      assert.ok(Date.now() - startedAt < 2000, 'the request must end near its deadline');
    });
  });

  it('reports an unreachable endpoint as such', async () => {
    const server = await startFakeTranscribe();
    const url = server.url;
    await server.close();

    await assert.rejects(transcribe({ ...BASE, audio: await readFile(SAMPLE_WAV), url }), (error) => {
      assert.equal(error.status, 502);
      assert.match(error.message, /Cannot reach/);
      // The diagnostic half must survive: `fetch` reports transport failures as
      // a generic "fetch failed" with the real reason on `error.cause`, and it
      // is the cause that says what actually went wrong.
      assert.match(error.message, /ECONNREFUSED/);
      return true;
    });
  });

  it('never quotes the token when the request cannot even be built', async () => {
    // A token corrupted by a stray newline is still a working token to whoever
    // reads it back out of a log. Node refuses the header with
    // `Headers.append: "Bearer <the whole token>" is an invalid header value.`,
    // and that message would otherwise travel into the log, the HTTP response,
    // and /health.
    const secret = 'SECRETTOKENMATERIAL';
    const broken = `eyJhbGciOiJSUzI1NiJ9.${secret}\ntrailing`;

    await withServer(undefined, async (server) => {
      await assert.rejects(
        transcribe({ ...BASE, accessToken: broken, audio: await readFile(SAMPLE_WAV), url: server.url }),
        (error) => {
          assert.equal(error.status, 502);
          assert.ok(!error.detail.includes(secret), 'token material leaked');
          assert.ok(!error.detail.includes('eyJ'), 'token material leaked');
          assert.match(error.message, /could not be built/);
          assert.match(error.hint, /corrupted auth\.json/);
          return true;
        },
      );
      assert.equal(server.requests.length, 0, 'nothing should have reached the endpoint');
    });
  });
});

describe('normalizeLanguage', () => {
  it('drops what the endpoint cannot use', () => {
    assert.equal(normalizeLanguage('auto'), null);
    assert.equal(normalizeLanguage('AUTO'), null);
    assert.equal(normalizeLanguage('  '), null);
    assert.equal(normalizeLanguage(null), null);
  });

  it('folds the script-qualified Chinese tags to zh', () => {
    assert.equal(normalizeLanguage('zh-Hans'), 'zh');
    assert.equal(normalizeLanguage('zh-hant'), 'zh');
    assert.equal(normalizeLanguage('zh-Hans-CN'), 'zh');
  });

  it('passes everything else through untouched', () => {
    assert.equal(normalizeLanguage('en'), 'en');
    assert.equal(normalizeLanguage('ru-RU'), 'ru-RU');
    assert.equal(normalizeLanguage('zh'), 'zh');
  });
});

describe('readAudio', () => {
  it('explains a recording that vanished after being claimed', async () => {
    await assert.rejects(readAudio('/definitely/not/here.wav'), (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, 'recording_read');
      assert.match(error.hint, /retention/);
      return true;
    });
  });
});
