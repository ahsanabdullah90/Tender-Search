param(
  [switch]$StartMinimized,
  [int]$Port = 3000,
  [string]$DataDir = '',
  [switch]$NoRun
)

$ErrorActionPreference = 'Stop'

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
$script:ProjectRoot = Split-Path -Parent $scriptDir
$script:Port = $Port
$script:BaseUrl = "http://127.0.0.1:$Port"
$script:IconPath = Join-Path $script:ProjectRoot 'public\favicon.ico'

if ($DataDir -and $DataDir.Trim()) {
  $script:EffectiveDataDir = [System.IO.Path]::GetFullPath($DataDir.Trim())
} elseif ($env:TENDER_DATA_DIR -and $env:TENDER_DATA_DIR.Trim()) {
  $script:EffectiveDataDir = [System.IO.Path]::GetFullPath($env:TENDER_DATA_DIR.Trim())
} else {
  $script:EffectiveDataDir = Join-Path $script:ProjectRoot 'data'
}
$script:ProfileDir = Join-Path $script:EffectiveDataDir 'app-profile'

function Resolve-StandaloneBrowser {
  $edgeCandidates = @()
  if (${env:ProgramFiles(x86)}) {
    $edgeCandidates += (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
  }
  if ($env:ProgramFiles) {
    $edgeCandidates += (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
  }
  if ($env:LocalAppData) {
    $edgeCandidates += (Join-Path $env:LocalAppData 'Microsoft\Edge\Application\msedge.exe')
  }

  foreach ($candidate in $edgeCandidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return @{ Engine = 'edge'; Path = $candidate }
    }
  }

  $chromeCandidates = @()
  if ($env:ProgramFiles) {
    $chromeCandidates += (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')
  }
  if (${env:ProgramFiles(x86)}) {
    $chromeCandidates += (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
  }
  if ($env:LocalAppData) {
    $chromeCandidates += (Join-Path $env:LocalAppData 'Google\Chrome\Application\chrome.exe')
  }

  foreach ($candidate in $chromeCandidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return @{ Engine = 'chrome'; Path = $candidate }
    }
  }

  return @{ Engine = 'default'; Path = $null }
}

function Format-TrayTooltip {
  param([string]$Text)

  if ([string]::IsNullOrWhiteSpace($Text)) {
    return 'Tender Tracker'
  }
  if ($Text.Length -le 63) {
    return $Text
  }
  return $Text.Substring(0, 60) + '...'
}

function New-ShutdownToken {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return (-join ($bytes | ForEach-Object { $_.ToString('x2') }))
}

function Get-DigestAlertInfo {
  param($Digest)

  if ($null -eq $Digest) {
    return $null
  }

  $closingCount = 0
  if ($null -ne $Digest.closingSoonCount) {
    $closingCount = [int]$Digest.closingSoonCount
  }

  $unackCount = 0
  if ($null -ne $Digest.unacknowledgedCorrigendaCount) {
    $unackCount = [int]$Digest.unacknowledgedCorrigendaCount
  }

  if ($closingCount -le 0 -and $unackCount -le 0) {
    return $null
  }

  $withinHours = 48
  if ($null -ne $Digest.withinHours -and [int]$Digest.withinHours -gt 0) {
    $withinHours = [int]$Digest.withinHours
  }

  $ids = @()
  if ($null -ne $Digest.closingSoon) {
    $ids = @($Digest.closingSoon | Where-Object { $_ -and $_.id } | ForEach-Object { [string]$_.id } | Sort-Object)
  }

  $pktDate = [DateTime]::UtcNow.AddHours(5).ToString('yyyy-MM-dd')
  $key = "$pktDate|$(($ids -join ','))|$unackCount"

  $parts = @()
  if ($closingCount -gt 0) {
    if ($closingCount -eq 1 -and $Digest.closingSoon -and @($Digest.closingSoon).Count -gt 0 -and $Digest.closingSoon[0].title) {
      $title = [string]$Digest.closingSoon[0].title
      if ($title.Length -gt 70) { $title = $title.Substring(0, 67) + '...' }
      $parts += "1 bid closing within ${withinHours}h: $title"
    } else {
      $parts += "$closingCount bids closing within ${withinHours}h"
    }
  }
  if ($unackCount -gt 0) {
    $parts += "$unackCount unacknowledged corrigenda"
  }

  return @{
    Key = $key
    Title = 'Tender Tracker Alert'
    Body = ($parts -join ' | ')
  }
}

function Format-TrayNetworkSummary {
  param($NetworkStatus)

  if ($null -eq $NetworkStatus -or [string]::IsNullOrWhiteSpace([string]$NetworkStatus.state)) {
    return $null
  }
  $state = [string]$NetworkStatus.state
  if ($state -eq 'offline') {
    return @{ State = 'offline'; MenuTag = 'Network: Offline (paused)'; Tooltip = 'Tender Tracker - Offline (paused)'; Balloon = 'Network offline: scans and document downloads are paused.' }
  }
  if ($state -eq 'degraded') {
    return @{ State = 'degraded'; MenuTag = 'Network: Slow (heavy paused)'; Tooltip = 'Tender Tracker - Slow network'; Balloon = 'Slow network detected: deep scans and PDF downloads are paused; quick scans remain available.' }
  }
  $ms = if ($null -ne $NetworkStatus.latencyMs) { " ($([int]$NetworkStatus.latencyMs)ms)" } else { '' }
  return @{ State = 'online'; MenuTag = "Network: Healthy$ms"; Tooltip = 'Tender Tracker - Online'; Balloon = "Network healthy$ms." }
}

function Open-StandaloneWindow {
  $browser = Resolve-StandaloneBrowser
  if ($browser.Path) {
    if (-not (Test-Path -LiteralPath $script:ProfileDir)) {
      New-Item -ItemType Directory -Path $script:ProfileDir -Force | Out-Null
    }
    $args = @(
      "--app=$script:BaseUrl",
      "--user-data-dir=`"$script:ProfileDir`"",
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1360,860'
    )
    Start-Process -FilePath $browser.Path -ArgumentList $args | Out-Null
  } else {
    Start-Process $script:BaseUrl | Out-Null
  }
}

if ($NoRun) {
  return
}

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\TenderTrackerTrayHost_$($script:Port)", [ref]$createdNew)
if (-not $createdNew) {
  if (-not $StartMinimized) {
    Open-StandaloneWindow
  }
  $mutex.Dispose()
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Net.ServicePointManager]::Expect100Continue = $false

$script:OwnsServer = $false
$script:ServerProcess = $null
$script:ShutdownToken = $null
$script:Stopping = $false
$script:Restarting = $false
$script:ServerCrashWarned = $false
$script:WasScanning = $false
$script:TrayStartedScan = $false
$script:LastDigestAlertKey = ''
$script:LastClosingCount = $null
$script:LastNetworkState = 'online'
$script:LastNetworkPollUtc = [DateTime]::MinValue

function Open-DefaultBrowser {
  Start-Process $script:BaseUrl | Out-Null
}

function Test-ServerHealthy {
  $client = New-Object System.Net.Sockets.TcpClient
  $tcpReady = $false
  try {
    $iar = $client.BeginConnect('127.0.0.1', $script:Port, $null, $null)
    if ($iar.AsyncWaitHandle.WaitOne(150, $false) -and $client.Connected) {
      $client.EndConnect($iar)
      $tcpReady = $true
    }
  } catch {
    $tcpReady = $false
  } finally {
    try { $client.Close() } catch {}
    try { $client.Dispose() } catch {}
  }

  if (-not $tcpReady) {
    return $false
  }

  try {
    $null = Invoke-RestMethod -Uri "$script:BaseUrl/api/scan/status" -Method Get -TimeoutSec 2
    return $true
  } catch {
    return $false
  }
}

function Ensure-ProductionBuild {
  $distHtml = Join-Path $script:ProjectRoot 'dist\index.html'
  $distServer = Join-Path $script:ProjectRoot 'dist-server\server.mjs'
  if ((Test-Path -LiteralPath $distHtml) -and (Test-Path -LiteralPath $distServer)) {
    return
  }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'cmd.exe'
  $psi.Arguments = '/c npm run build'
  $psi.WorkingDirectory = $script:ProjectRoot
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden

  $buildProc = [System.Diagnostics.Process]::Start($psi)
  if ($null -eq $buildProc) {
    throw 'Failed to start npm run build.'
  }
  $buildProc.WaitForExit()
  $code = $buildProc.ExitCode
  $buildProc.Dispose()
  if ($code -ne 0) {
    throw "Production build failed with exit code $code."
  }
}

function Start-TenderServer {
  Ensure-ProductionBuild

  $nodeCmd = Get-Command node.exe -ErrorAction Stop
  $serverBundle = Join-Path $script:ProjectRoot 'dist-server\server.mjs'
  $script:ShutdownToken = New-ShutdownToken

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $nodeCmd.Source
  $psi.Arguments = "`"$serverBundle`" --production"
  $psi.WorkingDirectory = $script:ProjectRoot
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $psi.RedirectStandardOutput = $false
  $psi.RedirectStandardError = $false

  $psi.EnvironmentVariables['PORT'] = "$($script:Port)"
  $psi.EnvironmentVariables['HOST'] = '127.0.0.1'
  $psi.EnvironmentVariables['NODE_ENV'] = 'production'
  $psi.EnvironmentVariables['TENDER_SHUTDOWN_TOKEN'] = $script:ShutdownToken
  if ($DataDir -and $DataDir.Trim()) {
    $psi.EnvironmentVariables['TENDER_DATA_DIR'] = $script:EffectiveDataDir
  }

  $proc = [System.Diagnostics.Process]::Start($psi)
  if ($null -eq $proc) {
    throw 'Failed to start Node.js server process.'
  }
  $script:ServerProcess = $proc
  $script:ServerCrashWarned = $false

  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($proc.HasExited) {
      throw "Tender Tracker server exited early with code $($proc.ExitCode)."
    }
    if (Test-ServerHealthy) {
      return
    }
    Start-Sleep -Milliseconds 300
  }

  throw "Tender Tracker server did not respond on $script:BaseUrl within 20 seconds."
}

function Stop-TenderServer {
  if ($script:OwnsServer -and $null -ne $script:ServerProcess) {
    try {
      if (-not $script:ServerProcess.HasExited) {
        if ($script:ShutdownToken) {
          try {
            $headers = @{ 'X-Shutdown-Token' = $script:ShutdownToken }
            $null = Invoke-RestMethod -Uri "$script:BaseUrl/api/system/shutdown" -Method Post -Headers $headers -TimeoutSec 4
          } catch {
            # Fallback to WaitForExit / Kill below if HTTP shutdown fails
          }
        }
        $exited = $script:ServerProcess.WaitForExit(5000)
        if (-not $exited -and -not $script:ServerProcess.HasExited) {
          try { $script:ServerProcess.Kill() } catch {}
        }
      }
    } catch {
      # Best-effort shutdown
    } finally {
      try { $script:ServerProcess.Dispose() } catch {}
    }
  }
  $script:ServerProcess = $null
  $script:ShutdownToken = $null
}

function Show-TrayBalloon {
  param(
    [string]$Title,
    [string]$Message,
    [System.Windows.Forms.ToolTipIcon]$Icon = [System.Windows.Forms.ToolTipIcon]::Info
  )

  if ($null -ne $script:NotifyIcon -and -not [string]::IsNullOrWhiteSpace($Message)) {
    $script:NotifyIcon.ShowBalloonTip(5000, $Title, $Message, $Icon)
  }
}

function Update-DigestState {
  param([switch]$Notify)

  try {
    $digest = Invoke-RestMethod -Uri "$script:BaseUrl/api/system/digest" -Method Get -TimeoutSec 2
    if ($null -ne $digest.closingSoonCount) {
      $script:LastClosingCount = [int]$digest.closingSoonCount
    }
    if ($Notify) {
      $alert = Get-DigestAlertInfo -Digest $digest
      if ($null -ne $alert -and $alert.Key -ne $script:LastDigestAlertKey) {
        $script:LastDigestAlertKey = $alert.Key
        Show-TrayBalloon -Title $alert.Title -Message $alert.Body
      }
    }
  } catch {
    # Ignore transient poll errors
  }

  $null = Update-NetworkState
}

function Update-NetworkState {
  param([switch]$Force, [switch]$Notify)

  try {
    $uri = if ($Force) { "$script:BaseUrl/api/system/network/check" } else { "$script:BaseUrl/api/system/network" }
    $method = if ($Force) { 'Post' } else { 'Get' }
    $timeout = if ($Force) { 8 } else { 2 }
    $net = Invoke-RestMethod -Uri $uri -Method $method -TimeoutSec $timeout
    $summary = Format-TrayNetworkSummary -NetworkStatus $net
    if ($null -ne $summary) {
      $script:LastNetworkState = $summary.State
      $script:LastNetworkPollUtc = [DateTime]::UtcNow
      if ($Notify) {
        $icon = if ($summary.State -eq 'offline' -or $summary.State -eq 'degraded') { [System.Windows.Forms.ToolTipIcon]::Warning } else { [System.Windows.Forms.ToolTipIcon]::Info }
        Show-TrayBalloon -Title 'Tender Tracker' -Message $summary.Balloon -Icon $icon
      }
      return $summary
    }
  } catch {
    # Ignore transient poll errors
  }
  return $null
}

try {
  if (Test-ServerHealthy) {
    $script:OwnsServer = $false
  } else {
    $script:OwnsServer = $true
    Start-TenderServer
  }
} catch {
  $errMsg = $_.Exception.Message
  Stop-TenderServer
  try { $mutex.ReleaseMutex() } catch {}
  $mutex.Dispose()
  [System.Windows.Forms.MessageBox]::Show(
    "Unable to start Tender Tracker:`n`n$errMsg",
    'Tender Tracker',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
  exit 1
}

$trayIcon = $null
if (Test-Path -LiteralPath $script:IconPath) {
  try {
    $trayIcon = New-Object System.Drawing.Icon($script:IconPath)
  } catch {
    $trayIcon = $null
  }
}
if ($null -eq $trayIcon) {
  $trayIcon = [System.Drawing.SystemIcons]::Application
}

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = $trayIcon
$notifyIcon.Text = Format-TrayTooltip 'Tender Tracker - Online'
$notifyIcon.Visible = $true
$script:NotifyIcon = $notifyIcon

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$openItem = New-Object System.Windows.Forms.ToolStripMenuItem('Open Tender Tracker')
$openItem.Font = New-Object System.Drawing.Font($openItem.Font, [System.Drawing.FontStyle]::Bold)
$openItem.Add_Click({ Open-StandaloneWindow })
[void]$menu.Items.Add($openItem)

$openBrowserItem = New-Object System.Windows.Forms.ToolStripMenuItem('Open in Default Browser')
$openBrowserItem.Add_Click({ Open-DefaultBrowser })
[void]$menu.Items.Add($openBrowserItem)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$quickScanItem = New-Object System.Windows.Forms.ToolStripMenuItem('Run Quick Scan')
$quickScanItem.Add_Click({
  try {
    $resp = Invoke-RestMethod -Uri "$script:BaseUrl/api/scan/start" -Method Post -ContentType 'application/json' -Body '{"depth":"quick"}' -TimeoutSec 4
    if ($resp -and (-not [bool]$resp.isScanning) -and -not [string]::IsNullOrWhiteSpace([string]$resp.pausedReason)) {
      Show-TrayBalloon -Title 'Tender Tracker' -Message ([string]$resp.pausedReason) -Icon ([System.Windows.Forms.ToolTipIcon]::Warning)
      $null = Update-NetworkState
      return
    }
    $script:TrayStartedScan = $true
    $script:WasScanning = $true
    if ($null -ne $statusTimer -and $statusTimer.Interval -ne 10000) {
      $statusTimer.Interval = 10000
    }
    Show-TrayBalloon -Title 'Tender Tracker' -Message 'Quick scan started in the background.'
  } catch {
    Show-TrayBalloon -Title 'Tender Tracker' -Message 'Could not start quick scan.' -Icon ([System.Windows.Forms.ToolTipIcon]::Warning)
  }
})
[void]$menu.Items.Add($quickScanItem)

$deepScanItem = New-Object System.Windows.Forms.ToolStripMenuItem('Run Deep Scan')
$deepScanItem.Add_Click({
  try {
    $resp = Invoke-RestMethod -Uri "$script:BaseUrl/api/scan/start" -Method Post -ContentType 'application/json' -Body '{"depth":"deep"}' -TimeoutSec 4
    if ($resp -and (-not [bool]$resp.isScanning) -and -not [string]::IsNullOrWhiteSpace([string]$resp.pausedReason)) {
      Show-TrayBalloon -Title 'Tender Tracker' -Message ([string]$resp.pausedReason) -Icon ([System.Windows.Forms.ToolTipIcon]::Warning)
      $null = Update-NetworkState
      return
    }
    $script:TrayStartedScan = $true
    $script:WasScanning = $true
    if ($null -ne $statusTimer -and $statusTimer.Interval -ne 10000) {
      $statusTimer.Interval = 10000
    }
    Show-TrayBalloon -Title 'Tender Tracker' -Message 'Deep multi-page scan started in the background.'
  } catch {
    Show-TrayBalloon -Title 'Tender Tracker' -Message 'Could not start deep scan.' -Icon ([System.Windows.Forms.ToolTipIcon]::Warning)
  }
})
[void]$menu.Items.Add($deepScanItem)

$initialStatusText = if ($script:OwnsServer) { 'Status: Online' } else { 'Status: Attached to existing server' }
$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem($initialStatusText)
$statusItem.Enabled = $false
[void]$menu.Items.Add($statusItem)
$script:StatusItem = $statusItem

$recheckNetItem = New-Object System.Windows.Forms.ToolStripMenuItem('Recheck Network')
$recheckNetItem.Add_Click({
  $summary = Update-NetworkState -Force -Notify
  if ($null -ne $summary -and -not $script:WasScanning) {
    $prefix = if ($script:OwnsServer) { 'Online' } else { 'Attached' }
    if ($summary.State -eq 'offline' -or $summary.State -eq 'degraded') {
      $script:StatusItem.Text = "Status: $prefix | $($summary.MenuTag)"
      $script:NotifyIcon.Text = Format-TrayTooltip $summary.Tooltip
    } else {
      $script:StatusItem.Text = "Status: $prefix | $($summary.MenuTag)"
      $script:NotifyIcon.Text = Format-TrayTooltip "Tender Tracker - $prefix"
    }
  }
})
[void]$menu.Items.Add($recheckNetItem)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$openDataItem = New-Object System.Windows.Forms.ToolStripMenuItem('Open Data Folder')
$openDataItem.Add_Click({
  if (-not (Test-Path -LiteralPath $script:EffectiveDataDir)) {
    New-Item -ItemType Directory -Path $script:EffectiveDataDir -Force | Out-Null
  }
  Start-Process explorer.exe -ArgumentList "`"$script:EffectiveDataDir`"" | Out-Null
})
[void]$menu.Items.Add($openDataItem)

$openLogItem = New-Object System.Windows.Forms.ToolStripMenuItem('Open Latest Log')
$openLogItem.Add_Click({
  $logsDir = Join-Path $script:EffectiveDataDir 'logs'
  $latest = $null
  if (Test-Path -LiteralPath $logsDir) {
    $latest = Get-ChildItem -LiteralPath $logsDir -Filter 'session-*.log' -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
  }
  if ($latest) {
    Start-Process notepad.exe -ArgumentList "`"$($latest.FullName)`"" | Out-Null
  } else {
    Show-TrayBalloon -Title 'Tender Tracker' -Message 'No session logs found yet.'
  }
})
[void]$menu.Items.Add($openLogItem)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$restartItem = New-Object System.Windows.Forms.ToolStripMenuItem('Restart Server')
$restartItem.Enabled = $script:OwnsServer
$restartItem.Add_Click({
  if (-not $script:OwnsServer -or $script:Restarting) { return }
  $script:Restarting = $true
  $statusTimer.Stop()
  try {
    $script:StatusItem.Text = 'Status: Restarting...'
    $script:NotifyIcon.Text = Format-TrayTooltip 'Tender Tracker - Restarting...'
    Stop-TenderServer
    Start-TenderServer
    $script:StatusItem.Text = 'Status: Online'
    $script:NotifyIcon.Text = Format-TrayTooltip 'Tender Tracker - Online'
    Show-TrayBalloon -Title 'Tender Tracker' -Message 'Server restarted cleanly.'
  } catch {
    $script:StatusItem.Text = 'Status: Restart failed'
    Show-TrayBalloon -Title 'Tender Tracker' -Message "Server restart failed: $($_.Exception.Message)" -Icon ([System.Windows.Forms.ToolTipIcon]::Error)
  } finally {
    $script:Restarting = $false
    if (-not $script:Stopping) {
      $statusTimer.Start()
    }
  }
})
[void]$menu.Items.Add($restartItem)
$script:RestartItem = $restartItem

$quitItem = New-Object System.Windows.Forms.ToolStripMenuItem('Quit Tender Tracker')
$quitItem.Add_Click({
  $script:Stopping = $true
  Stop-TenderServer
  [System.Windows.Forms.Application]::Exit()
})
[void]$menu.Items.Add($quitItem)

$notifyIcon.ContextMenuStrip = $menu
$notifyIcon.Add_DoubleClick({ Open-StandaloneWindow })
$notifyIcon.Add_BalloonTipClicked({ Open-StandaloneWindow })

$sessionEndingHandler = [Microsoft.Win32.SessionEndingEventHandler]{
  param($sender, $e)
  $script:Stopping = $true
  Stop-TenderServer
  [System.Windows.Forms.Application]::Exit()
}
[Microsoft.Win32.SystemEvents]::add_SessionEnding($sessionEndingHandler)

$statusTimer = New-Object System.Windows.Forms.Timer
$statusTimer.Interval = 60000
$statusTimer.Add_Tick({
  if ($script:Stopping -or $script:Restarting) { return }

  if ($script:OwnsServer -and $null -ne $script:ServerProcess -and $script:ServerProcess.HasExited) {
    $script:StatusItem.Text = 'Status: Server stopped'
    $script:NotifyIcon.Text = Format-TrayTooltip 'Tender Tracker - Server stopped'
    if (-not $script:ServerCrashWarned) {
      $script:ServerCrashWarned = $true
      Show-TrayBalloon -Title 'Tender Tracker' -Message 'Background server stopped unexpectedly. Click Restart Server in the tray menu.' -Icon ([System.Windows.Forms.ToolTipIcon]::Error)
    }
    return
  }

  try {
    $scanStatus = Invoke-RestMethod -Uri "$script:BaseUrl/api/scan/status" -Method Get -TimeoutSec 2
    $isScanning = [bool]$scanStatus.isScanning

    $desiredInterval = if ($isScanning) { 10000 } else { 60000 }
    if ($statusTimer.Interval -ne $desiredInterval) {
      $statusTimer.Interval = $desiredInterval
    }

    if ($script:WasScanning -and -not $isScanning) {
      if ($script:TrayStartedScan) {
        $script:TrayStartedScan = $false
        $newCount = if ($null -ne $scanStatus.newTendersFound) { [int]$scanStatus.newTendersFound } else { 0 }
        $corrCount = if ($null -ne $scanStatus.corrigendaFound) { [int]$scanStatus.corrigendaFound } else { 0 }
        Show-TrayBalloon -Title 'Tender Tracker' -Message "Scan complete: $newCount new, $corrCount amended."
      }
      Update-DigestState -Notify
    }
    $script:WasScanning = $isScanning

    if ($isScanning) {
      $pct = if ($null -ne $scanStatus.progressPercent) { [int]$scanStatus.progressPercent } else { 0 }
      $portalLabel = if ($scanStatus.currentPortal) { [string]$scanStatus.currentPortal } else { 'Scanning portals' }
      $script:StatusItem.Text = "Status: Scanning ($pct%) - $portalLabel"
      $script:NotifyIcon.Text = Format-TrayTooltip "Tender Tracker - Scanning ($pct%)"
    } else {
      if (([DateTime]::UtcNow - $script:LastNetworkPollUtc).TotalSeconds -ge 120 -or (-not [string]::IsNullOrWhiteSpace([string]$scanStatus.pausedReason))) {
        $null = Update-NetworkState
      }
      $prefix = if ($script:OwnsServer) { 'Online' } else { 'Attached' }
      $closingCount = $script:LastClosingCount

      if ($script:LastNetworkState -eq 'offline') {
        $script:StatusItem.Text = "Status: $prefix | Network: Offline (paused)"
        $script:NotifyIcon.Text = Format-TrayTooltip 'Tender Tracker - Offline (paused)'
      } elseif ($script:LastNetworkState -eq 'degraded') {
        $script:StatusItem.Text = "Status: $prefix | Network: Slow (heavy paused)"
        $script:NotifyIcon.Text = Format-TrayTooltip 'Tender Tracker - Slow network'
      } elseif ($null -ne $closingCount -and $closingCount -gt 0) {
        $script:StatusItem.Text = "Status: $prefix | $closingCount closing <=48h"
        $script:NotifyIcon.Text = Format-TrayTooltip "Tender Tracker - $prefix ($closingCount closing soon)"
      } else {
        $script:StatusItem.Text = "Status: $prefix"
        $script:NotifyIcon.Text = Format-TrayTooltip "Tender Tracker - $prefix"
      }
    }
  } catch {
    $script:StatusItem.Text = 'Status: Reconnecting...'
    $script:NotifyIcon.Text = Format-TrayTooltip 'Tender Tracker - Reconnecting...'
  }
})
$statusTimer.Start()

$digestTimer = New-Object System.Windows.Forms.Timer
$digestTimer.Interval = 15000
$digestTimer.Add_Tick({
  if ($script:Stopping -or $script:Restarting) { return }
  if ($digestTimer.Interval -ne 900000) {
    $digestTimer.Interval = 900000
  }

  Update-DigestState -Notify
})
$digestTimer.Start()

if ($StartMinimized) {
  Show-TrayBalloon -Title 'Tender Tracker' -Message 'Running quietly in the Windows system tray.'
} else {
  Open-StandaloneWindow
}

try {
  [System.Windows.Forms.Application]::Run()
} finally {
  $script:Stopping = $true
  try { $statusTimer.Stop(); $statusTimer.Dispose() } catch {}
  try { $digestTimer.Stop(); $digestTimer.Dispose() } catch {}
  try { [Microsoft.Win32.SystemEvents]::remove_SessionEnding($sessionEndingHandler) } catch {}
  try {
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
  } catch {}
  try { $menu.Dispose() } catch {}
  if ($null -ne $trayIcon -and $trayIcon -ne [System.Drawing.SystemIcons]::Application) {
    try { $trayIcon.Dispose() } catch {}
  }
  Stop-TenderServer
  try { $mutex.ReleaseMutex() } catch {}
  $mutex.Dispose()
}
