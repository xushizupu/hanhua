$ErrorActionPreference = "Stop"

$desktopDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$distDir = Join-Path $desktopDir "dist"
$outputDir = Join-Path $distDir "win-unpacked"
$electronDist = Join-Path $desktopDir "node_modules\electron\dist"
$wsModule = Join-Path $desktopDir "node_modules\ws"
$installerDir = Join-Path $desktopDir "installer"

if (-not (Test-Path -LiteralPath (Join-Path $electronDist "electron.exe"))) {
  throw "Electron runtime not found. Run npm install in the desktop directory first."
}

New-Item -ItemType Directory -Path $distDir -Force | Out-Null

if (Test-Path -LiteralPath $outputDir) {
  $resolvedOutput = (Resolve-Path $outputDir).Path
  if (-not $resolvedOutput.StartsWith($distDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove output outside dist: $resolvedOutput"
  }
  Remove-Item -LiteralPath $resolvedOutput -Recurse -Force
}

New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
Copy-Item -Path (Join-Path $electronDist "*") -Destination $outputDir -Recurse -Force
Rename-Item -LiteralPath (Join-Path $outputDir "electron.exe") -NewName "ClassroomCallboard.exe"

$appDir = Join-Path $outputDir "resources\app"
New-Item -ItemType Directory -Path $appDir -Force | Out-Null

$appFiles = @(
  "main.cjs",
  "preload.cjs",
  "popup.html",
  "popup.css",
  "popup.js",
  "setup.html",
  "setup.css",
  "setup.js",
  "package.json"
)
foreach ($file in $appFiles) {
  Copy-Item -LiteralPath (Join-Path $desktopDir $file) -Destination $appDir -Force
}

$appAssets = Join-Path $appDir "assets"
New-Item -ItemType Directory -Path $appAssets -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $desktopDir "assets\icon.png") -Destination $appAssets -Force

$appNodeModules = Join-Path $appDir "node_modules"
New-Item -ItemType Directory -Path $appNodeModules -Force | Out-Null
$appWsModule = Join-Path $appNodeModules "ws"
New-Item -ItemType Directory -Path $appWsModule -Force | Out-Null
Copy-Item -Path (Join-Path $wsModule "*") -Destination $appWsModule -Recurse -Force

Copy-Item -LiteralPath (Join-Path $desktopDir "config.example.json") -Destination $outputDir -Force

foreach ($installerFile in @("install.ps1", "uninstall.ps1")) {
  Copy-Item -LiteralPath (Join-Path $installerDir $installerFile) -Destination $outputDir -Force
}

$zipPath = Join-Path $distDir "ClassroomCallboard-portable.zip"
if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}
Compress-Archive -Path (Join-Path $outputDir "*") -DestinationPath $zipPath -CompressionLevel Optimal

Write-Host ""
Write-Host "Portable build created:"
Write-Host "  $outputDir"
Write-Host "  $zipPath"
