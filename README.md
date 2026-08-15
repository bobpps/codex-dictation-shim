# codex-dictation-shim

A local HTTP server that makes [Handy](https://github.com/cjpais/Handy) dictate through Codex
instead of through its own local Whisper model — without forking Handy, rebuilding it, or editing
a single line of it.

Handy stays an official release and keeps updating itself. The "patch" is two checkboxes in its
settings plus this process, which is entirely ours.

---

## Why

Handy is a good open replacement for Wispr Flow: a real global hotkey, reliable insertion at the
cursor. Its transcription, though, is strictly local — Whisper or Parakeet — and there is no
setting for a custom speech-to-text endpoint. Codex's own dictation is noticeably more accurate,
but it only lives inside the Codex app.

Forking Handy is the obvious move and the wrong one. Handy is Tauri, not Electron: the
transcription logic compiles into a native binary, so there is no `app.asar` to unpack and edit.
That leaves a fork, a Tauri rebuild, and a patch to re-apply against every upstream release.

Instead this uses a supported extension point that happens to be enough.

## How the substitution works

Handy can run a finished transcript through an LLM for post-processing, and it lets you point that
at **any** base URL. Post-processing on its own is useless for our purpose — it is handed text, not
audio. But it runs *after* the WAV is already on disk, and that is the whole trick: the shim can go
and fetch the audio itself.

```
hotkey ─▶ Handy records ─▶ writes recordings/handy-<ts>.wav
                        └▶ local Whisper/Parakeet produces a draft  (this gets thrown away)
                                      │
                                      ▼
        Handy POSTs the draft to http://127.0.0.1:8756/v1/chat/completions
                                      │
                        ┌─────────────┴──────────────┐
                        │  the shim ignores the draft │
                        │  reads the fresh WAV        │
                        │  POSTs it to Codex          │
                        │  returns Codex's text       │
                        └─────────────┬──────────────┘
                                      ▼
                     Handy pastes what it believes is "polished" text
```

**The fallback line.** When post-processing fails for any reason, Handy inserts the original local
transcript — `"Falling back to original transcription"` in `actions.rs`. Network, token, and the
internal endpoint all sit behind that point, so their failure degrades quality back to Whisper but
never eats what you said. That is the safety net system-wide Codex dictation does not have, and it
is why every failure in this shim is answered with an HTTP error rather than a best guess.

**The cost.** Local Whisper still runs, for nothing, before the network call. That is structural,
not a bug. Pick the fastest local model (Parakeet V3) to keep the wasted time small.

## Requirements

- Node ≥ 18.17. No dependencies, no build, no `npm install` — `fetch`, `FormData`, and `Blob` are
  global in modern Node, and the server is `node:http`.
- Handy 0.9.5 or later, installed normally.
- `codex login` completed on this machine with a ChatGPT account. The desktop app is **not**
  required: the CLI writes the same `~/.codex/auth.json` with the same `tokens.*`, and the endpoint
  authorises the account inside the token rather than the client that obtained it.

## Setting it up

### 1. Run the shim

```sh
git clone https://github.com/bobpps/codex-dictation-shim
cd codex-dictation-shim
cp .env.example .env      # optional: every value already defaults to what is in the file
npm start
```

It prints the recordings directory it found and the URL to give Handy. If it cannot find
`recordings/`, it refuses to start rather than failing at your first dictation — set
`HANDY_RECORDINGS_DIR` and try again.

For an always-on setup see [`service/`](service/): launchd for macOS, a systemd user unit for
Linux, a Task Scheduler definition for Windows.

### 2. Configure Handy

No code changes. Settings only:

- **Advanced Settings → Experimental features → enable post-processing.** Upstream marks this
  alpha.
- **Provider `Custom`** — it is the only one whose base URL is editable
  (`allow_base_url_edit: true` in `settings.rs`).
- **Base URL** `http://127.0.0.1:8756/v1`
- **API key** any non-empty string. The shim ignores it; Handy only omits the `Authorization`
  header when the field is empty.
- **Model** anything. The shim serves `/v1/models` so the dropdown has an entry.
- **Recording retention** leave the default `PreserveLimit` with `history_limit` ≥ 1, or the WAV
  can be deleted before the shim reads it.
- **Local model** Parakeet V3, to minimise the idle pass.
- The post-processing **system prompt is irrelevant** — the shim ignores it.

### 3. Check it

```sh
curl -s localhost:8756/health | jq
```

Reports the recordings directory actually in use, whether `auth.json` was found, how much life the
token has left, and the time of the last successful transcription. No token or transcript text ever
appears in that output.

## Configuration

Every value is an environment variable with a working default; `.env` is read at startup and a real
environment variable always wins over it. See [`.env.example`](.env.example) for the annotated list.
The ones that matter most:

| Variable | Default | Why you would change it |
| --- | --- | --- |
| `SHIM_PORT` | `8756` | Port collision. Must match Handy's base URL. |
| `HANDY_RECORDINGS_DIR` | probed | Handy in portable mode, or a non-default data directory. |
| `CODEX_ORIGINATOR` | `codex_desktop` | The endpoint starts rejecting this client string. |
| `CODEX_USER_AGENT` | `Codex Desktop/26.611.62324` | The version pin is a consumable. |
| `MAX_AGE_SEC` | `60` | Very long dictations, or a very slow local model. |
| `SHIM_LOG_TRANSCRIPTS` | `0` | Debugging one specific mismatch. Turn it back off. Also un-redacts unexpected response bodies — see below. |
| `KEEPALIVE_ENABLED` | `1` | You already keep the token fresh some other way. |

The client pin lives in configuration rather than in source on purpose: it is the first thing that
will need changing when old client builds start being turned away, and that should be an edit to a
setting, not to code.

## Design decisions worth knowing before changing anything

**`auth.json` is re-read on every request and never cached.** Codex rewrites the file when it
refreshes the token; a value cached at startup goes stale with no event to notice. That is the
shape of "it quietly stopped working one Tuesday".

**The structured-output field name is read from the incoming request, never hardcoded.** Handy asks
for JSON with one named property and reads that property back out. The name is right there in
`response_format.json_schema.schema.required`, so the shim answers in whatever shape it was asked
for — and survives upstream renaming the field. When there is no schema, it returns bare text,
because Handy's legacy path takes `content` as the finished transcript and would otherwise paste a
JSON document into your editor.

**Three guards on picking the WAV, none optional.** The shim has no request identifier: the history
row does not exist yet (`actions.rs` writes it *after* post-processing), so the filesystem is the
only source and "newest WAV" is a heuristic.

- *Freshness* — nothing older than `MAX_AGE_SEC`.
- *Still being written* — wait until the file stops growing. In the normal path this costs nothing:
  Handy awaits and verifies the WAV before calling post-processing, so the file is already quiet and
  the first `stat` returns immediately.
- *Deduplication* — the same file is never sent twice. Without this, a failure on the second
  dictation resends the first one's audio and pastes the first one's words, and nothing about the
  result looks wrong.

**The recording is claimed before the network call, not after.** Any failure of the structured
request makes Handy call the shim a second time in legacy mode, so one dictation can arrive twice.
Claiming up front turns that second call into a clean guard rejection instead of a second
transcription of the same audio. The trade is deliberate: a transient upstream failure is not
retried inside one dictation, because a lost improvement is visible ("Handy pasted the draft") while
a mis-attributed recording is not.

**Shim failures never answer 400 or 422.** Those two make Handy retry the identical request with its
reasoning fields stripped (`llm_client.rs`), which the shim ignores anyway — pure noise. 400 is
reserved for a body that is not JSON, a case Handy cannot produce.

**No silent `catch` anywhere.** Every failure produces an HTTP error *and* a log line. Silent
degradation here is indistinguishable from "Codex just misheard", and that bug would live for
months.

**An unexpected response body is treated as if it were the transcript.** The response shape is
unverified, so a 200 carrying plain text rather than JSON is possible — and that text would be the
speech. Error messages therefore report a body's status, content type, and length rather than
quoting it, which is enough to tell an HTML interstitial from a JSON error from a transcript.
`SHIM_LOG_TRANSCRIPTS=1` reveals it. The parser's own message is dropped for the same reason:
`JSON.parse` reports failures by quoting the start of its input.

**No refresh flow.** Implementing it would mean racing Codex for ownership of `auth.json` and
impersonating the official client one step further. Instead: a clear error, Handy's fallback, and a
daily `codex login status` keepalive in the same process.

### The ten-day token, and why the keepalive exists

The access token lives ten days — not an hour. But it is only refreshed while a client is running,
and here the CLI differs from the desktop app: the tray app refreshes in the background, the CLI
only when a command runs. On a test box `last_refresh` was a fortnight behind and the token had been
dead for four days simply because nobody had typed `codex`.

So the shim runs `codex login status` at startup and every `KEEPALIVE_INTERVAL_HOURS`, and
`/health` reports the remaining token life. Under launchd or systemd the PATH is minimal — set
`CODEX_CLI_BIN` to an absolute path, or the keepalive silently never runs.

> Whether `codex login status` genuinely refreshes the token, as opposed to only reporting on it,
> is still unverified. If it turns out to only report, `src/keepalive.mjs` is the single place that
> changes.

## Verification

`node --test` covers the contract, the guards, the credential handling, and the whole request path
end to end against a stand-in HTTP server. What it cannot cover is the far end: this repository was
written on a box where `chatgpt.com` answers 403 in 45ms, and Handy is not installed. The steps
below need a real desktop and are the ones that actually prove the feature.

| # | Step | Evidence |
| --- | --- | --- |
| 01 | `node scripts/probe.mjs recording.wav --compare` | Response code and JSON shape from the real endpoint, real token TTL, and whether `originator` matters. Prints status, type, size, and keys; add `--reveal` to print the transcript itself. Rerun with a long recording to find the length limit. |
| 02 | `npm start` then `curl -s localhost:8756/health` | The actual `recordings/` path and a live token. |
| 03 | Drop a known WAV into `recordings/`, POST `/v1/chat/completions` by hand, with a schema and without | Both response shapes, and text that matches the known recording. |
| 04 | Dictate for real | The pasted text differs from the draft in Handy's history, and is better. |
| 05 | Kill the shim and dictate; then corrupt a *copy* of `auth.json` and dictate | Handy pastes the local transcript, not nothing. Second time, the same fallback plus a clear log line. |
| 06 | Two dictations back to back with no pause | The second is not the first one's text. |

For step 03, the dedupe guard will refuse the same file twice by design. `touch` the WAV between
the two calls — a new mtime is a new recording, which is exactly what the guard is keyed on.

```sh
# Step 03, structured mode
curl -s localhost:8756/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"x","messages":[{"role":"user","content":"draft"}],
       "response_format":{"type":"json_schema","json_schema":{"name":"transcription_output",
         "strict":true,"schema":{"type":"object","properties":{"transcription":{"type":"string"}},
         "required":["transcription"],"additionalProperties":false}}}}' | jq

# Step 03, legacy mode
touch "$(ls -t "$RECORDINGS"/*.wav | head -1)"
curl -s localhost:8756/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"x","messages":[{"role":"user","content":"draft"}]}' | jq
```

## Risks and limits

- **Handy's post-processing is alpha.** Upstream can change the request format. Mitigated by reading
  the field name out of the incoming schema rather than assuming it.
- **The endpoint is undocumented** and can change without notice. The client pin is in configuration
  for exactly this reason.
- **Spoofing `originator` and `User-Agent`** is the signal unofficial clients are detected by. The
  risk is operational — action against the account — not legal. Keep this local, keep the repository
  private, do not hand it around.
- **Logs quote dictated speech** if you turn `SHIM_LOG_TRANSCRIPTS` on, and so does
  `probe.mjs --reveal`. They are private correspondence, not build output. The same goes for
  anything pasted into an issue.
- **The endpoint has no authentication.** Handy's API key is ignored, because Handy sends whatever
  string it is given and checking it would prove nothing. That is fine on loopback and not fine
  anywhere else: off `127.0.0.1`, anyone who can reach the port can ask for the transcript of the
  newest recording. The shim warns at startup if `SHIM_HOST` is not a loopback address.
- **The idle Whisper pass never goes away.** It is a property of the design.

## Layout

```
src/
  shim.mjs         HTTP server, routing, response envelope
  auth.mjs         reads ~/.codex/auth.json, decodes the JWT expiry
  handy-paths.mjs  locates recordings/ per platform, by probing
  recording.mjs    picks the WAV and applies the three guards
  codex.mjs        the multipart request to the transcribe endpoint
  keepalive.mjs    the daily `codex login status`
  config.mjs       environment and .env parsing, strict about bad values
  log.mjs          logging, with transcripts redacted by default
  errors.mjs       one error type, carrying the status Handy will see
test/              node --test; real HTTP servers and real directories, not
                   mocks of fetch or fs. The one injected dependency is the
                   child process the keepalive spawns.
service/           launchd, systemd --user, Task Scheduler
scripts/probe.mjs  verification step 01, as a command
.github/           CI: tests on Node 18.17 through 24, plus guards against a
                   tracked .env, auth.json, log, or recording
```

Handy sources this was built against: [`cjpais/Handy`](https://github.com/cjpais/Handy), branch
`main` — `settings.rs`, `llm_client.rs`, `actions.rs`, `managers/history.rs`.
