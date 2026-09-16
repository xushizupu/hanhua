$ErrorActionPreference = "Stop"

$sourceDir = (Resolve-Path $PSScriptRoot).Path
$installDir = Join-Path $env:LOCALAPPDATA "ClassroomCallboard"
$exePath = Join-Path $installDir "ClassroomCallboard.exe"
$configSource = Join-Path $sourceDir "config.json"
$configTarget = Join-Path $installDir "config.json"

if (-not (Test-Path -LiteralPath (Join-Path $sourceDir "ClassroomCallboard.exe"))) {
  throw "ClassroomCallboard.exe was not found next to install.ps1."
}

New-Item -ItemType Directory -Path $installDir -Force | Out-Null

$existingConfig = $null
if (Test-Path -LiteralPath $configTarget) {
  $existingConfig = Get-Content -LiteralPath $configTarget -Raw
}

Get-ChildItem -LiteralPath $sourceDir -Force | Where-Object {
  $_.Name -notin @("config.json", "install.ps1", "uninstall.ps1")
} | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $installDir -Recurse -Force
}

if ($existingConfig) {
  Set-Content -LiteralPath $configTarget -Value $existingConfig -Encoding UTF8
} elseif (Test-Path -LiteralPath $configSource) {
  Copy-Item -LiteralPath $configSource -Destination $configTarget -Force
}

$shell = New-Object -ComObject WScript.Shell
$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Classroom Callboard.lnk"
$startMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$startMenuShortcut = Join-Path $startMenuDir "Classroom Callboard.lnk"
New-Item -ItemType Directory -Path $startMenuDir -Force | Out-Null

foreach ($shortcutPath in @($desktopShortcut, $startMenuShortcut)) {
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $exePath
  $shortcut.WorkingDirectory = $installDir
  $shortcut.Description = "Classroom Callboard"
  $shortcut.Save()
}

Write-Host ""
Write-Host "Classroom Callboard installed:"
Write-Host "  $exePath"
Write-Host "  Desktop shortcut created"
Write-Host "  Start menu shortcut created"
