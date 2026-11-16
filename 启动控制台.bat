@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
rem Keep this file pure ASCII: cmd.exe re-reads batch files batch by batch and
rem multi-byte CJK lines get split mid-way after chcp 65001, which shows up as
rem random "xxx is not recognized" lines. All Chinese text lives in server.mjs.
echo ============================================
echo   Stellar console
echo ============================================
echo.
echo Overview, contacts, memory, Bilibili, QZone, logs, settings.
echo First open looks empty because the bridge has not run yet.
echo Open http://127.0.0.1:3300/ in a browser. Closing this window stops the console.
echo The first open shows a passphrase page: copy the "local entry" line printed below.
echo.

set "STELLAR_NODE_DIR="
where node >nul 2>nul
if not errorlevel 1 goto stellar_node_ready
set "STELLAR_NODE_DIR=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin"
if exist "%STELLAR_NODE_DIR%\node.exe" goto stellar_node_fallback
for /d %%D in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do (
  if exist "%%D\dependencies\node\bin\node.exe" set "STELLAR_NODE_DIR=%%D\dependencies\node\bin"
)
if not defined STELLAR_NODE_DIR goto no_node
:stellar_node_fallback
if not exist "%STELLAR_NODE_DIR%\node.exe" goto no_node
set "PATH=%STELLAR_NODE_DIR%;%PATH%"
goto stellar_node_ready

:no_node
echo [!] node not found, and there is no DSH runtime on this machine.
echo     Either install Node.js LTS 22.13+ from https://nodejs.org/ ,
echo     or open the DSH desktop app once (it ships its own node) and retry.
echo.
pause
exit /b 1

:stellar_node_ready
if not exist "%~dp0stellar-manager\server.mjs" (
  echo [!] stellar-manager\server.mjs is missing in this download.
  echo     Re-download the full repository, or use the launcher that starts the bridge.
  echo.
  pause
  exit /b 1
)

echo URL: http://127.0.0.1:3300/    (another port: set STELLAR_PANEL_PORT=3301 first)
echo.
node "%~dp0stellar-manager\server.mjs"
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo [!] console exited with code %CODE%. The lines above say why.
  echo     Most common: port busy - try  set STELLAR_PANEL_PORT=3301
  echo.
  pause
)
endlocal & exit /b %CODE%
