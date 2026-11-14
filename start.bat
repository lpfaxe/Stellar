@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem --- Locate node. On a machine that only has DSH there is no node on PATH,
rem     but DSH ships its own runtime; prefer PATH, then fall back to that copy
rem     (same rule bootstrap.ps1 uses). Keep this file pure ASCII: non-UTF-8
rem     consoles render CJK as garbage on the first screen users see.
where node >nul 2>nul
if not errorlevel 1 goto stellar_node_ok
set "STELLAR_NODE_DIR=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin"
if exist "%STELLAR_NODE_DIR%\node.exe" goto stellar_node_got
for /d %%D in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do (
  if exist "%%D\dependencies\node\bin\node.exe" set "STELLAR_NODE_DIR=%%D\dependencies\node\bin"
)
:stellar_node_got
if exist "%STELLAR_NODE_DIR%\node.exe" goto stellar_node_use
echo [X] node not found, and there is no DSH runtime on this machine.
echo     Either install Node.js LTS 22.13+ from https://nodejs.org/ ,
echo     or open the DSH desktop app once (it ships its own node) and retry.
echo.
pause
exit /b 1
:stellar_node_use
set "PATH=%STELLAR_NODE_DIR%;%PATH%"
:stellar_node_ok
rem Harden state/ ACLs (Windows needs WRITE_DAC; the directory owner normally has it,
rem so no UAC prompt in the usual case). This NEVER blocks startup: if it cannot get
rem permission it prints a copy-pasteable command and exits 0.
rem See docs/guides/operations/SECURITY_BASELINE.md ("secrets at rest").
node scripts\harden-state-acl.mjs --quiet
:loop
node src/bridge.js
set code=%errorlevel%
if "%code%"=="2" (
    echo [%date% %time%] bridge already running in another window. Exiting.
    pause
    exit /b 2
)
echo [%date% %time%] bridge exited (code %code%), restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
