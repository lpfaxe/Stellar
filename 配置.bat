@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo   Stellar 配置编辑器
echo ============================================
echo.

rem --- node 探测：只有 DSH、没装 Node 的机器上，node 不在 PATH，但 DSH 自带一份运行时。
rem     先找 PATH 里的；没有就把 DSH 自带 node 的目录前置进 PATH（bootstrap.ps1 也是这个口径）。
set "STELLAR_NODE_DIR="
where node >nul 2>nul
if not errorlevel 1 goto stellar_node_ready
set "STELLAR_NODE_DIR=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin"
if exist "%STELLAR_NODE_DIR%\node.exe" goto stellar_node_fallback
rem 有些安装是 DSH_HOME 指到别处，再扫一遍 dsh-runtimes 下的兄弟目录。
for /d %%D in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do (
  if exist "%%D\dependencies\node\bin\node.exe" set "STELLAR_NODE_DIR=%%D\dependencies\node\bin"
)
if not defined STELLAR_NODE_DIR goto stellar_node_missing
:stellar_node_fallback
if not exist "%STELLAR_NODE_DIR%\node.exe" goto stellar_node_missing
set "PATH=%STELLAR_NODE_DIR%;%PATH%"
goto stellar_node_ready
:stellar_node_missing
goto no_node
:stellar_node_ready

node "%~dp0scripts\config-ui.mjs" %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo [!] 配置编辑器没能启动（退出码 %CODE%）。上面那一行是原因。
  echo     常见情况：端口被占用，试试  node scripts\config-ui.mjs --port=0
  echo.
  pause
)
endlocal
exit /b %CODE%

:no_node
echo [!] 没找到 node。两条路任选一条：
echo     (1) 装 Node.js 22.13 或更新版本：https://nodejs.org/
echo     (2) 打开一次 DSH 桌面版（自带 node 运行时），再重跑这个文件
echo.
pause
exit /b 1
