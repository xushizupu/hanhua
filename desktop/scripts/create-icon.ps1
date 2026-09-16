$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$desktopDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$assetsDir = Join-Path $desktopDir "assets"
New-Item -ItemType Directory -Path $assetsDir -Force | Out-Null

$size = 64
$bitmap = New-Object System.Drawing.Bitmap $size, $size
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)

$green = [System.Drawing.Color]::FromArgb(31, 101, 71)
$white = [System.Drawing.Color]::White
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$radius = 14
$path.AddArc(2, 2, $radius, $radius, 180, 90)
$path.AddArc($size - $radius - 2, 2, $radius, $radius, 270, 90)
$path.AddArc($size - $radius - 2, $size - $radius - 2, $radius, $radius, 0, 90)
$path.AddArc(2, $size - $radius - 2, $radius, $radius, 90, 90)
$path.CloseFigure()

$greenBrush = New-Object System.Drawing.SolidBrush $green
$whiteBrush = New-Object System.Drawing.SolidBrush $white
$graphics.FillPath($greenBrush, $path)

$speaker = New-Object System.Drawing.Drawing2D.GraphicsPath
$speaker.AddPolygon(@(
  [System.Drawing.Point]::new(17, 27),
  [System.Drawing.Point]::new(29, 18),
  [System.Drawing.Point]::new(29, 46),
  [System.Drawing.Point]::new(17, 37)
))
$speaker.AddRectangle([System.Drawing.Rectangle]::new(29, 25, 7, 14))
$graphics.FillPath($whiteBrush, $speaker)
$graphics.FillEllipse($whiteBrush, 38, 23, 8, 18)
$graphics.DrawArc((New-Object System.Drawing.Pen $white, 3), 40, 18, 12, 28, -55, 110)

$pngPath = Join-Path $assetsDir "icon.png"
$bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

$speaker.Dispose()
$path.Dispose()
$greenBrush.Dispose()
$whiteBrush.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

Write-Host "Icon created: $pngPath"
