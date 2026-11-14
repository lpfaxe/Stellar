param(
  [Parameter(Mandatory=$true)][string]$Src,
  [Parameter(Mandatory=$true)][string]$Dst,
  [Parameter(Mandatory=$true)][string]$Kind
)
$ErrorActionPreference = 'Stop'
$WORD_FORMAT = 12
$EXCEL_FORMAT = 51
$PPT_FORMAT = 24

function Convert-Word($app, $srcPath, $dstPath) {
  $doc = $app.Documents.Open($srcPath)
  try {
    try { $doc.SaveAs2($dstPath, $WORD_FORMAT) } catch { $doc.SaveAs($dstPath, $WORD_FORMAT) }
  } finally {
    try { $doc.Close(0) } catch {}
  }
}

function Convert-Excel($app, $srcPath, $dstPath) {
  $wb = $app.Workbooks.Open($srcPath)
  try {
    $wb.SaveAs($dstPath, $EXCEL_FORMAT)
  } finally {
    try { $wb.Close($false) } catch {}
  }
}

function Convert-Ppt($app, $srcPath, $dstPath) {
  $pres = $app.Presentations.Open($srcPath, -1, 0, 0)
  try {
    $pres.SaveAs($dstPath, $PPT_FORMAT)
  } finally {
    try { $pres.Close() } catch {}
  }
}

$isExcel = ($Kind -eq 'xls' -or $Kind -eq 'et')
$isPpt = ($Kind -eq 'ppt' -or $Kind -eq 'dps')
if ($isExcel) { $candidates = @('KET.Application','Excel.Application') }
elseif ($isPpt) { $candidates = @('KWPP.Application','PowerPoint.Application') }
else { $candidates = @('KWps.Application','Word.Application') }

$errors = @()
foreach ($progId in $candidates) {
  $app = $null
  try {
    $app = New-Object -ComObject $progId
    try { $app.Visible = $false } catch {}
    try { $app.DisplayAlerts = 0 } catch {}
    if ($isExcel) { Convert-Excel $app $Src $Dst }
    elseif ($isPpt) { Convert-Ppt $app $Src $Dst }
    else { Convert-Word $app $Src $Dst }
    if (Test-Path -LiteralPath $Dst) {
      try { $app.Quit() } catch {}
      Write-Output ('OK ' + $progId)
      exit 0
    }
    $errors += ($progId + ': no output file')
  } catch {
    $errors += ($progId + ': ' + $_.Exception.Message)
  }
  try { $app.Quit() } catch {}
  $app = $null
}
Write-Output ('ERR ' + ($errors -join ' | '))
exit 1