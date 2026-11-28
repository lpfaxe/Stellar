# Stellar PDF OCR (page range, line bounding boxes) via built-in Windows components.
# Output: UTF-8 (no BOM) JSON:
#   {"pages":[{"page":N,"width":W,"height":H,"lines":[{"text":"...","x":..,"y":..,"w":..,"h":..}]}]}
# Notes:
#   * the process may exit with 0xC0000005 (WinRT teardown); callers judge by the output file.
#   * keep this file ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI without BOM.
param(
  [string]$InputPath,
  [string]$OutPath,
  [int]$FromPage = 1,
  [int]$MaxPages = 1,
  [int]$Width = 1700
)
$ErrorActionPreference = 'Stop'
function Write-Out([string]$text) {
  [IO.File]::WriteAllText($OutPath, $text, (New-Object Text.UTF8Encoding $false))
}
if (-not $InputPath -or -not $OutPath) { Write-Out '{"pages":[],"error":"missing arguments"}'; exit 3 }
if (-not (Test-Path -LiteralPath $InputPath)) { Write-Out '{"pages":[],"error":"input not found"}'; exit 3 }

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$methods = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asTaskOp = ($methods | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
$asTaskAct = ($methods | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]

function AwaitOp($op, $type) {
  $task = $asTaskOp.MakeGenericMethod($type).Invoke($null, @($op))
  try {
    $task.Wait(-1) | Out-Null
  } catch {
    $inner = $_.Exception.InnerException
    if (-not $inner) { $inner = $_.Exception }
    $msg = ($inner.Message -replace '\r?\n', ' ')
    Write-Out ('{"pages":[],"error":"' + ($global:stage) + ': ' + ($msg -replace '"', "'") + '"}')
    exit 4
  }
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
[Windows.Data.Pdf.PdfDocument,Windows.Data.Pdf,ContentType=WindowsRuntime] | Out-Null

$engine = $null
foreach ($tag in @('zh-Hans-CN', 'zh-CN')) {
  try {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language $tag))
    if ($engine) { break }
  } catch { }
}
if (-not $engine) { try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() } catch { } }
if (-not $engine) { Write-Out '{"pages":[],"error":"OCR engine unavailable"}'; exit 2 }

$global:stage='open-file'
$file = AwaitOp ([Windows.Storage.StorageFile]::GetFileFromPathAsync($InputPath)) ([Windows.Storage.StorageFile])
$global:stage='open-doc'
$doc = AwaitOp ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
$pageCount = [int]$doc.PageCount
$from = [Math]::Max(0, $FromPage - 1)
$to = [Math]::Min($pageCount, $from + $MaxPages)
$pages = New-Object System.Collections.ArrayList

for ($i = $from; $i -lt $to; $i += 1) {
  $page = $doc.GetPage([uint32]$i)
  $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  $opt = New-Object Windows.Data.Pdf.PdfPageRenderOptions
  $opt.DestinationWidth = [uint32]$Width
  $global:stage='render-' + ($i + 1)
  AwaitAct ($page.RenderToStreamAsync($stream, $opt))
  $stream.Seek(0)
  $global:stage='decoder-' + ($i + 1)
  $decoder = AwaitOp ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $global:stage='bitmap-' + ($i + 1)
  $bitmap = AwaitOp ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $global:stage='ocr-' + ($i + 1)
  $result = AwaitOp ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = New-Object System.Collections.ArrayList
  foreach ($line in $result.Lines) {
    if (-not $line.Words -or $line.Words.Count -eq 0) { continue }
    $x1 = [double]::MaxValue; $y1 = [double]::MaxValue; $x2 = 0.0; $y2 = 0.0
    $words = New-Object System.Collections.ArrayList
    foreach ($word in $line.Words) {
      $r = $word.BoundingRect
      if ($r.X -lt $x1) { $x1 = $r.X }
      if ($r.Y -lt $y1) { $y1 = $r.Y }
      if (($r.X + $r.Width) -gt $x2) { $x2 = $r.X + $r.Width }
      if (($r.Y + $r.Height) -gt $y2) { $y2 = $r.Y + $r.Height }
      $null = $words.Add($word.Text)
    }
    $obj = [PSCustomObject]@{
      text = ($words -join ' ')
      x = [Math]::Round($x1, 1)
      y = [Math]::Round($y1, 1)
      w = [Math]::Round($x2 - $x1, 1)
      h = [Math]::Round($y2 - $y1, 1)
    }
    $null = $lines.Add($obj)
  }
  $pageObj = [PSCustomObject]@{
    page = $i + 1
    width = [int]$bitmap.PixelWidth
    height = [int]$bitmap.PixelHeight
    lines = @($lines.ToArray())
  }
  $null = $pages.Add($pageObj)
}

$payload = [PSCustomObject]@{ pages = @($pages.ToArray()); pageCount = $pageCount }
Write-Out ($payload | ConvertTo-Json -Depth 8 -Compress)
exit 0
