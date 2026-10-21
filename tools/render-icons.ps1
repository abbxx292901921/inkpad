# tools/render-icons.ps1
# Regenerates icons/*.png from the SVG sources using headless Chrome.
#
#   .\tools\render-icons.ps1
#
# IMPORTANT: only the ROOT <svg> element's width/height may be rewritten.
# The artwork contains <rect width="512" height="512"> background elements —
# a naive global replace of width="512" shrinks the background so it only
# covers the top-left corner of the viewBox. The script scopes the rewrite to
# the <svg> tag and then VERIFIES the corners of every PNG it produced.

param(
  [string]$Chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root "assets"
$icons = Join-Path $root "icons"
$tmp = Join-Path $env:TEMP "inkpad-icons"
New-Item -ItemType Directory -Force -Path $icons, $tmp | Out-Null

if (-not (Test-Path -LiteralPath $Chrome)) {
  throw "Chrome not found at $Chrome - pass -Chrome <path>"
}

# svg source -> output png (relative to repo root)
$jobs = @(
  @{ svg = "logo.svg";         size = 512; out = "icons/icon-512.png" }
  @{ svg = "logo.svg";         size = 192; out = "icons/icon-192.png" }
  @{ svg = "logo.svg";         size = 180; out = "icons/icon-180.png" }
  @{ svg = "logo.svg";         size = 32;  out = "icons/favicon-32.png" }
  @{ svg = "logo-maskable.svg"; size = 512; out = "icons/icon-maskable-512.png" }
)

foreach ($job in $jobs) {
  $content = Get-Content -LiteralPath (Join-Path $assets $job.svg) -Raw

  # Rewrite width/height on the ROOT <svg> tag only.
  $content = [regex]::Replace($content, '<svg\b[^>]*>', {
    param($m)
    $tag = $m.Value
    $tag = $tag -replace 'width="\d+"', ("width=""{0}""" -f $job.size)
    $tag = $tag -replace 'height="\d+"', ("height=""{0}""" -f $job.size)
    return $tag
  }, 1)

  $tmpSvg = Join-Path $tmp ("{0}-{1}.svg" -f $job.size, $job.svg)
  Set-Content -LiteralPath $tmpSvg -Value $content -Encoding UTF8

  $outPath = Join-Path $root $job.out
  # Chrome writes "N bytes written to file" to stderr, which PowerShell turns
  # into a terminating error under $ErrorActionPreference = "Stop".
  # Start-Process with redirected streams avoids that entirely.
  $errFile = Join-Path $tmp "chrome.err"
  # Paths contain spaces, so both the screenshot path and the file:// URL must
  # be quoted (or Chrome reads them as two separate targets).
  $outArg = "--screenshot=`"$outPath`""
  $urlArg = "file:///" + ($tmpSvg.Replace('\', '/').Replace(' ', '%20'))
  $args = @(
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    "--default-background-color=00000000", "--virtual-time-budget=3000",
    "--window-size=$($job.size),$($job.size)", $outArg, $urlArg
  )
  $proc = Start-Process -FilePath $Chrome -ArgumentList $args -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput "$errFile.out" -RedirectStandardError $errFile
  if ($proc.ExitCode -ne 0) {
    throw "chrome exited $($proc.ExitCode) for $($job.out): $(Get-Content $errFile -Raw)"
  }

  if (-not (Test-Path -LiteralPath $outPath)) { throw "render failed: $($job.out)" }
}

# Verify: every icon must be fully opaque in all four corners (the artwork
# paints a full-bleed background, so a transparent corner means the background
# rect got resized by mistake).
Add-Type -AssemblyName System.Drawing
$failed = $false
foreach ($job in $jobs) {
  $outPath = Join-Path $root $job.out
  $bmp = New-Object System.Drawing.Bitmap($outPath)
  $corners = @(@(0, 0), @(($bmp.Width - 1), 0), @(0, ($bmp.Height - 1)), @(($bmp.Width - 1), ($bmp.Height - 1)))
  foreach ($c in $corners) {
    $alpha = $bmp.GetPixel($c[0], $c[1]).A
    if ($alpha -ne 255) {
      Write-Error ("TRANSPARENT CORNER in {0} at ({1},{2}) alpha={3}" -f $job.out, $c[0], $c[1], $alpha)
      $failed = $true
    }
  }
  $bmp.Dispose()
}
if ($failed) { throw "icon verification failed - background does not cover the canvas" }

Write-Output "rendered and verified $($jobs.Count) icons"
