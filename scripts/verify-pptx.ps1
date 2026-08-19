# Opens a generated .pptx in the real PowerPoint and reports what happened.
#
# The package validator in src/pptx/validate.ts catches the structural defects that
# make PowerPoint refuse a file, but only PowerPoint itself can prove a file opens
# without a repair prompt. This drives it over COM: read-only, no window, closed
# again immediately.
#
#   powershell -ExecutionPolicy Bypass -File scripts/verify-pptx.ps1 <file.pptx> [-Preview]
#
# -Preview also exports the first three slides as PNGs beside the file, which is the
# quickest way to check the deck actually looks right rather than merely parsing.

param(
  [Parameter(Mandatory = $true)][string]$Path,
  [switch]$Preview
)

$full = (Resolve-Path -LiteralPath $Path).Path
if (-not (Test-Path -LiteralPath $full)) { "NOT FOUND: $full"; exit 1 }

try {
  $app = New-Object -ComObject PowerPoint.Application
} catch {
  "POWERPOINT UNAVAILABLE: $($_.Exception.Message)"
  "The package validator still runs in `npm test`; this check needs PowerPoint installed."
  exit 2
}

$exit = 0
try {
  # ReadOnly, no window: a repair prompt surfaces as an exception rather than a dialog.
  $pres = $app.Presentations.Open($full, $true, $false, $false)
  "OPENED OK"
  "  file    : $full"
  "  slides  : $($pres.Slides.Count)"
  "  size    : $($pres.PageSetup.SlideWidth) x $($pres.PageSetup.SlideHeight) pt"

  $withNotes = 0
  foreach ($i in 1..$pres.Slides.Count) {
    $slide = $pres.Slides($i)
    if ($slide.NotesPage.Shapes.Count -ge 2 -and
        $slide.NotesPage.Shapes(2).TextFrame.TextRange.Length -gt 0) { $withNotes++ }
  }
  "  notes   : $withNotes of $($pres.Slides.Count) slides carry speaker notes"

  if ($Preview) {
    $dir = Join-Path (Split-Path $full) 'preview'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    foreach ($i in 1..([Math]::Min(3, $pres.Slides.Count))) {
      $png = Join-Path $dir "slide$i.png"
      $pres.Slides($i).Export($png, 'PNG', 1600, 900)
      "  preview : $png"
    }
  }

  $pres.Close()
} catch {
  "OPEN FAILED: $($_.Exception.Message)"
  "PowerPoint gives no detail about which part it objected to. Run the package"
  "validator for that: it reports the specific rule that was broken."
  $exit = 1
} finally {
  try { $app.Quit() } catch {}
}

exit $exit
