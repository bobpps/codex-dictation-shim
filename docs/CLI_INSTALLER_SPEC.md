# Cross-Platform CLI Installer Specification

Status: Draft for implementation

## 1. Summary

Add a command-line installer for `codex-dictation-shim` that can take a non-technical user from a mostly clean desktop machine to a working, automatically started shim with as little manual setup as possible.

The first version is intentionally not a native GUI installer. The user should only need to open PowerShell or a terminal, paste one documented command, and follow any unavoidable OS/account prompts.

Target platforms:

- Windows 11 (x64 first, ARM64 where supported by dependencies)
- macOS (Apple Silicon and Intel)
- Linux desktop (Ubuntu/Debian first; Fedora/RHEL-family next; generic AppImage fallback for Handy)

The installer must use the official Handy release. It must not patch, fork, rebuild, or replace Handy.

## 2. User experience goal

### Windows

```powershell
irm https://raw.githubusercontent.com/bobpps/codex-dictation-shim/main/install.ps1 | iex
```

### macOS / Linux

```sh
curl -fsSL https://raw.githubusercontent.com/bobpps/codex-dictation-shim/main/install.sh | sh
```

The exact public bootstrap URLs can change before release, but the one-command experience is the product requirement.

A successful run should look approximately like this:

```text
Codex Dictation Shim Installer

[1/8] Checking Handy...
      Handy not found. Installing official Handy release...
      OK Handy installed

[2/8] Checking Node.js...
      OK Node.js 22.x available

[3/8] Checking Codex CLI...
      OK Codex CLI found

[4/8] Checking Codex login...
      OK ChatGPT account is authenticated

[5/8] Installing codex-dictation-shim...
      OK Installed

[6/8] Configuring Handy...
      OK Existing settings backed up
      OK Post-processing configured

[7/8] Enabling autostart...
      OK Enabled

[8/8] Starting and verifying...
      OK /health passed

Installation complete.
Codex Dictation Shim will start automatically when you sign in.
```

The installer must explain manual actions in plain language and only when they are actually required.

## 3. Goals

1. Provide one bootstrap command per shell family:
   - `install.ps1` for Windows.
   - `install.sh` for macOS and Linux.
2. Detect whether Handy is installed.
3. If Handy is missing, install the official Handy release automatically where practical.
4. Ensure Node.js >= 18.17 is available to the shim.
5. Detect the Codex CLI and Codex authentication state.
6. Help install the Codex CLI if it is missing, using an official/supported installation path.
7. Stop and request user login if Codex authentication is missing; do not attempt to automate account authentication.
8. Install a local copy of this repository without requiring Git.
9. Configure Handy for the shim without modifying Handy binaries or source code.
10. Configure per-user autostart:
    - Windows Task Scheduler.
    - macOS LaunchAgent.
    - Linux systemd user service.
11. Start the shim immediately after installation.
12. Verify the installation using `/health`.
13. Be safe to run more than once.
14. Preserve user settings and provide rollback data before changing Handy configuration.

## 4. Non-goals for the first version

The first version does not need:

- A GUI installer.
- A tray/menu-bar application.
- A self-update daemon.
- Automatic modification of Handy binaries.
- A Handy fork.
- Background Codex account login automation.
- Support for every Linux distribution.
- Installation as a system-wide/root service.
- A standalone Node SEA binary.

A future native installer may reuse the same setup logic.

## 5. Architecture

Keep platform bootstrap logic thin and keep shared setup logic in Node.js.

```text
install.ps1                   install.sh
    |                         /       \
    |                    macOS       Linux
    |                         \       /
    +--------------------------+-----+
                               |
                     ensure usable Node runtime
                               |
                               v
                  scripts/install/setup.mjs
                               |
       +-----------------------+-----------------------+
       |                       |                       |
   detect/install          configure                verify
      Handy                Handy                   system
       |                       |                       |
       +----------- install shim files ---------------+
                               |
                      configure autostart
                               |
                         start + /health
```

Rationale:

- PowerShell should only contain Windows bootstrap/platform operations.
- POSIX shell should only contain macOS/Linux bootstrap/platform operations.
- Dependency detection, paths, Handy settings backup/patching, installation state, diagnostics, and health verification should not be implemented three times.
- The repository already requires Node.js and has no runtime npm dependencies, so Node is the natural shared implementation language.

## 6. Installation directories

Use per-user locations by default to avoid administrator/root requirements.

### Windows

```text
%LOCALAPPDATA%\CodexDictationShim\
```

Suggested layout:

```text
CodexDictationShim\
  app\
  runtime\                 # only if a private Node runtime is needed
  backup\
  logs\
  install-state.json
```

### macOS

```text
~/Library/Application Support/CodexDictationShim/
```

Logs may live in:

```text
~/Library/Logs/CodexDictationShim/
```

### Linux

```text
${XDG_DATA_HOME:-~/.local/share}/codex-dictation-shim/
```

State/logs:

```text
${XDG_STATE_HOME:-~/.local/state}/codex-dictation-shim/
```

## 7. Repository installation

Git must not be a prerequisite.

The bootstrap should download a source archive from GitHub and unpack it into the application directory. The implementation should support an install ref so development/testing can target a branch or tag without editing the script.

Example concept:

```text
CODEX_DICTATION_SHIM_REF=main
```

For production releases, prefer installing a tagged version rather than an unpinned moving branch.

Do not run `npm install`; the project intentionally has no runtime dependencies.

## 8. Node.js handling

The shim requires Node.js >= 18.17.

Order of preference:

1. Use an existing Node executable if its version is supported.
2. If Node is missing or too old, install/download a private Node runtime into the shim installation directory.
3. Do not replace or upgrade the user's global Node installation unless the user explicitly chooses that behavior in a future version.

A private runtime is preferred over installing system-wide Node because it:

- avoids administrator/root privileges;
- does not change the user's development environment;
- provides a stable executable path for autostart;
- behaves consistently across platforms.

When downloading a Node archive, verify it against the checksum published by the official Node distribution before using it.

The generated autostart entry must use the exact Node executable selected by the installer, not assume `node` will be available in the service PATH.

## 9. Handy detection and installation

### 9.1 General requirements

Handy 0.9.5 or later is required.

The installer must:

1. Detect an existing Handy installation before attempting to install anything.
2. Preserve an existing compatible installation.
3. Never downgrade Handy automatically.
4. If Handy is missing, install an official release.
5. After installation, verify that Handy can be located.
6. Launch Handy when first-run initialization/system permissions are required.

The current Handy documentation requires the user to launch Handy and grant system permissions such as microphone/accessibility access. Those permission prompts are considered unavoidable manual steps.

### 9.2 Windows

Preferred strategy:

1. Detect Handy in common application locations / installed-app metadata.
2. If missing and `winget` is available, use the Handy package (`cjpais.Handy`).
3. If `winget` is unavailable or installation fails, resolve and download the matching official asset from the latest Handy GitHub release and install it.

The installer must not assume a fixed Handy version. Asset selection should be based on platform + architecture + supported installer extension.

### 9.3 macOS

Preferred strategy:

1. Detect `Handy.app` in `/Applications`, `~/Applications`, and known application locations.
2. If missing and Homebrew is already installed, `brew install --cask handy` is acceptable.
3. Do not install Homebrew only for this purpose.
4. Without Homebrew, download the correct official Handy `.dmg`, mount it, and install/copy `Handy.app` to an appropriate application directory.
5. Launch Handy so macOS can request the required microphone/accessibility permissions.

The script must not attempt to bypass macOS security/privacy permission prompts.

### 9.4 Linux

Detect distribution and architecture.

Initial package preference:

- Debian/Ubuntu: official `.deb` asset.
- Fedora/RHEL-family: official `.rpm` asset.
- Other supported desktop distributions: official Handy AppImage where practical.

The installer should also detect/report Handy's desktop input prerequisites when relevant (for example X11/Wayland helpers). Distribution-specific dependency handling should fail with a clear message rather than leaving a partially working installation without explanation.

## 10. Handy first-run and settings file lifecycle

A fresh Handy installation may not have created its settings store or recordings directory yet.

Therefore the installer must support this sequence:

1. Install Handy if needed.
2. Launch Handy.
3. Explain that the user may need to grant microphone/accessibility permissions.
4. Wait/poll for Handy's application data/settings location to appear, with a reasonable timeout.
5. If configuration cannot safely continue while Handy is running, ask the user to close Handy and detect when the process exits.
6. Back up the settings file before editing it.
7. Patch only the known settings required by the shim.
8. Relaunch Handy if appropriate.

Do not silently create a guessed Handy settings file when the expected upstream state has never been initialized.

## 11. Handy configuration

The installer is allowed to configure Handy settings, but not modify Handy itself.

Required effective configuration:

- experimental features enabled as needed for post-processing;
- post-processing enabled;
- provider set to `Custom`;
- Custom provider base URL set to `http://127.0.0.1:8756/v1`;
- non-empty API key value supplied because Handy expects one;
- a model value selected/available for the Custom provider;
- recording retention configured so at least one recent WAV remains available to the shim.

The shim ignores the post-processing system prompt and model semantics, so the installer should avoid changing unrelated user choices.

Local transcription model selection (for example choosing Parakeet V3 to minimize the otherwise wasted local transcription pass) is an optimization, not a required destructive change. The first version should either:

- leave the user's existing local model unchanged; or
- offer the optimization clearly and separately.

### 11.1 Safe modification rules

Before changing Handy configuration:

1. Locate the actual settings store rather than constructing an unverified path.
2. Parse the existing data successfully.
3. Verify that the expected settings structure is present.
4. Save a timestamped backup.
5. Record the original values of every field changed by the installer in `install-state.json`.
6. Modify only known fields.
7. Write atomically (temporary file + replace where supported).
8. Re-read and validate the result.

If the Handy settings schema is not recognized, stop automatic configuration and print the manual settings required. Never overwrite an unknown schema with a newly generated object.

## 12. Codex CLI handling

The shim requires a valid Codex login on the machine.

Installer behavior:

1. Detect `codex` in PATH and common installation locations.
2. If absent, install the Codex CLI using the current official supported installation method.
3. Persist the exact executable path for the shim keepalive/autostart environment (`CODEX_CLI_BIN`) where necessary.
4. Check authentication using a non-destructive Codex login/status command and/or the expected auth file.
5. If authentication is missing, run or instruct `codex login` and wait for the user to complete the browser/account flow.
6. Re-check authentication before continuing.

The installer must never read, print, upload, copy into logs, or commit access/refresh token values.

## 13. Autostart

Autostart is per-user.

### Windows

Use Task Scheduler, based on the existing service template.

Required behavior:

- trigger at user logon;
- run only for the current user;
- no fixed execution timeout;
- ignore duplicate concurrent launches;
- restart on failure;
- use absolute paths to Node, shim entry point, working directory, and Codex CLI where required.

The installer must generate/register the task using actual resolved paths rather than the placeholder paths in the checked-in template.

### macOS

Use a LaunchAgent in:

```text
~/Library/LaunchAgents/
```

Required behavior:

- `RunAtLoad`;
- keep/restart the process;
- absolute executable paths;
- predictable log files;
- explicit environment/PATH where needed.

Use modern `launchctl bootstrap`/`bootout` style commands where supported.

### Linux

Use a `systemd --user` unit in:

```text
~/.config/systemd/user/
```

Then:

```sh
systemctl --user daemon-reload
systemctl --user enable --now codex-dictation-shim.service
```

Do not enable system-wide services or `loginctl enable-linger` by default. The desktop use case only requires the service while the user is signed in.

## 14. Start and health verification

After registration:

1. Start/restart the shim.
2. Poll `http://127.0.0.1:8756/health` for a bounded period.
3. Require HTTP success.
4. Validate at least:
   - recordings directory resolved;
   - Codex auth was found;
   - shim is answering on loopback.
5. Print a concise success/failure summary.

A failed health check must make the installer exit non-zero and explain the next action.

Do not print token contents or transcript text.

## 15. Idempotency and repair behavior

Running the installer a second time must be safe.

It should distinguish:

- already installed and healthy;
- installed but configuration drifted;
- dependency missing;
- autostart missing/broken;
- application files outdated;
- Handy settings no longer match;
- Codex authentication missing/expired.

The first implementation may expose repair as re-running the install command. A later dedicated command can be added:

```text
codex-dictation-shim doctor
codex-dictation-shim repair
```

The implementation should be structured so those commands can reuse the same checks.

## 16. Rollback and uninstall data

Even if a full uninstall command is deferred, installation must save enough state to undo its changes safely.

`install-state.json` should contain non-secret metadata such as:

- installer/schema version;
- installed shim version/ref;
- install directory;
- Node executable selected;
- whether the private Node runtime was installed by us;
- Handy installation detection result;
- Handy settings backup path;
- original Handy fields changed by the installer;
- autostart mechanism/name/path;
- Codex CLI path (never tokens);
- installation timestamp.

Do not store transcripts or Codex tokens.

## 17. Security and privacy requirements

1. Keep the shim bound to loopback by default.
2. Never expose `auth.json` contents.
3. Never log dictated transcript text during installation.
4. Never enable `SHIM_LOG_TRANSCRIPTS=1` automatically.
5. Verify downloaded Node artifacts with official checksums.
6. Prefer HTTPS downloads from official project/origin URLs.
7. Treat downloaded Handy binaries as third-party official artifacts; do not mirror modified copies as part of the first implementation.
8. Do not make unrelated changes to Handy preferences.
9. Do not require administrator/root access unless an OS package installation genuinely requires it; prefer per-user installation/runtime paths.
10. On any uncertain settings migration/schema case, fail safe and provide manual configuration instructions.

## 18. Error handling

Every failed installation stage must include:

- what failed;
- whether anything was already changed;
- whether the user can safely rerun the installer;
- the next recommended action;
- a non-zero exit code.

Suggested stage-level errors:

- unsupported OS/architecture;
- network/download failure;
- checksum mismatch;
- Handy install/detection failure;
- Handy not initialized;
- unknown Handy settings schema;
- Node unavailable;
- Codex CLI install/detection failure;
- Codex login incomplete;
- autostart registration failure;
- shim process failed to start;
- `/health` failed.

Do not swallow errors and continue to print `Installation complete`.

## 19. Logging

Console output should be readable by non-technical users.

A detailed installer log should also be written to the application's log/state directory for debugging.

The detailed log may contain:

- versions;
- paths;
- command exit codes;
- package/release asset names;
- health metadata that is already safe to expose.

It must not contain:

- transcripts;
- WAV contents;
- access tokens;
- refresh tokens;
- authorization headers;
- full secret-bearing `auth.json` content.

## 20. Testing strategy

### Automated tests

Shared Node installer helpers should be testable with `node --test` and follow the repository's existing testing style.

Test at minimum:

- platform/architecture normalization;
- Node version acceptance/rejection;
- installation path resolution;
- Handy settings detection;
- Handy settings patch preserves unrelated fields;
- unknown Handy schema fails safely;
- backup creation;
- install-state serialization excludes secrets;
- repeated configuration is idempotent;
- autostart template rendering uses resolved absolute paths;
- health polling success/timeout;
- release asset selection from fixture metadata.

Do not spawn the real Codex CLI or require a real Handy installation in CI.

### CI smoke tests

Add OS-matrix smoke tests for installer code where practical:

- Windows runner: PowerShell parsing/platform functions and generated Task Scheduler configuration.
- macOS runner: shell/bootstrap syntax and LaunchAgent generation.
- Ubuntu runner: shell/bootstrap syntax and systemd unit generation.

Do not let CI actually change the runner's desktop autostart or install Handy unless a dedicated isolated test proves safe.

### Manual verification matrix

At least one real desktop test per supported OS before calling the installer production-ready:

1. Clean-ish machine with Handy absent.
2. Handy already installed and configured by the user.
3. Node absent.
4. Old Node present.
5. Codex CLI absent.
6. Codex installed but not logged in.
7. Re-run installer after successful installation.
8. Reboot/log out + log in and verify autostart.
9. Kill shim process and verify service restart behavior.
10. Dictate through Handy and verify Codex text is pasted.
11. Disable/break network/Codex temporarily and verify Handy still falls back to its local transcript.

## 21. Acceptance criteria

The feature is complete for a platform when all of the following are true:

- A non-technical user can start setup by copying one documented command.
- Git is not required.
- npm package installation for the shim is not required.
- Handy is detected or installed automatically from an official distribution path.
- A usable Node runtime is detected or provisioned automatically.
- Codex CLI presence is checked.
- Missing Codex login is handled with a clear user-driven login step.
- Handy is initialized and its required shim settings are configured safely.
- Original Handy settings are backed up before modification.
- Shim files are installed in a stable per-user path.
- Autostart is registered using the platform-native per-user mechanism.
- Shim starts immediately.
- `/health` passes at the end of setup.
- Re-running the installer does not duplicate services/tasks or corrupt settings.
- Reboot/logoff-login results in the shim running automatically.
- No transcripts or Codex secrets are written to installer logs.

## 22. Task decomposition

The task IDs below are intended to map cleanly to implementation issues/PRs.

### INST-01 — Installer foundations

Create the installer directory/module structure and shared conventions.

Deliverables:

- `install.ps1` entry point.
- `install.sh` entry point.
- `scripts/install/setup.mjs` shared orchestrator.
- platform/architecture normalization.
- install directory/state/log path helpers.
- consistent console output and exit handling.

Acceptance:

- both bootstrap scripts can invoke the shared setup in a dry-run/development mode;
- unsupported OS/architecture fails clearly.

### INST-02 — Node runtime bootstrap

Implement Node detection and private runtime provisioning.

Deliverables:

- detect Node and parse version;
- accept >= 18.17;
- download supported private Node runtime if needed;
- verify official checksum;
- persist exact Node path.

Acceptance:

- works with no global Node;
- does not overwrite/upgrade an existing global Node installation;
- autostart can use the selected Node path.

### INST-03 — Shim source installation

Install repository files without Git/npm install.

Deliverables:

- download source archive for configured ref/version;
- unpack atomically to application directory;
- preserve installer-owned state/backups/logs across repair/update;
- support re-run.

Acceptance:

- Git is not required;
- `npm install` is never run;
- installed `node src/shim.mjs` can start from the destination.

### INST-04 — Handy detection and release resolver

Build cross-platform Handy detection and official release asset resolution.

Deliverables:

- detect installed Handy + version when possible;
- query/parse upstream release metadata;
- map OS/architecture to an appropriate official asset/package path;
- reject unsupported/ambiguous assets safely.

Acceptance:

- existing compatible Handy is preserved;
- installer never intentionally downgrades Handy;
- resolver has fixture-based tests.

### INST-05 — Windows Handy installation

Implement Windows Handy bootstrap.

Deliverables:

- use existing Handy if found;
- prefer `winget install cjpais.Handy` when available;
- implement official-release fallback;
- detect success after installation;
- launch Handy for first-run permissions/setup.

Acceptance:

- tested on Windows 11 with Handy absent and Handy pre-installed.

### INST-06 — macOS Handy installation

Implement macOS Handy bootstrap.

Deliverables:

- detect existing `Handy.app`;
- use Homebrew cask only if Homebrew already exists;
- otherwise use official `.dmg` flow;
- support Apple Silicon and Intel;
- launch Handy for macOS permission prompts.

Acceptance:

- no requirement to install Homebrew;
- tested on at least one Apple Silicon Mac; Intel path validated or tested separately.

### INST-07 — Linux Handy installation

Implement Linux Handy bootstrap.

Deliverables:

- distro/architecture detection;
- `.deb` path for Debian/Ubuntu;
- `.rpm` path for Fedora/RHEL-family;
- AppImage fallback where supported;
- check/report relevant desktop input dependencies.

Acceptance:

- Ubuntu/Debian path tested end-to-end first;
- unsupported distributions get actionable output instead of partial silent setup.

### INST-08 — Handy initialization and configuration

Implement safe settings discovery, backup, and patching.

Deliverables:

- locate Handy settings store;
- handle fresh install where settings do not yet exist;
- launch/wait for Handy initialization;
- require Handy to be in a safe state before file edits;
- back up settings;
- patch only required post-processing fields;
- validate written settings;
- record original values in install state.

Acceptance:

- unknown schema is not overwritten;
- unrelated Handy settings survive byte-for-value/semantic comparison as applicable;
- repeated run is idempotent;
- manual fallback instructions are printed when automatic patching is unsafe.

### INST-09 — Codex CLI detection/install/login gate

Implement Codex prerequisite handling.

Deliverables:

- locate Codex CLI;
- install via current official method if missing;
- persist exact `CODEX_CLI_BIN` path where needed;
- detect login state without exposing secrets;
- launch/instruct `codex login` when needed;
- re-check after login.

Acceptance:

- no auth token is printed/logged;
- installer cannot finish successfully while required Codex authentication is absent.

### INST-10 — Windows autostart

Generate/register the current-user Scheduled Task using resolved paths.

Deliverables:

- logon trigger;
- no execution time limit;
- restart-on-failure;
- duplicate-instance protection;
- start/stop/re-register behavior for repair runs.

Acceptance:

- re-running installer does not create duplicate tasks;
- reboot/login starts the shim automatically.

### INST-11 — macOS autostart

Generate/register a per-user LaunchAgent.

Deliverables:

- generated plist with absolute paths;
- `RunAtLoad` + keepalive/restart behavior;
- log paths;
- bootstrap/bootout repair logic.

Acceptance:

- log out/in starts the shim automatically;
- re-run does not leave duplicate/stale agents.

### INST-12 — Linux autostart

Generate/register a `systemd --user` unit.

Deliverables:

- unit with absolute paths;
- restart behavior;
- `daemon-reload` + `enable --now`;
- repair/re-registration support.

Acceptance:

- desktop login starts the shim automatically;
- no root/system service is required.

### INST-13 — Health verification and installer diagnostics

Implement end-of-install validation.

Deliverables:

- bounded process startup wait;
- `/health` polling;
- safe health validation;
- stage summary;
- detailed redacted log;
- non-zero failure exit.

Acceptance:

- success is only printed after health passes;
- logs contain no tokens/transcripts.

### INST-14 — Idempotency, repair state, rollback metadata

Make re-running installation safe.

Deliverables:

- `install-state.json` schema;
- detect previous installation;
- preserve backups;
- repair drifted autostart/configuration;
- store enough original Handy settings to support a future uninstall/restore command.

Acceptance:

- install -> install again results in one healthy service/task and valid Handy configuration;
- interrupted installation can be re-run safely.

### INST-15 — Cross-platform CI and installer tests

Add tests without requiring real Handy/Codex credentials.

Deliverables:

- Node unit/integration tests for shared setup helpers;
- fixture release metadata;
- Windows/macOS/Linux CI matrix for generation/bootstrap smoke tests;
- privacy guard tests for installer state/log output.

Acceptance:

- CI does not require a Codex login or real microphone;
- installer logic changes cannot silently break another supported OS.

### INST-16 — Documentation and manual verification

Document the user-facing setup and verify it on real desktops.

Deliverables:

- README one-command installation section;
- explanation of unavoidable Handy permission prompts and Codex login;
- troubleshooting/re-run guidance;
- manual verification checklist results for Windows, macOS, and Ubuntu/Debian.

Acceptance:

- a user unfamiliar with Node/Git/npm can follow the README without installing developer tooling manually.

## 23. Suggested implementation order

Recommended sequence:

```text
Phase 1 — Shared MVP
INST-01 -> INST-02 -> INST-03 -> INST-08 -> INST-09 -> INST-13 -> INST-14

Phase 2 — Windows first end-to-end path
INST-04 -> INST-05 -> INST-10

Phase 3 — macOS
INST-06 -> INST-11

Phase 4 — Linux
INST-07 -> INST-12

Phase 5 — Hardening/release
INST-15 -> INST-16
```

Windows is the best first end-to-end platform because Task Scheduler support already exists in this repository and Handy has a straightforward winget path. The shared implementation must still be platform-neutral so macOS and Linux do not become rewrites.

## 24. Future follow-ups

Not part of this specification's MVP, but the architecture should leave room for:

- `doctor` command;
- `repair` command;
- `uninstall` with Handy settings restoration;
- automatic update command;
- native Windows/macOS/Linux installers;
- standalone executable builds that remove the Node runtime requirement;
- optional tray/menu-bar status UI.
