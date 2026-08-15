# AGENTS.md

Shared instructions for Codex and other coding agents working in this repository.

## Communication

Reply to the user in Russian, in plain language, whatever language the question was asked in.
Switch languages only when the user asks for it.

Plain language means explaining the thing rather than naming it. Keep the technical terms that have
no honest Russian equivalent — post-processing, structured output, pull request, access token — and
explain what they do the first time they matter. Do not simplify by dropping a constraint, a
trade-off, or a risk.

Code, identifiers, comments, commit messages, branch names, pull request titles and bodies, issue
text, and all repository documentation stay in English.

## What this is

A local HTTP server that pretends to be an OpenAI-compatible LLM provider so that Handy's
post-processing step can be used to swap Handy's local transcript for Codex dictation. Read
`README.md` before changing anything: it carries the reasoning behind the decisions below, and most
of those decisions look arbitrary until you know what they are defending against.

Handy is **not** modified. If a change would require patching, forking, or rebuilding Handy, it is
out of scope for this repository.

## Constraints that are not up for casual revision

- **No dependencies.** `fetch`, `FormData`, `Blob`, and `node:http` are enough. No dependency means
  no build, no `npm install`, and a shim that runs anywhere Node does. CI fails if `node_modules` or
  a lockfile appears.
- **`auth.json` is read on every request and never cached.** Codex rewrites it on refresh.
- **The structured-output field name comes from the incoming request.** Never hardcode
  `transcription`.
- **All three recording guards stay.** Freshness, still-being-written, and deduplication. The third
  is the one whose absence produces a wrong transcript that looks right.
- **No silent `catch`.** Every failure returns an HTTP error *and* logs. A non-2xx is what makes
  Handy fall back to the local transcript, which is the designed safety net.
- **Shim-side failures never use 400 or 422.** Those trigger a pointless retry in Handy.
- **No token refresh flow.** It would mean racing Codex for `auth.json`.

## Privacy

Dictated speech is personal. Transcripts are redacted from logs unless `SHIM_LOG_TRANSCRIPTS=1`, and
`/health` reports lengths and filenames rather than text. Do not add a code path that logs, stores,
or returns transcript text by default, and do not put real transcripts in tests, issues, or commit
messages.

`.env`, `auth.json`, `*.wav` outside `test/fixtures/`, and `*.log` are ignored by git, and CI refuses
any tracked file that `.gitignore` excludes — it asks `git check-ignore` rather than keeping a second
copy of the rules, so adding a rule to `.gitignore` is all that is needed. Do not reintroduce a
restated list: one was tried and drifted out of step three times.

## Tests

`node --test`. The suite stands up real HTTP servers and real temporary directories instead of
mocking `fetch` or `fs` — what goes over the wire is the thing worth asserting on. Keep it that way.
The single injected dependency is the child process the keepalive spawns, because spawning the real
`codex` binary in a test would depend on a login this repository must never assume.

Fixtures are created and removed inside the test that uses them, not in file-level `before` hooks:
those only became reliable in Node 20, and this project supports 18.17.

Four things cannot be tested here and must not be claimed as verified: the real endpoint's response
shape, its audio-length limit, whether `codex login status` refreshes the token, and anything
involving Handy actually running. `README.md` lists them as verification steps 01–06 for a machine
that has a microphone and network access.
