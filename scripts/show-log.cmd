@echo off
rem Opens a window that follows logs\shim.log live. Closing this window does
rem not stop the shim; it only stops watching.
cd /d "%~dp0.."
if not exist logs\shim.log (
  echo logs\shim.log does not exist yet. Is the shim running through scripts\start-hidden.cmd?
  pause
  exit /b 1
)
powershell.exe -NoLogo -NoProfile -NoExit -Command "$Host.UI.RawUI.WindowTitle = 'codex-dictation-shim log'; Get-Content -LiteralPath 'logs\shim.log' -Encoding UTF8 -Tail 50 -Wait"
