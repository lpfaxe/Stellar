# Stellar PDF page renderer via built-in Windows.Data.Pdf.
# Output: PNG (the render stream is already PNG; width is DestinationWidth, pixels are 2x on this DPI).
param(
  [string]$InputPath,
  [string]$OutPath,
  [int]$Page = 1,
  [int]$Width = 1700
)
$ErrorActionPreference = 'Stop'
if (-not $InputPath -or -not $OutPath) { exit 3 }
if (-not (Test-Path -LiteralPath $InputPath)) { exit 3 }

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
[Windows.Data.Pdf.PdfDocument,Windows.Data.Pdf,ContentType=WindowsRuntime] | Out-Null

$file = AwaitOp ([Windows.Storage.StorageFile]::GetFileFromPathAsync($InputPath)) ([Windows.Storage.StorageFile])
$doc = AwaitOp ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
if ($Page -lt 1 -or $Page -gt [int]$doc.PageCount) { exit 4 }
$p = $doc.GetPage([uint32]($Page - 1))
$stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
$opt = New-Object Windows.Data.Pdf.PdfPageRenderOptions
$opt.DestinationWidth = [uint32]$Width
AwaitAct ($p.RenderToStreamAsync($stream, $opt))
$stream.Seek(0)
$reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
$size = [uint32]$stream.Size
$null = AwaitOp ($reader.LoadAsync($size)) ([uint32])
$bytes = New-Object byte[] $size
$reader.ReadBytes($bytes)
[IO.File]::WriteAllBytes($OutPath, $bytes)
exit 0
