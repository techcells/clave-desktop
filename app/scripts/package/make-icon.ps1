# Makes build/icon.ico, the Windows counterpart of build/icon.icns, from build/icon-preview.png (256 px).
# Run on Windows from the repo root:  powershell -NoProfile -File app/scripts/package/make-icon.ps1
#
# One PNG-compressed image per size Windows asks an app icon for (taskbar, Start, Explorer, installer),
# each redrawn from the 256 px source with high-quality resampling rather than scaled by Windows at
# run time. PNG entries in an .ico are what Windows Vista and later read; the output is committed.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$app = Join-Path $PSScriptRoot "..\.."
$source = [System.Drawing.Image]::FromFile((Resolve-Path (Join-Path $app "build\icon-preview.png")))
$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$images = foreach ($size in $sizes) {
  $bitmap = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.DrawImage($source, 0, 0, $size, $size)
  $graphics.Dispose()
  $stream = New-Object System.IO.MemoryStream
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
  , @($size, $stream.ToArray())
}
$source.Dispose()

# ICONDIR, then one ICONDIRENTRY per image, then the images. A size of 256 is written as 0.
$out = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter $out
$writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]$images.Count)
$offset = 6 + 16 * $images.Count
foreach ($image in $images) {
  $size = $image[0]; $bytes = $image[1]
  $edge = if ($size -ge 256) { 0 } else { $size }
  $writer.Write([Byte]$edge); $writer.Write([Byte]$edge); $writer.Write([Byte]0); $writer.Write([Byte]0)
  $writer.Write([UInt16]1); $writer.Write([UInt16]32)
  $writer.Write([UInt32]$bytes.Length); $writer.Write([UInt32]$offset)
  $offset += $bytes.Length
}
foreach ($image in $images) { $writer.Write([Byte[]]$image[1]) }
$writer.Flush()
$target = Join-Path (Resolve-Path (Join-Path $app "build")) "icon.ico"
[System.IO.File]::WriteAllBytes($target, $out.ToArray())
"ICON_OK $target $($out.Length) bytes, sizes $($sizes -join ',')"
