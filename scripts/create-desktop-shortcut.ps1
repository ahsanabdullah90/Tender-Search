$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$projectRoot = Split-Path -Parent $scriptDir
$desktopPath = [Environment]::GetFolderPath('Desktop')

$targetCmd = Join-Path $scriptDir "launch.cmd"
$iconPath = Join-Path $projectRoot "public\favicon.ico"
$shortcutPath = Join-Path $desktopPath "Tender Tracker.lnk"

$wshShell = New-Object -ComObject WScript.Shell
$shortcut = $wshShell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $targetCmd
$shortcut.WorkingDirectory = $projectRoot
if (Test-Path $iconPath) {
    $shortcut.IconLocation = "$iconPath,0"
}
$shortcut.Description = "Launch Tender Tracker Solo-Operator Intelligence Console"
$shortcut.Save()

Write-Host "[OK] Desktop shortcut created successfully at: $shortcutPath"
