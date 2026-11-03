@echo off
rem Runs the shim with no console window and appends its output to
rem logs\shim.log, so the service can be watched without being closable.
rem
rem Task Scheduler action (no quotes needed when WorkingDirectory is the repo):
rem   Execute:          C:\Windows\System32\conhost.exe
rem   Arguments:        --headless cmd.exe /c scripts\start-hidden.cmd C:\path\to\node.exe
rem   WorkingDirectory: the repository root
rem
rem The optional first argument is the node executable. Task Scheduler starts
rem processes with the machine PATH, not the one from a shell profile, so an
rem absolute path is the reliable choice. Without it, "node" from PATH is used.
rem
rem The log is private: with SHIM_LOG_TRANSCRIPTS=1 it quotes dictated speech.
rem logs/ is ignored by git.

setlocal
cd /d "%~dp0.."

set "NODE_BIN=%~1"
if "%NODE_BIN%"=="" set "NODE_BIN=node"

if not exist logs mkdir logs

rem Keep one previous log once the current one passes about 5 MB.
if exist logs\shim.log for %%F in (logs\shim.log) do if %%~zF GTR 5000000 move /y logs\shim.log logs\shim.log.1 >nul

"%NODE_BIN%" src\shim.mjs >> logs\shim.log 2>&1
