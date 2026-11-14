@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo   Stellar 首次启动检查
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

node -e "const m=+process.versions.node.split('.')[0];const n=+process.versions.node.split('.')[1];process.exit(m>22||(m===22&&n>=13)?0:1)"
if errorlevel 1 goto old_node

node "%~dp0scripts\bootstrap.mjs" --yes
if errorlevel 1 goto failed

echo.
echo 检查完成。
choice /c YN /n /m "现在启动 QQ 桥接吗？[Y/N] " >nul 2>nul
rem 没有可用控制台时 choice 会失败（errorlevel 255），此时按「不启动」处理，不报错
if errorlevel 2 goto done
start "" cmd /c start.bat
goto done

:no_node
echo [X] 没找到 node。
echo     两条路任选一条：
echo       (1) 装 Node.js LTS（22.13 或更高）：https://nodejs.org/
echo       (2) 打开一次 DSH 桌面版（它自带一份 node 运行时），再双击本文件
echo     装完/开完**重开这个窗口**再双击一次。
goto done

:old_node
echo [X] Node 版本太低，需要 22.13 或更高。
echo     当前版本：
node -v
echo     去 https://nodejs.org/ 装 LTS 覆盖安装，然后重开这个窗口。
goto done

:failed
echo.
echo [!] 上面有步骤没成功。按它给出的 → 提示处理后，再双击一次本文件（已完成的步骤会自动跳过）。
goto done

:done
echo.
pause
endlocal
