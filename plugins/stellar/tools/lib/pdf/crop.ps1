# Crop a PNG with System.Drawing (pixel coordinates).
param(
  [string]$InputPath,
  [string]$OutPath,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$W = 1,
  [int]$H = 1,
  [int]$MaxWidth = 0
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $InputPath)) { exit 3 }
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($InputPath)
try {
  $x = [Math]::Max(0, [Math]::Min($X, $img.Width - 1))
  $y = [Math]::Max(0, [Math]::Min($Y, $img.Height - 1))
  $w = [Math]::Max(1, [Math]::Min($W, $img.Width - $x))
  $h = [Math]::Max(1, [Math]::Min($H, $img.Height - $y))
  $rect = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
  $outW = $w
  $outH = $h
  if ($MaxWidth -gt 0 -and $w -gt $MaxWidth) {
    $outW = $MaxWidth
    $outH = [Math]::Max(1, [int][Math]::Round($h * $MaxWidth / $w))
  }
  $bmp = New-Object System.Drawing.Bitmap($outW, $outH)
  try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $dst = New-Object System.Drawing.Rectangle(0, 0, $outW, $outH)
      $g.DrawImage($img, $dst, $rect, [System.Drawing.GraphicsUnit]::Pixel)
    } finally { $g.Dispose() }
    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $bmp.Dispose() }
} finally { $img.Dispose() }
exit 0
