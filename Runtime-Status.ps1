$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName 'SharedHarness-Monitor' -ErrorAction SilentlyContinue
$broker = Get-Service -Name UffsAccessBroker -ErrorAction SilentlyContinue
$info = if ($task) { Get-ScheduledTaskInfo -TaskName 'SharedHarness-Monitor' } else { $null }
[pscustomobject]@{
    startup = [bool]$task
    taskState = if ($task) { $task.State.ToString() } else { 'Missing' }
    lastTaskResult = if ($info) { $info.LastTaskResult } else { $null }
    restartCount = if ($task) { $task.Settings.RestartCount } else { 0 }
    broker = if ($broker) { $broker.Status.ToString() } else { 'Missing' }
} | ConvertTo-Json -Compress
