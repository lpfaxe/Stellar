# Stellar OCR via built-in Windows components (no extra install).
#   .pdf  -> Windows.Data.Pdf renders each page -> Windows.Media.Ocr recognizes
#   image -> decode directly -> OCR
# Output: UTF-8 (no BOM) text; first line PAGES=<n>, then '--- page N ---' blocks.
# Notes:
#   * the process very often exits with 0xC0000005 (WinRT teardown); callers must
#     judge by the output file, not by the exit code.
#   * keep this file ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI when
#     there is no BOM, and non-ASCII bytes can break parsing.
param(
  [string]$InputPath,
  [string]$OutPath,
  [int]$Width = 2200,
  [int]$MaxPages = 30
)
$ErrorActionPreference = 'Stop'
function Write-Out([string]$text) {
  [IO.File]::WriteAllText($OutPath, $text, (New-Object Text.UTF8Encoding $false))
}
if (-not $InputPath -or -not $OutPath) { Write-Out ("PAGES=0" + [char]10 + 'missing arguments'); exit 3 }
if (-not (Test-Path -LiteralPath $InputPath)) { Write-Out ("PAGES=0" + [char]10 + 'input not found'); exit 3 }

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$methods = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asTaskOp = ($methods | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
$asTaskAct = ($methods | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]

function AwaitOp($op, $type) {
  $task = $asTaskOp.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  return $task.Result
}
function AwaitAct($op) {
  $task = $asTaskAct.Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
}

[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null
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
if (-not $engine) { Write-Out ("PAGES=0" + [char]10 + 'OCR engine unavailable'); exit 2 }

function OcrText($bitmap) {
  $result = AwaitOp ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  return $result.Text
}

$parts = New-Object System.Collections.ArrayList
$pageCount = 0
$ext = [IO.Path]::GetExtension($InputPath).ToLowerInvariant()

if ($ext -eq '.pdf') {
  [Windows.Data.Pdf.PdfDocument,Windows.Data.Pdf,ContentType=WindowsRuntime] | Out-Null
  $file = AwaitOp ([Windows.Storage.StorageFile]::GetFileFromPathAsync($InputPath)) ([Windows.Storage.StorageFile])
  $doc = AwaitOp ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
  $pageCount = [int]$doc.PageCount
  $limit = [Math]::Min($pageCount, $MaxPages)
  for ($i = 0; $i -lt $limit; $i += 1) {
    $page = $doc.GetPage([uint32]$i)
    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $opt = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $opt.DestinationWidth = [uint32]$Width
    AwaitAct ($page.RenderToStreamAsync($stream, $opt))
    $stream.Seek(0)
    $decoder = AwaitOp ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = AwaitOp ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $null = $parts.Add('--- page ' + ($i + 1) + ' ---' + [char]10 + (OcrText $bitmap))
  }
  if ($limit -lt $pageCount) {
    $null = $parts.Add('--- only first ' + $limit + ' of ' + $pageCount + ' pages ---')
  }
} else {
  $pageCount = 1
  $file = AwaitOp ([Windows.Storage.StorageFile]::GetFileFromPathAsync($InputPath)) ([Windows.Storage.StorageFile])
  $read = AwaitOp ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = AwaitOp ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($read)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = AwaitOp ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $null = $parts.Add('--- page 1 ---' + [char]10 + (OcrText $bitmap))
}

Write-Out ('PAGES=' + $pageCount + [char]10 + ($parts -join ([char]10 + [char]10)))
[Console]::Out.Write('OCR-DONE pages=' + $pageCount)
exit 0