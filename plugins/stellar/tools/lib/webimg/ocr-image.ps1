# Stellar image OCR (single bitmap) via built-in Windows components.
# Output: UTF-8 (no BOM) JSON: {"text":"...","width":W,"height":H,"lines":[...]}
# Notes:
#   * the process may exit with 0xC0000005 (WinRT teardown); callers judge by the output file.
#   * keep this file ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI without BOM.
param(
  [string]$InputPath,
  [string]$OutPath,
  [double]$Scale = 1.0
)
$ErrorActionPreference = 'Stop'
function Write-Out([string]$text) {
  [IO.File]::WriteAllText($OutPath, $text, (New-Object Text.UTF8Encoding $false))
}
if (-not $InputPath -or -not $OutPath) { Write-Out '{"error":"missing arguments"}'; exit 3 }
if (-not (Test-Path -LiteralPath $InputPath)) { Write-Out '{"error":"input not found"}'; exit 3 }

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$methods = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asTaskOp = ($methods | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function AwaitOp($op, $type) {
  $task = $asTaskOp.MakeGenericMethod($type).Invoke($null, @($op))
  try {
    $task.Wait(-1) | Out-Null
  } catch {
    $inner = $_.Exception.InnerException
    if (-not $inner) { $inner = $_.Exception }
    $msg = ($inner.Message -replace '\r?\n', ' ')
    Write-Out ('{"error":"' + ($global:stage) + ': ' + ($msg -replace '"', "'") + '"}')
    exit 4
  }
  return $task.Result
}

[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime] | Out-Null
[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime] | Out-Null

$engine = $null
foreach ($tag in @('zh-Hans-CN', 'zh-CN')) {
  try {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language $tag))
    if ($engine) { break }
  } catch { }
}
if (-not $engine) { try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() } catch { } }
if (-not $engine) { Write-Out '{"error":"OCR engine unavailable"}'; exit 2 }

# 800px 的药盒小字 OCR 经常把 100mg 认成 00m；先放大再识别。
$workPath = $InputPath
if ($Scale -gt 1.01) {
  try {
    Add-Type -AssemblyName System.Drawing
    $src = [System.Drawing.Image]::FromFile($InputPath)
    $w = [int]([Math]::Round($src.Width * $Scale))
    $h = [int]([Math]::Round($src.Height * $Scale))
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($src, 0, 0, $w, $h)
    $workPath = [IO.Path]::Combine([IO.Path]::GetDirectoryName($OutPath), 'scaled.png')
    $bmp.Save($workPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    $src.Dispose()
  } catch {
    $workPath = $InputPath
  }
}

$global:stage='open-file'
$file = AwaitOp ([Windows.Storage.StorageFile]::GetFileFromPathAsync($workPath)) ([Windows.Storage.StorageFile])
$global:stage='open-stream'
$stream = AwaitOp ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$global:stage='decoder'
$decoder = AwaitOp ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$global:stage='bitmap'
$bitmap = AwaitOp ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$global:stage='ocr'
$result = AwaitOp ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

$lines = New-Object System.Collections.ArrayList
foreach ($line in $result.Lines) {
  if (-not $line.Text) { continue }
  $null = $lines.Add($line.Text)
}
$text = ($lines.ToArray() -join "`n")
$payload = [PSCustomObject]@{
  text = $text
  width = [int]$bitmap.PixelWidth
  height = [int]$bitmap.PixelHeight
  lines = @($lines.ToArray())
}
Write-Out ($payload | ConvertTo-Json -Depth 5 -Compress)
exit 0
