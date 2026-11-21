param(
    [string]$TargetDir,
    [switch]$DefinitionsOnly
)
$ErrorActionPreference = 'Stop'

# Only a verified Nexus monitor task/process is eligible for takeover.
# This script never stops arbitrary processes that happen to use port 8769.
function Resolve-NexusMonitorTask($task) {
    if (-not $task) { return $null }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $owner = [string]$task.Principal.UserId
    $matchesUser = $owner -in @($identity.Name, $identity.User.Value)
    if (-not $matchesUser) {
        try {
            $resolvedSid = (New-Object Security.Principal.NTAccount($owner)).Translate(
                [Security.Principal.SecurityIdentifier]).Value
            $matchesUser = $resolvedSid -eq $identity.User.Value
        } catch { $matchesUser = $false }
    }
    if (-not $matchesUser) {
        throw 'The monitor task belongs to a different Windows user. No process was stopped.'
    }
    $actions = @($task.Actions)
    if ($actions.Count -ne 1 -or [IO.Path]::GetFileName([string]$actions[0].Execute) -notin @('powershell.exe', 'pwsh.exe')) {
        throw 'The existing monitor task is not a recognized Nexus task.'
    }
    $arguments = [string]$actions[0].Arguments
    $match = [regex]::Match($arguments, '(?i)(?:^|\s)-File\s+(?:"([^"]+)"|([^\s]+))')
    if (-not $match.Success) { throw 'The existing monitor task has no recognized script path.' }
    $scriptPath = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
    if (-not [IO.Path]::IsPathRooted($scriptPath) -or
        [IO.Path]::GetFileName($scriptPath) -ne 'Monitor.ps1') {
        throw 'The existing monitor task is not a Nexus monitor.'
    }
    $absolute = [IO.Path]::GetFullPath($scriptPath)
    return [IO.Path]::GetDirectoryName($absolute).TrimEnd('\')
}

function Test-NexusProcessOwner($process) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwner -ErrorAction Stop
        return $owner.ReturnValue -eq 0 -and
            ($owner.Domain + '\' + $owner.User) -ieq $identity.Name
    } catch { return $false }
}

function Test-NexusProcessCommand($process, [string[]]$roots) {
    $name = [string]$process.Name
    $cmd = [string]$process.CommandLine
    foreach ($root in $roots) {
        $root = $root.TrimEnd('\')
        if ($name -ieq 'Nexus.Desktop.exe' -and
            [string]::Equals([string]$process.ExecutablePath, (Join-Path $root 'Nexus.Desktop.exe'), [StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
        if ($name -ieq 'node.exe') {
            foreach ($script in @((Join-Path $root 'monitor.mjs'), (Join-Path $root 'jev-use\start.mjs'))) {
                $pattern = '(?:^|\s)"?' + [regex]::Escape($script) + '"?(?=\s|$)'
                if ($cmd -match $pattern) { return $true }
            }
        }
        if ($name -in @('powershell.exe','pwsh.exe')) {
            $script = Join-Path $root 'Monitor.ps1'
            $pattern = '(?i)(?:^|\s)-File\s+"?' + [regex]::Escape($script) + '"?(?=\s|$)'
            if ($cmd -match $pattern -and $cmd -match '(?i)(?:^|\s)Run(?:\s|$)') { return $true }
        }
    }
    return $false
}

if ($DefinitionsOnly) { return }
if ([string]::IsNullOrWhiteSpace($TargetDir)) { throw 'TargetDir is required.' }

$target = [IO.Path]::GetFullPath($TargetDir).TrimEnd('\')
if ($target -like '*\AppData\*') { throw 'Choose a Nexus installation folder outside AppData.' }
if (Test-Path -LiteralPath (Join-Path $target '.git')) { throw 'Cannot install Nexus into a Git working directory.' }

$taskName = 'SharedHarness-Monitor'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$taskRoot = Resolve-NexusMonitorTask $task
$roots = @($target)
if ($taskRoot) { $roots += $taskRoot }
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{E41F1F1C-57B8-49BB-B11D-79DC2A9A0622}_is1'
$installed = Get-ItemProperty -LiteralPath $uninstallKey -ErrorAction SilentlyContinue
if ($installed.InstallLocation -and [IO.Path]::IsPathRooted([string]$installed.InstallLocation)) {
    $installedRoot = [IO.Path]::GetFullPath([string]$installed.InstallLocation).TrimEnd('\')
    if ((Test-Path -LiteralPath (Join-Path $installedRoot 'Monitor.ps1')) -or
        (Test-Path -LiteralPath (Join-Path $installedRoot 'Nexus.Desktop.exe'))) { $roots += $installedRoot }
}

# The HTTP response is evidence only when the process identity agrees.
$server = $null
try { $server = Invoke-RestMethod 'http://127.0.0.1:8769/monitor-status' -TimeoutSec 2 } catch {}
if ($server) {
    if ($server.application -ne 'shared-computer-use-monitor' -or
        -not [IO.Path]::IsPathRooted([string]$server.root) -or
        [string]$server.pid -notmatch '^\d{1,10}$') {
        throw 'Port 8769 does not report a valid Nexus monitor. No process was stopped.'
    }
    $serverRoot = [IO.Path]::GetFullPath([string]$server.root).TrimEnd('\')
    $serverProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$server.pid)
    if (-not $serverProcess -or -not (Test-NexusProcessOwner $serverProcess) -or
        -not (Test-NexusProcessCommand $serverProcess @($serverRoot))) {
        throw 'Port 8769 is not owned by a verified Nexus monitor process. No process was stopped.'
    }
    $roots += $serverRoot
} else {
    # An unrecognized listener is not permission to terminate an arbitrary program.
    $listeners = @(Get-NetTCPConnection -LocalPort 8769 -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 0) {
        throw 'Port 8769 is in use, but a Nexus monitor could not be verified. No process was stopped.'
    }
}
$roots = @($roots | Select-Object -Unique)

# Validate every selected process before changing any task or process.
$processes = @(Get-CimInstance Win32_Process |
    Where-Object { $_.Name -in @('node.exe','powershell.exe','pwsh.exe','Nexus.Desktop.exe') })
$owned = @($processes | Where-Object {
    Test-NexusProcessCommand $_ $roots
})
foreach ($process in $owned) {
    if (-not (Test-NexusProcessOwner $process)) {
        throw ('Nexus process PID {0} belongs to another user. No process was stopped.' -f $process.ProcessId)
    }
}

# Save the previous task definition before the transfer. Never delete old installations or user data.
$backupFile = $null
try {
if ($task) {
    $backupDir = Join-Path $env:LOCALAPPDATA 'Nexus\installer-migrations'
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    $backupFile = Join-Path $backupDir ('SharedHarness-Monitor-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.xml')
    Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath $backupFile -Encoding UTF8
    if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop }
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
}

foreach ($process in $owned) {
    $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $process.ProcessId) -ErrorAction SilentlyContinue
    if (-not $current) { continue }
    if ($current.CreationDate -ne $process.CreationDate -or
        -not (Test-NexusProcessCommand $current $roots) -or
        -not (Test-NexusProcessOwner $current)) {
        throw ('Nexus process PID {0} changed identity during takeover.' -f $process.ProcessId)
    }
    Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
}
$deadline = [Diagnostics.Stopwatch]::StartNew()
while ($deadline.Elapsed.TotalSeconds -lt 8) {
    $left = @($owned | Where-Object {
        Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    })
    if ($left.Count -eq 0) { break }
    Start-Sleep -Milliseconds 250
}
if ($left.Count -gt 0) { throw 'Nexus processes did not exit. Close them before installing.' }
$portDeadline = [Diagnostics.Stopwatch]::StartNew()
do {
    $bound = @(Get-NetTCPConnection -LocalPort 8769 -State Listen -ErrorAction SilentlyContinue)
    if ($bound.Count -eq 0) { break }
    Start-Sleep -Milliseconds 250
} while ($portDeadline.Elapsed.TotalSeconds -lt 6)
if ($bound.Count -gt 0) { throw 'Port 8769 is still occupied after Nexus process shutdown. Installation was not continued.' }
Write-Host ('Nexus monitor takeover complete: {0} process(es) stopped; old monitor task removed; {1} known root(s).' -f $owned.Count, $roots.Count)
} catch {
    # If takeover stops part-way, restore the prior monitor task when possible.
    # Keep old installation folders and user data intact, even when recovery fails.
    if ($task -and $backupFile -and (Test-Path -LiteralPath $backupFile)) {
        try {
            if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
                $xml = Get-Content -LiteralPath $backupFile -Raw
                Register-ScheduledTask -TaskName $taskName -Xml $xml -Force -ErrorAction Stop | Out-Null
            }
            $prior = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            if ($prior -and $prior.State -ne 'Running') { Start-ScheduledTask -TaskName $taskName -ErrorAction Stop }
        } catch {
            Write-Warning ('Previous monitor task could not restart. Restore it from: ' + $backupFile)
        }
    }
    throw
}
