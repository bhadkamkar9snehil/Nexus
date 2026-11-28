param(
    [string]$TargetDir,
    [switch]$DefinitionsOnly
)
$ErrorActionPreference = 'Stop'

# Only a verified Nexus monitor task/process is eligible for takeover.
# This script never stops arbitrary processes that happen to use port 8769.
function Get-NexusTaskAccessMessage([string]$owner) {
    return "[NexusElevationRequired] Windows denied access to SharedHarness-Monitor (owner: $owner). " +
        'Retry the installer as administrator while signed in to the account where Nexus should be installed. ' +
        'If the task belongs to another user, have that user stop and remove their Nexus startup task first.'
}

function Test-NexusAccessDenied([Management.Automation.ErrorRecord]$failure) {
    return $failure.CategoryInfo.Category -eq [Management.Automation.ErrorCategory]::PermissionDenied -or
        $failure.Exception.HResult -eq -2147024891 -or
        $failure.FullyQualifiedErrorId -match '(?:^|,)HRESULT 0x80070005(?:,|$)'
}

function Get-NexusMonitorScript([string]$arguments) {
    $match = [regex]::Match($arguments, '(?i)^\s*(?:(?:-NoProfile|-NonInteractive|-WindowStyle\s+Hidden|-ExecutionPolicy\s+Bypass)\s+)*-File\s+(?:"([^"]+)"|([^\s"]+))\s+Run(?:\s|$)')
    if (-not $match.Success) { return }
    if ($match.Groups[1].Success) { return $match.Groups[1].Value }
    return $match.Groups[2].Value
}

function Resolve-NexusMonitorTask($task) {
    if (-not $task) { return $null }
    $actions = @($task.Actions)
    if ($actions.Count -ne 1 -or [IO.Path]::GetFileName([string]$actions[0].Execute) -notin @('powershell.exe', 'pwsh.exe')) {
        throw 'The existing monitor task is not a recognized Nexus task.'
    }
    $scriptPath = Get-NexusMonitorScript $actions[0].Arguments
    if (-not $scriptPath) { throw 'The existing monitor task has no recognized script path.' }
    if (-not [IO.Path]::IsPathRooted($scriptPath) -or
        [IO.Path]::GetFileName($scriptPath) -ne 'Monitor.ps1') {
        throw 'The existing monitor task is not a Nexus monitor.'
    }
    $absolute = [IO.Path]::GetFullPath($scriptPath)
    return [IO.Path]::GetDirectoryName($absolute).TrimEnd('\')
}

function Resolve-NexusTaskOwnerSid([string]$owner) {
    if ($owner -match '^S-1-') { return [Security.Principal.SecurityIdentifier]::new($owner).Value }
    return [Security.Principal.NTAccount]::new($owner).Translate([Security.Principal.SecurityIdentifier]).Value
}

function Assert-NexusTakeoverOwner([string]$currentSid, [string]$taskSid, [bool]$administrator) {
    if ($currentSid -ne $taskSid -and -not $administrator) {
        throw '[NexusElevationRequired] The monitor belongs to another Windows user. Retry as administrator from the intended Nexus account.'
    }
}

function Get-NexusProcessOwnerSid($process) {
    try {
        $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop
        if ($owner.ReturnValue -eq 0) { return $owner.Sid }
    } catch { return $null }
}

# Helpers that run from the install folder (the search daemon outlives the process that started it) keep their files
# locked. They match by exact path under <root>\runtime only, never by name alone.
$NexusRuntimeHelpers = @('cua-driver.exe','cua-driver-uia.exe','uffs.exe','uffsd.exe','uffs-broker.exe','rg.exe')

function Test-NexusProcessCommand($process, [string[]]$roots) {
    $name = [string]$process.Name
    $monitorScript = $null
    $arguments = ([string]$process.CommandLine) -replace '^\s*(?:"[^"]+"|[^\s"]+)\s+', ''
    if ($name -ieq 'node.exe') {
        $first = [regex]::Match($arguments, '^(?:"([^"]+)"|([^\s"]+))(?:\s|$)')
        $nodeScript = $first.Groups[1].Value + $first.Groups[2].Value
    }
    if ($name -in @('powershell.exe','pwsh.exe')) {
        $monitorScript = Get-NexusMonitorScript $arguments
    }
    foreach ($root in $roots) {
        if ($name -in $NexusRuntimeHelpers -and $process.ExecutablePath -ieq (Join-Path $root "runtime\$name")) { return $true }
        if ($name -ieq 'Nexus.Desktop.exe' -and $process.ExecutablePath -ieq (Join-Path $root 'Nexus.Desktop.exe')) { return $true }
        if ($name -ieq 'node.exe' -and $nodeScript -in @((Join-Path $root 'monitor.mjs'), (Join-Path $root 'jev-use\start.mjs'))) { return $true }
        if ($monitorScript -and $monitorScript -ieq (Join-Path $root 'Monitor.ps1')) { return $true }
    }
    return $false
}

function Test-NexusAuthorizedProcess($process, [string]$currentSid, [string]$taskSid, [string]$taskRoot) {
    $ownerSid = Get-NexusProcessOwnerSid $process
    if ($ownerSid -eq $currentSid) { return $true }
    return $taskRoot -and $ownerSid -eq $taskSid -and (Test-NexusProcessCommand $process @($taskRoot))
}

function Test-NexusInstallDestination([string]$installDirectory) {
    if ([string]::IsNullOrWhiteSpace($installDirectory)) { throw 'TargetDir is required.' }
    $absolute = [IO.Path]::GetFullPath($installDirectory)
    if ($absolute -eq [IO.Path]::GetPathRoot($absolute)) { throw 'Choose a Nexus subfolder, not a drive root.' }
    $absolute = $absolute.TrimEnd('\')
    if ($absolute -like '*\AppData\*') { throw 'Choose a Nexus installation folder outside AppData.' }
    if (Test-Path -LiteralPath (Join-Path $absolute '.git')) { throw 'Cannot install Nexus into a Git working directory.' }
    if (Test-Path -LiteralPath $absolute -PathType Leaf) { throw 'The chosen Nexus folder is an existing file. Choose a directory.' }
    $probe = Join-Path $absolute ('.nexus-write-test-' + [guid]::NewGuid().ToString('N'))
    $stream = $null
    try {
        New-Item -ItemType Directory -Path $absolute -Force -ErrorAction Stop | Out-Null
        $stream = [IO.File]::Open($probe, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    } catch {
        throw ('Cannot write to Nexus install folder "{0}": {1}. Choose a writable folder or run the installer as administrator.' -f $absolute, $_.Exception.Message)
    } finally {
        if ($stream) { $stream.Dispose() }
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
    }
    return $absolute
}

function Get-NexusPortBlockerDescription($listeners) {
    $ids = @($listeners | ForEach-Object { [int]$_.OwningProcess } | Where-Object { $_ -gt 0 } | Select-Object -Unique)
    $names = @($ids | ForEach-Object {
        $id = $_
        $process = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($process) { '{0} (PID {1})' -f $process.ProcessName, $id }
        else { 'PID {0}' -f $id }
    })
    if ($names.Count -eq 0) { return 'an unidentified process' }
    return ($names -join ', ')
}

function Assert-NexusMonitorListeners($listeners, [int]$expectedPid) {
    if ($expectedPid -gt 0 -and $expectedPid -notin $listeners.OwningProcess) {
        throw 'The reported Nexus monitor PID does not own port 8769. No process was stopped.'
    }
    $unexpected = @($listeners | Where-Object { $_.OwningProcess -ne $expectedPid -or $expectedPid -eq 0 })
    if ($unexpected.Count -gt 0) {
        $blockers = Get-NexusPortBlockerDescription $unexpected
        throw "Port 8769 is used by $blockers, but Nexus cannot verify its identity. Close that application, then retry. No process was stopped."
    }
}

if ($DefinitionsOnly) { return }
# A parent PowerShell 7 process can inject incompatible modules into Windows PowerShell.
if ($PSVersionTable.PSEdition -eq 'Desktop') {
    $env:PSModulePath = Join-Path $PSHOME 'Modules'
}
$target = Test-NexusInstallDestination $TargetDir

$taskName = 'SharedHarness-Monitor'
$taskPath = '\'
try {
    $task = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop
} catch {
    if (Test-NexusAccessDenied $_) { throw (Get-NexusTaskAccessMessage 'unavailable') }
    if ($_.CategoryInfo.Category -ne [Management.Automation.ErrorCategory]::ObjectNotFound) { throw }
    $task = $null
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$currentSid = $identity.User.Value
$taskRoot = Resolve-NexusMonitorTask $task
$taskSid = $currentSid
if ($taskRoot) {
    $taskSid = Resolve-NexusTaskOwnerSid $task.Principal.UserId
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    Assert-NexusTakeoverOwner $currentSid $taskSid ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
    if ($taskSid -ne $currentSid) {
        foreach ($marker in 'Monitor.ps1','monitor.mjs','version.mjs') {
            if (-not (Test-Path -LiteralPath (Join-Path $taskRoot $marker) -PathType Leaf)) {
                throw 'Cannot verify the other Windows user task points to a Nexus installation.'
            }
        }
    }
}
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
$serverPid = 0
try { $server = Invoke-RestMethod 'http://127.0.0.1:8769/monitor-status' -TimeoutSec 2 } catch {}
if ($server) {
    if ($server.application -ne 'shared-computer-use-monitor' -or
        -not [IO.Path]::IsPathRooted([string]$server.root) -or
        -not [int]::TryParse([string]$server.pid, [ref]$serverPid) -or $serverPid -le 0) {
        throw 'Port 8769 does not report a valid Nexus monitor. No process was stopped.'
    }
    $serverRoot = [IO.Path]::GetFullPath([string]$server.root).TrimEnd('\')
    $serverProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $serverPid)
    if (-not $serverProcess -or -not (Test-NexusAuthorizedProcess $serverProcess $currentSid $taskSid $taskRoot) -or
        -not (Test-NexusProcessCommand $serverProcess @($serverRoot))) {
        throw 'Port 8769 is not owned by a verified Nexus monitor process. No process was stopped.'
    }
    $roots += $serverRoot
}
$listeners = @(Get-NetTCPConnection -LocalPort 8769 -State Listen -ErrorAction SilentlyContinue)
Assert-NexusMonitorListeners $listeners $serverPid
$roots = @($roots | Select-Object -Unique)

# Validate every selected process before changing any task or process.
$processes = @(Get-CimInstance Win32_Process |
    Where-Object { $_.Name -in (@('node.exe','powershell.exe','pwsh.exe','Nexus.Desktop.exe') + $NexusRuntimeHelpers) })
$owned = @($processes | Where-Object {
    Test-NexusProcessCommand $_ $roots
})
foreach ($process in $owned) {
    if (-not (Test-NexusAuthorizedProcess $process $currentSid $taskSid $taskRoot)) {
        throw ('Nexus process PID {0} belongs to another user. No process was stopped.' -f $process.ProcessId)
    }
}

# Save the previous task definition before the transfer. Never delete old installations or user data.
$backupFile = $null
$taskWasRunning = $task.State -eq 'Running'
try {
    if ($task) {
        $backupDir = Join-Path $env:LOCALAPPDATA 'Nexus\installer-migrations'
        New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
        $backupFile = Join-Path $backupDir ('SharedHarness-Monitor-' + [guid]::NewGuid().ToString('N') + '.xml')
        try {
            Export-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop |
                Set-Content -LiteralPath $backupFile -Encoding UTF8
            if ($taskWasRunning) { Stop-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop }
            Unregister-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Confirm:$false -ErrorAction Stop
        } catch {
            if (Test-NexusAccessDenied $_) { throw (Get-NexusTaskAccessMessage $task.Principal.UserId) }
            throw
        }
    }

    foreach ($process in $owned) {
        $identityDeadline = [Diagnostics.Stopwatch]::StartNew()
        do {
            $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $process.ProcessId) -ErrorAction Stop
            if (-not $current -or $current.CreationDate -ne $process.CreationDate) { break }
            if ((Test-NexusProcessCommand $current $roots) -and
                (Test-NexusAuthorizedProcess $current $currentSid $taskSid $taskRoot)) {
                try {
                    Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
                } catch {
                    $remaining = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $process.ProcessId) -ErrorAction Stop
                    if ($remaining -and $remaining.CreationDate -eq $process.CreationDate) { throw }
                }
                break
            }
            # Task Scheduler can clear the command line or owner while the host is exiting.
            if ($identityDeadline.Elapsed.TotalSeconds -ge 2) {
                throw ('Nexus process PID {0} changed identity during takeover.' -f $process.ProcessId)
            }
            Start-Sleep -Milliseconds 100
        } while ($true)
    }
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    do {
        $left = @($owned | Where-Object {
            $remaining = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $_.ProcessId) -ErrorAction Stop
            $remaining -and $remaining.CreationDate -eq $_.CreationDate
        })
        if ($left.Count -eq 0) { break }
        Start-Sleep -Milliseconds 250
    } while ($deadline.Elapsed.TotalSeconds -lt 8)
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
            if (-not (Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue)) {
                $xml = Get-Content -LiteralPath $backupFile -Raw
                Register-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Xml $xml -ErrorAction Stop | Out-Null
            }
            $prior = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue
            if ($taskWasRunning -and $prior -and $prior.State -ne 'Running') {
                Start-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop
            }
        } catch {
            Write-Warning ('Previous monitor task could not restart. Restore it from: ' + $backupFile)
        }
    }
    throw
}
