<#
  给这台笔记本开「开机自动登录」，让 06:30 的记忆复核在断电恢复后能准点跑。

  背景：主人所在地 0 点后断电断网、早上 6 点恢复供电。
    1) 网络：ZTE_003223 是 all-user 配置 + 自动连接，WlanSvc  Automatic → 开机即连，已确认；
    2) 开机：取决于 BIOS 的 AC 恢复上电，Windows 改不了；
    3) 登录：本脚本负责。停在登录界面时 DSH（图形程序）和插件里的定时器都不会跑。

  账户 user 目前 PasswordRequired=False（没有密码），所以自动登录不需要在注册表里存明文密码。
  必须**以管理员身份**运行（当前普通会话对 HKLM 没有写权限）。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File enable-autologon.ps1 -Check    # 只看状态
    powershell -NoProfile -ExecutionPolicy Bypass -File enable-autologon.ps1 -Apply    # 写入
    powershell -NoProfile -ExecutionPolicy Bypass -File enable-autologon.ps1 -Revert   # 撤销
#>
param([switch]$Check, [switch]$Apply, [switch]$Revert)

$ErrorActionPreference = 'Stop'
$key = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
$user = 'user'
$backupDir = Join-Path $env:USERPROFILE 'stellar-autologon-backup'

function Show-Current {
  $v = Get-ItemProperty $key
  $acct = Get-LocalUser -Name $user -ErrorAction SilentlyContinue
  [pscustomobject]@{
    AutoAdminLogon   = $v.AutoAdminLogon
    DefaultUserName  = $v.DefaultUserName
    HasDefaultPass   = [bool]$v.DefaultPassword
    PasswordRequired = $acct.PasswordRequired
    AccountEnabled   = $acct.Enabled
  } | Format-List
}

$isAdmin = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $Check) {
  Write-Host '需要管理员权限：右键 PowerShell → 以管理员身份运行，再执行本脚本。' -ForegroundColor Yellow
  exit 2
}

if ($Check -or (-not $Apply -and -not $Revert)) { Show-Current; exit 0 }

if ($Revert) {
  Set-ItemProperty $key -Name AutoAdminLogon -Value '0' -Type String
  Write-Host '已关闭自动登录（AutoAdminLogon=0）。'
  Show-Current
  exit 0
}

# Apply：先备份当前值，再写
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMddTHHmmss'
reg export 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' (Join-Path $backupDir ('winlogon.' + $stamp + '.reg')) /y | Out-Null

$acct = Get-LocalUser -Name $user
if (-not $acct.Enabled) { Write-Host ('账户 ' + $user + ' 已禁用，先启用再说。') -ForegroundColor Red; exit 3 }
if ($acct.PasswordRequired) {
  Write-Host '账户有密码：本脚本不写明文密码。请改用 Sysinternals Autologon（密码存 LSA），或先把账户改成无密码。' -ForegroundColor Yellow
  exit 4
}

Set-ItemProperty $key -Name DefaultUserName  -Value $user -Type String
Set-ItemProperty $key -Name DefaultPassword  -Value ''    -Type String
Set-ItemProperty $key -Name AutoAdminLogon   -Value '1'   -Type String

Write-Host ('已开启自动登录：' + $user + '（无密码账户，注册表里没有密码明文）。')
Write-Host ('备份：' + $backupDir)
Show-Current

Write-Host ''
Write-Host '还差两项（Windows 改不了）：'
Write-Host '  1. BIOS：打开「断电恢复后自动上电」Restore on AC Power Loss / Always On（联想常见在 Configuration 页）。'
Write-Host '  2. 确认启动文件夹那条快捷方式还在：%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Stellar Keepalive (Ensure DSH).lnk'
