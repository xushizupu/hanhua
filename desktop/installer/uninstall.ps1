$ErrorActionPreference = "Stop"

$installDir = Join-Path $env:LOCALAPPDATA "ClassroomCallboard"
$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Classroom Callboard.lnk"
$startMenuShortcut = Join-Path (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs") "Classroom Callboard.lnk"

Get-Process ClassroomCallboard -ErrorAction SilentlyContinue | Stop-Process -Force

foreach ($shortcut in @($desktopShortcut, $startMenuShortcut)) {
  if (Test-Path -LiteralPath $shortcut) {
    Remove-Item -LiteralPath $shortcut -Force
  }
}

if (Test-Path -LiteralPath $installDir) {
  $resolvedInstallDir = (Resolve-Path $installDir).Path
  $resolvedLocalAppData = (Resolve-Path $env:LOCALAPPDATA).Path
  if (-not $resolvedInstallDir.StartsWith($resolvedLocalAppData, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove directory outside LOCALAPPDATA: $resolvedInstallDir"
  }
  Remove-Item -LiteralPath $resolvedInstallDir -Recurse -Force
}

Write-Host "Classroom Callboard was removed."
