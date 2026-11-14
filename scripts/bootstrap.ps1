# Stellar 引导安装（Windows PowerShell）——只负责「把仓库拿到本地」，真正的检查与配置在 scripts/bootstrap.mjs。
#
# 为什么拆成两层：检查/补齐的逻辑只有一份（node 写的），PowerShell 这边不复制一遍，
# 免得哪天改了判定规则两边不一样。这个脚本只做 PowerShell 擅长的事：找 node、下载、调用。
#
# 陌生人用法（复制这一行到 PowerShell）：
#   powershell -ExecutionPolicy Bypass -File <本仓库>/scripts/bootstrap.ps1
#
# 只检查不动手：
#   ... -Check
#
# 指定安装位置 / 仓库地址：
#   ... -Dir C:\Projects\stellar -RepoUrl https://github.com/<owner>/stellar.git
#
# 已经在仓库目录里（解压版也行）就直接跑 node scripts/bootstrap.mjs --yes，不需要任何参数。

param(
  [switch]$Check,
  [string]$Dir = '',
  [string]$RepoUrl = '',
  [string]$RepoZip = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Say($m = '') { Write-Host $m }
function Ok($m) { Write-Host "  [OK] $m" -ForegroundColor Green }
function Bad($m) { Write-Host "  [!!] $m" -ForegroundColor Yellow }
function Step($n, $m) { Write-Host "`n=== $n. $m ===" -ForegroundColor Cyan }

Say '=============================================='
Say '  Stellar 引导安装'
Say '=============================================='

# ── 1. 找 node ────────────────────────────────────────────
Step 1 '检查 Node'
$nodeExe = ''
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) { $nodeExe = $nodeCmd.Source }
if (-not $nodeExe) {
  # DSH 自带运行时的位置：装过 DSH 的人不一定把 node 加进了 PATH
  $bundled = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path $bundled) { $nodeExe = $bundled; Bad 'PATH 里没有 node，改用 DSH 自带的 Node' }
}
if (-not $nodeExe) {
  Bad '没找到 Node.js。请装 Node 22.13 或更高：https://nodejs.org/'
  Say  '     装完重开这个窗口再跑一次。'
  return
}
$nodeVer = (& $nodeExe -v).TrimStart('v')
$parts = $nodeVer.Split('.')
$okNode = ([int]$parts[0] -gt 22) -or (([int]$parts[0] -eq 22) -and ([int]$parts[1] -ge 13))
if (-not $okNode) {
  Bad "Node v$nodeVer 太旧（需要 >= 22.13）。去 https://nodejs.org/ 装 LTS 覆盖安装，然后重开窗口。"
  return
}
Ok "Node v$nodeVer"

# ── 2. 确认仓库在哪 ───────────────────────────────────────
Step 2 '定位仓库'
$here = Split-Path -Parent $PSScriptRoot
if (-not $Dir) { $Dir = if ($env:STELLAR_DIR) { $env:STELLAR_DIR } else { $here } }
$boot = Join-Path $Dir 'scripts\bootstrap.mjs'

if (Test-Path $boot) {
  Ok "使用现有仓库：$Dir"
} else {
  # 手里只有这个 .ps1（例如从仓库里单独拷出来分享），才需要下载
  $gitCmd = Get-Command git -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  if ($RepoZip -or (-not $gitCmd -and $RepoUrl)) {
    $zipUrl = if ($RepoZip) { $RepoZip } else { ($RepoUrl.TrimEnd('/') -replace '\.git$','') + '/archive/refs/heads/main.zip' }
    $zip = Join-Path $env:TEMP 'stellar-main.zip'
    Say '  下载 zip …'
    Invoke-WebRequest -Uri $zipUrl -OutFile $zip
    Expand-Archive -LiteralPath $zip -DestinationPath $env:TEMP -Force
    $src = Get-ChildItem $env:TEMP -Directory -Filter 'stellar-main' | Select-Object -First 1
    Copy-Item (Join-Path $src.FullName '*') $Dir -Recurse -Force
    Ok '解压完成'
  } elseif ($gitCmd -and $RepoUrl) {
    & git clone --depth 1 $RepoUrl $Dir
    if ($LASTEXITCODE -ne 0) { Bad 'git clone 失败'; return }
    Ok '克隆完成'
  } else {
    Bad '不知道仓库在哪：本目录里没有 scripts\bootstrap.mjs。'
    Say '     请解压/克隆仓库后在该目录里运行，或加 -RepoUrl "仓库地址"。'
    return
  }
}

# ── 3. 交给 bootstrap.mjs ─────────────────────────────────
Step 3 '环境检查与基础配置'
$argsForBoot = @((Join-Path $Dir 'scripts\bootstrap.mjs'))
if ($Check) { $argsForBoot += '--dry-run' } else { $argsForBoot += '--yes' }
Push-Location $Dir
try { & $nodeExe @argsForBoot }
finally { Pop-Location }
$code = $LASTEXITCODE

Say ''
if ($code -eq 0) {
  Say '  下一步：'
  Say '    1) 双击 start.bat 启动 QQ 桥接'
  Say '    2) 完全退出 DSH 再打开（新注册的 preset / MCP 才会生效）'
  Say '    3) 设置 → Stellar → 诊断 → 一键安装（全部），填主人 QQ、勾群'
} else {
  Say '  上面有步骤没成功：按它的 → 提示处理后重跑本脚本（已完成的会自动跳过）。'
}
Say ''
