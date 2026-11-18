param([Parameter(Mandatory=$true)][string]$InstallDir, [Parameter(Mandatory=$true)][string]$ResultFile)
$ErrorActionPreference = 'Stop'
try {
    $target = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
    if ($target -like '*\AppData\*') { throw 'Choose a folder outside AppData, such as Documents\Nexus Harness.' }
    if (Test-Path -LiteralPath (Join-Path $target '.git')) { throw 'Choose an installation folder, not a Git working directory.' }
    $task = Get-ScheduledTask -TaskName 'SharedHarness-Monitor' -ErrorAction SilentlyContinue
    $monitor = Join-Path $target 'Monitor.ps1'
    if ($task -and $task.Actions.Arguments -notlike ('*-File "' + $monitor + '" *')) {
        throw 'Another Nexus installation owns the monitor. It was not changed. Use that installation or migrate it deliberately before installing another.'
    }
    if ($task -and $task.State -eq 'Running') {
        throw 'Nexus is running from this folder. Close Nexus and stop its monitor before upgrading.'
    }
    try { $server = Invoke-RestMethod 'http://127.0.0.1:8769/monitor-status' -TimeoutSec 2 } catch { $server = $null }
    if ($server -and ($server.application -ne 'shared-computer-use-monitor' -or $server.root -ne $target)) {
        throw 'Another Nexus installation owns the monitor port. It was not changed.'
    }
    exit 0
} catch {
    [IO.File]::WriteAllText($ResultFile, $_.Exception.Message, (New-Object Text.UTF8Encoding($false)))
    exit 1
}
