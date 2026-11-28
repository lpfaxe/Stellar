# Contact sheet for preloaded image candidates (System.Drawing, ASCII only).
# Input: UTF-8 JSON {"items":[{"index":1,"file":"C:\\..."}, ...]}
# Output: JPEG grid, 4 columns x 360x300 cells, each cell labelled #01.
param(
  [string]$Manifest,
  [string]$OutPath
)
$ErrorActionPreference = 'Stop'
if (-not $Manifest -or -not $OutPath) { exit 3 }
if (-not (Test-Path -LiteralPath $Manifest)) { exit 3 }
Add-Type -AssemblyName System.Drawing
$raw = [IO.File]::ReadAllText($Manifest, [Text.Encoding]::UTF8)
$data = $raw | ConvertFrom-Json
$items = @($data.items)
if ($items.Count -eq 0) { exit 3 }
$cols = 4
$cellW = 360
$cellH = 300
$rows = [int][Math]::Ceiling($items.Count / $cols)
$w = $cols * $cellW
$h = $rows * $cellH
$bmp = New-Object System.Drawing.Bitmap($w, $h)
try {
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.Clear([System.Drawing.Color]::FromArgb(243, 244, 246))
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $font = New-Object System.Drawing.Font('Arial', 15, [System.Drawing.FontStyle]::Bold)
    $labelBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(17, 24, 39))
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    for ($i = 0; $i -lt $items.Count; $i++) {
      $col = $i % $cols
      $row = [int][Math]::Floor($i / $cols)
      $x = $col * $cellW
      $y = $row * $cellH
      $g.FillRectangle($white, $x + 8, $y + 8, 66, 26)
      $label = '#' + ($i + 1).ToString('00')
      $g.DrawString($label, $font, $labelBrush, $x + 12, $y + 9)
      $innerX = $x + 8
      $innerY = $y + 38
      $innerW = $cellW - 16
      $innerH = $cellH - 46
      $g.FillRectangle($white, $innerX, $innerY, $innerW, $innerH)
      $file = [string]$items[$i].file
      if (-not $file) { continue }
      try {
        $img = [System.Drawing.Image]::FromFile($file)
        try {
          $scale = [Math]::Min($innerW / $img.Width, $innerH / $img.Height)
          $dw = [int][Math]::Max(1, [Math]::Round($img.Width * $scale))
          $dh = [int][Math]::Max(1, [Math]::Round($img.Height * $scale))
          $dx = $innerX + [int][Math]::Floor(($innerW - $dw) / 2)
          $dy = $innerY + [int][Math]::Floor(($innerH - $dh) / 2)
          $dst = New-Object System.Drawing.Rectangle($dx, $dy, $dw, $dh)
          $g.DrawImage($img, $dst, 0, 0, $img.Width, $img.Height, [System.Drawing.GraphicsUnit]::Pixel)
        } finally { $img.Dispose() }
      } catch { }
    }
  } finally { $g.Dispose() }
  $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Jpeg)
} finally { $bmp.Dispose() }
exit 0
