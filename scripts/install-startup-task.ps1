# scripts/install-startup-task.ps1
# Registers a Windows Task Scheduler task that launches Tender Tracker on user logon (docs/15 F6).
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$projectRoot = Split-Path -Parent $scriptDir
$launchCmd = Join-Path $scriptDir "launch.cmd"

$taskName = "TenderTrackerAutoStart"
$description = "Starts Tender Tracker server on user logon so scans run unattended (Phase 4 / docs/15 F6)"

Write-Host "Registering Scheduled Task: $taskName..." -ForegroundColor Cyan

# Create Task Action
$action = New-ScheduledTaskAction -Execute $launchCmd -WorkingDirectory $projectRoot

# Create Trigger (At Logon)
$trigger = New-ScheduledTaskTrigger -AtLogOn

# Create Settings: restart on failure, allow execution on battery
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 365)

# Register the task for current user
try {
    # Unregister existing task if present
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description $description | Out-Null
    Write-Host "[OK] Task '$taskName' registered successfully to start at user logon." -ForegroundColor Green
    Write-Host "Project directory: $projectRoot"
    Write-Host "Launch script: $launchCmd"
} catch {
    Write-Error "Failed to register scheduled task: $_"
}
