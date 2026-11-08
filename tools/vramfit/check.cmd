@echo off
setlocal
rem vramfit launcher.
rem
rem Two ways in:
rem   1. Double-click this file -> interactive prompt. Paste a link or a path.
rem   2. Drag .gguf files onto this file -> checks them right away.
rem
rem This file is intentionally ASCII-only. cmd.exe parses .cmd files using the
rem active console code page, so UTF-8 Chinese here would be garbled before any
rem "chcp" took effect. All Chinese output comes from check.mjs instead.
rem
rem No "chcp 65001" on purpose: Node writes to a Windows console via
rem WriteConsoleW, which is code-page independent. Forcing the code page only
rem corrupts piped output (every line gains a stray character).
rem
rem Interactive input is read in "cooked" mode on Windows (see inputMode() in
rem check.mjs). Raw mode would clear ENABLE_QUICK_EDIT_MODE and break Ctrl+V /
rem right-click paste in this window - that was the "cannot paste anything" bug.

rem Node is the runtime, this file is only a launcher - without Node there is
rem nothing to run. Say that up front, with the exact command to fix it, instead
rem of failing later on a confusing error. ASCII only, see the note at the top.
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   ============================================================
  echo    vramfit needs Node.js 18 or newer, and it is not installed.
  echo   ============================================================
  echo.
  echo    Install it ^(one line, Windows 10/11^):
  echo.
  echo      winget install OpenJS.NodeJS.LTS
  echo.
  echo    Or download the LTS installer:
  echo.
  echo      https://nodejs.org/
  echo.
  echo    Then double-click this file again.
  echo.
  echo    Just want an answer without installing anything?
  echo      https://www.roroto.com/tools/vramfit/
  echo.
  if not defined VRAMFIT_NO_PAUSE pause
  exit /b 1
)

rem Node's fetch does NOT read HTTP_PROXY / HTTPS_PROXY, while curl and
rem browsers do. Behind Clash / v2ray that makes the checker report
rem "network unreachable" while every other tool works. Enable the flag
rem only when a proxy is actually configured and this Node accepts it.
set "PROXYFLAG="
if defined HTTPS_PROXY set "PROXYFLAG=--use-env-proxy --no-warnings"
if defined HTTP_PROXY set "PROXYFLAG=--use-env-proxy --no-warnings"
if not defined PROXYFLAG goto noproxy
node --use-env-proxy -e "" >nul 2>&1
if errorlevel 1 set "PROXYFLAG="
:noproxy
if "%~1"=="" goto interactive

rem A link with "&" in it gets split by cmd.exe before we ever see it:
rem   check.cmd https://host/x.gguf?a=1&b=2
rem arrives here as %1=https://host/x.gguf?a=1 plus a second argument "b=2",
rem and cmd tries to run "b=2" as a command. Detect that and say what to do.
set "FIRST=%~1"
if /i not "%FIRST:~0,4%"=="http" goto run
if "%~2"=="" goto run

echo.
echo   [NOTE] The link was cut at an "&".
echo.
echo   cmd.exe treats "&" as a command separator, so everything after it was
echo   never passed to the checker, and cmd tried to run it as a command.
echo.
echo   Do this instead:
echo     1. double-click check.cmd
echo     2. paste the link at the prompt
echo.
echo   Wrapping the link in double quotes also works.
echo.
if not defined VRAMFIT_NO_PAUSE pause
exit /b 1

:interactive
rem No arguments: open the interactive prompt so links can be pasted in.
node %PROXYFLAG% "%~dp0check.mjs"
set "RC=%errorlevel%"
echo.
if not defined VRAMFIT_NO_PAUSE pause
exit /b %RC%

:run
node %PROXYFLAG% "%~dp0check.mjs" %*
set "RC=%errorlevel%"

echo.
if not defined VRAMFIT_NO_PAUSE pause
rem Pass Node exit code through: without this cmd.exe always reports 0 and
rem "check.cmd --json ..." can never fail a CI step.
exit /b %RC%
