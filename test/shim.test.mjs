import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../src/config.mjs';
import { createApp } from '../src/shim.mjs';
import {
  handyLegacyRequest,
  handyStructuredRequest,
  makeTempDir,
  recordingLogger,
  removeDir,
  startFakeTranscribe,
  writeAuthFile,
  writeRecording,
} from './helpers.mjs';

/**
 * The whole path, end to end, with only the far end replaced: a real HTTP
 * listener, a real recordings directory, a real `auth.json`, and a real server
 * standing in for `chatgpt.com/backend-api/transcribe`.
 *
 * This is as close as a development box can get to the plan's verification
 * steps 03 through 06 — the endpoint itself answers 403 in 45ms from here, so
 * the one thing that genuinely cannot be exercised is the far end's own
 * behaviour.
 */

async function withShim({ respond, env = {}, recordings = [], auth = {} } = {}, run) {
  const recordingsDir = await makeTempDir('shim-e2e-rec-');
  const codexHome = await makeTempDir('shim-e2e-codex-');
  const upstream = await startFakeTranscribe(respond);

  for (const recording of recordings) {
    await writeRecording(recordingsDir, recording.name, recording);
  }
  if (auth !== null) await writeAuthFile(codexHome, auth);

  const config = loadConfig(
    {
      SHIM_PORT: '0',
      HANDY_RECORDINGS_DIR: recordingsDir,
      CODEX_HOME: codexHome,
      CODEX_TRANSCRIBE_URL: upstream.url,
      KEEPALIVE_ENABLED: '0',
      SETTLE_QUIET_MS: '20',
      SETTLE_POLL_MS: '5',
      SETTLE_TIMEOUT_MS: '300',
      ...env,
    },
    { dotEnvPath: null },
  );

  const logger = recordingLogger();
  const app = await createApp({ config, logger });
  const { port } = await app.listen();
  const base = `http://127.0.0.1:${port}`;

  const call = (path, init) => fetch(`${base}${path}`, init);
  const complete = (body) =>
    call('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer any-non-empty-string' },
      body: JSON.stringify(body),
    });

  try {
    return await run({ app, call, complete, upstream, logger, recordingsDir, codexHome });
  } finally {
    await app.close();
    await upstream.close();
    await removeDir(recordingsDir);
    await removeDir(codexHome);
  }
}

describe('the substitution', () => {
  it('answers a structured request in the shape it was asked for', async () => {
    await withShim(
      { recordings: [{ name: 'handy-1.wav', ageSec: 1 }] },
      async ({ complete, upstream }) => {
        const response = await complete(handyStructuredRequest('whisper heard something else'));
        assert.equal(response.status, 200);

        const payload = await response.json();
        assert.equal(payload.object, 'chat.completion');

        // Handy parses this string as JSON and reads its own field out of it.
        assert.deepEqual(JSON.parse(payload.choices[0].message.content), {
          transcription: 'codex heard this',
        });

        // And the audio genuinely went upstream, rather than the draft text.
        assert.equal(upstream.requests.length, 1);
        assert.ok(upstream.requests[0].body.toString('latin1').includes('RIFF'));
      },
    );
  });

  it('follows a renamed schema field with no code change', async () => {
    await withShim({ recordings: [{ name: 'handy-1.wav', ageSec: 1 }] }, async ({ complete }) => {
      const response = await complete(handyStructuredRequest('draft', 'polished_text'));
      const payload = await response.json();
      assert.deepEqual(JSON.parse(payload.choices[0].message.content), {
        polished_text: 'codex heard this',
      });
    });
  });

  it('answers a legacy request with bare text, not JSON', async () => {
    // Handy's legacy path takes `content` as the finished transcript. Returning
    // JSON here would paste a JSON document into the user's editor.
    await withShim({ recordings: [{ name: 'handy-1.wav', ageSec: 1 }] }, async ({ complete }) => {
      const response = await complete(handyLegacyRequest());
      const payload = await response.json();
      assert.equal(payload.choices[0].message.content, 'codex heard this');
    });
  });

  it('ignores the draft transcript it was sent', async () => {
    await withShim({ recordings: [{ name: 'handy-1.wav', ageSec: 1 }] }, async ({ complete, upstream }) => {
      await complete(handyStructuredRequest('the local model misheard this badly'));
      const body = upstream.requests[0].body.toString('latin1');
      assert.ok(!body.includes('misheard'), 'the draft must not be forwarded anywhere');
    });
  });
});

describe('failing loudly, and falling back', () => {
  it('answers non-2xx so Handy keeps the local transcript', async () => {
    await withShim(
      { respond: () => ({ status: 500, body: { error: 'upstream exploded' } }), recordings: [{ name: 'handy-1.wav', ageSec: 1 }] },
      async ({ complete, logger }) => {
        const response = await complete(handyStructuredRequest());

        assert.equal(response.status, 502);
        const payload = await response.json();
        assert.equal(payload.error.code, 'codex_upstream');
        // Loud: a shim that degrades quietly is indistinguishable from Codex
        // simply mishearing, and that bug survives for months.
        assert.ok(logger.has('error', 'request failed'));
      },
    );
  });

  it('survives Handy calling twice, and never sends the same audio under two requests', async () => {
    // actions.rs falls through to legacy mode whenever structured output fails,
    // which means one dictation can reach the shim twice. The dedupe guard has
    // to make the second call fail cleanly rather than re-transcribe audio the
    // first call already took responsibility for.
    await withShim(
      {
        respond: (_request, count) =>
          count === 1 ? { status: 500, body: 'boom' } : { status: 200, body: { text: 'second chance' } },
        recordings: [{ name: 'handy-1.wav', ageSec: 1 }],
      },
      async ({ complete, upstream }) => {
        const structured = await complete(handyStructuredRequest());
        assert.equal(structured.status, 502);

        const legacy = await complete(handyLegacyRequest());
        assert.equal(legacy.status, 409);
        assert.match((await legacy.json()).error.message, /already sent for transcription/);

        // The retry never reached the endpoint, so there is no second billed
        // call and no chance of an answer landing against the wrong dictation.
        assert.equal(upstream.requests.length, 1);
      },
    );
  });

  it('refuses a second dictation whose recording never appeared', async () => {
    // The dangerous case the dedupe guard exists for: without it, this pastes
    // the previous dictation's words and looks entirely plausible.
    await withShim({ recordings: [{ name: 'handy-1.wav', ageSec: 1 }] }, async ({ complete }) => {
      assert.equal((await complete(handyStructuredRequest())).status, 200);
      assert.equal((await complete(handyStructuredRequest())).status, 409);
    });
  });

  it('accepts the next dictation once a new recording exists', async () => {
    await withShim(
      { recordings: [{ name: 'handy-1.wav', ageSec: 2 }] },
      async ({ complete, recordingsDir }) => {
        assert.equal((await complete(handyStructuredRequest())).status, 200);
        await writeRecording(recordingsDir, 'handy-2.wav', { ageSec: 0 });
        assert.equal((await complete(handyStructuredRequest())).status, 200);
      },
    );
  });

  it('refuses a stale recording without calling the endpoint', async () => {
    await withShim(
      { recordings: [{ name: 'handy-old.wav', ageSec: 3600 }] },
      async ({ complete, upstream }) => {
        const response = await complete(handyStructuredRequest());
        assert.equal(response.status, 409);
        assert.match((await response.json()).error.message, /older than MAX_AGE_SEC/);
        assert.equal(upstream.requests.length, 0, 'no audio should leave the machine');
      },
    );
  });

  it('refuses without credentials, and says which command fixes it', async () => {
    await withShim(
      { auth: null, recordings: [{ name: 'handy-1.wav', ageSec: 1 }] },
      async ({ complete, upstream }) => {
        const response = await complete(handyStructuredRequest());
        assert.equal(response.status, 503);
        assert.match((await response.json()).error.message, /codex login/);
        assert.equal(upstream.requests.length, 0);
      },
    );
  });

  it('refuses an expired token before touching the network', async () => {
    await withShim(
      { auth: { expiresInSec: -86_400 }, recordings: [{ name: 'handy-1.wav', ageSec: 1 }] },
      async ({ complete, upstream }) => {
        const response = await complete(handyStructuredRequest());
        assert.equal(response.status, 503);
        assert.match((await response.json()).error.message, /codex login status/);
        assert.equal(upstream.requests.length, 0);
      },
    );
  });

  it('never answers 400 or 422 for its own failures', async () => {
    // Those two statuses make Handy retry the identical request with the
    // reasoning fields stripped (llm_client.rs). The shim ignores those fields,
    // so the retry can only fail the same way — noise, and one more pass over
    // the guards.
    await withShim({ recordings: [] }, async ({ complete }) => {
      const response = await complete(handyStructuredRequest());
      assert.equal(response.status, 409);
      assert.ok(![400, 422].includes(response.status));
    });
  });

  it('keeps 400 for a body that is not JSON at all', async () => {
    await withShim({}, async ({ call }) => {
      const response = await call('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'invalid_request');
    });
  });

  it('refuses a body larger than the limit', async () => {
    await withShim({ env: { MAX_BODY_BYTES: '2048' } }, async ({ call }) => {
      const response = await call('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(5000) }] }),
      });
      assert.equal(response.status, 413);
    });
  });
});

describe('privacy of the log', () => {
  it('records lengths, not what was said', async () => {
    await withShim(
      { recordings: [{ name: 'handy-1.wav', ageSec: 1 }] },
      async ({ complete, logger }) => {
        await complete(handyStructuredRequest('a sentence nobody else should read'));

        const serialized = JSON.stringify(logger.lines);
        assert.ok(!serialized.includes('nobody else should read'), 'the draft must stay out of the log');
        assert.ok(!serialized.includes('codex heard this'), 'the transcript must stay out of the log');
        assert.ok(logger.has('info', 'dictation transcribed'));
      },
    );
  });

  it('keeps an unexpected response body out of the log and out of /health', async () => {
    // The endpoint's response shape is unverified, so a 200 carrying plain text
    // rather than JSON is possible — and that text is the speech. It must not
    // reach the log, `lastError`, or `/health` with the privacy switch off.
    const spoken = 'something private that was dictated out loud';

    await withShim(
      {
        respond: () => ({ status: 200, body: spoken, contentType: 'text/plain' }),
        recordings: [{ name: 'handy-1.wav', ageSec: 1 }],
      },
      async ({ complete, call, logger }) => {
        const response = await complete(handyStructuredRequest());
        assert.equal(response.status, 502);

        const errorBody = await response.text();
        const health = await (await call('/health')).text();

        for (const [where, text] of [
          ['the shim\'s own error response', errorBody],
          ['the log', JSON.stringify(logger.lines)],
          ['/health', health],
        ]) {
          // Every eight-character run, not just the whole sentence: the leak
          // that survived the first review round was a fragment.
          for (let at = 0; at + 8 <= spoken.length; at += 1) {
            const fragment = spoken.slice(at, at + 8);
            assert.ok(!text.includes(fragment), `speech fragment "${fragment}" leaked into ${where}`);
          }
        }

        // Still diagnosable: the shape survives redaction.
        assert.match(errorBody, /text\/plain/);
      },
    );
  });
});

describe('diagnostics', () => {
  it('reports a healthy shim in one curl', async () => {
    await withShim({ recordings: [{ name: 'handy-1.wav', ageSec: 1 }] }, async ({ call, complete }) => {
      await complete(handyStructuredRequest());
      const response = await call('/health');
      assert.equal(response.status, 200);

      const health = await response.json();
      assert.equal(health.status, 'ok');
      assert.equal(health.recordings.readable, true);
      assert.equal(health.recordings.wavCount, 1);
      assert.equal(health.auth.ok, true);
      assert.ok(health.auth.expiresInSec > 0);
      assert.equal(health.lastTranscription.chars, 'codex heard this'.length);
      assert.equal(health.lastTranscription.file, 'handy-1.wav');
      assert.equal(health.guards.lastClaim.file, 'handy-1.wav');
    });
  });

  it('answers 503 when it could not do its job right now', async () => {
    await withShim({ auth: null }, async ({ call }) => {
      const response = await call('/health');
      assert.equal(response.status, 503);

      const health = await response.json();
      assert.equal(health.status, 'degraded');
      assert.equal(health.auth.ok, false);
      assert.match(health.auth.error, /No Codex credentials/);
    });
  });

  it('keeps no secrets in the health payload', async () => {
    await withShim({}, async ({ call }) => {
      const body = await (await call('/health')).text();
      assert.ok(!body.includes('eyJ'), 'no JWT segment may appear');
      assert.ok(!body.includes('refresh-token-value'));
    });
  });

  it('records the last failure for later reading', async () => {
    await withShim({ recordings: [] }, async ({ call, complete }) => {
      await complete(handyStructuredRequest());
      const health = await (await call('/health')).json();
      assert.equal(health.lastError.code, 'recording_guard');
      assert.match(health.lastError.message, /No \.wav files/);
    });
  });

  it('lists a model so Handy\'s settings screen has something to show', async () => {
    await withShim({}, async ({ call }) => {
      const response = await call('/v1/models');
      assert.equal(response.status, 200);
      assert.equal((await response.json()).data[0].id, 'codex-dictation-shim');
    });
  });

  it('explains a wrong base URL instead of a bare 404', async () => {
    await withShim({}, async ({ call }) => {
      const response = await call('/v1/completions', { method: 'POST', body: '{}' });
      assert.equal(response.status, 404);
      assert.match((await response.json()).error.message, /base URL/);
    });
  });
});
