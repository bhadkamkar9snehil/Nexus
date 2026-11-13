param([ValidateSet('Start','Stop','Status','InstallStartup','Run','Open')][string]$Action='Start',[switch]$OpenAtSignIn)
$ErrorActionPreference='Stop'
$url='http://127.0.0.1:8769'
$name='SharedHarness-Monitor'
$script=Join-Path $PSScriptRoot 'Monitor.ps1'
$powershell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$bundled=Join-Path $PSScriptRoot 'runtime\node.exe'
$node=if(Test-Path -LiteralPath $bundled){$bundled}else{(Get-Command node -ErrorAction Stop).Source}
function Get-Monitor {
    try {$reply=Invoke-RestMethod "$url/monitor-status" -TimeoutSec 2}
    catch {if($_.Exception.Response){throw 'Port 8769 belongs to an unknown or older server. Inspect it before continuing.'};return $null}
    if($reply.application -ne 'shared-computer-use-monitor' -or $reply.root -ne $PSScriptRoot){throw 'Port 8769 belongs to another monitor installation.'}
    return $reply
}
$task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if($task -and $task.Actions.Arguments -notlike ('*-File "'+$script+'" *')){throw 'Existing monitor task belongs to another installation; it was preserved.'}
if($Action -eq 'InstallStartup'){
    $user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
    $arguments='-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$script+'" Run -OpenAtSignIn'
    $actionObject=New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $PSScriptRoot
    $trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
    if($task.State -ne 'Running'){
        Register-ScheduledTask -TaskName $name -Action $actionObject -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    }elseif($task.Actions.Arguments -ne $arguments){throw 'Stop the current monitor before upgrading its startup task.'}
    $task=Get-ScheduledTask -TaskName $name
}
$running=Get-Monitor
if($Action -eq 'InstallStartup' -and $running -and (-not $running.managed -or $task.State -ne 'Running')){throw 'Monitor is already running outside the active sign-in task. Run Monitor.ps1 Stop, then InstallStartup to transfer ownership.'}
if($Action -eq 'Status'){if($running){"Monitor ready: $url (PID $($running.pid))"}else{'Monitor is stopped.'};exit 0}
if($Action -eq 'Stop'){
    $hostProcess=$null
    if($running){$childInfo=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$running.pid);if($childInfo){$hostProcess=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$childInfo.ParentProcessId)}}
    if($task -and $task.State -eq 'Running'){Stop-ScheduledTask -TaskName $name}
    if($hostProcess -and $hostProcess.Name -eq 'powershell.exe' -and $hostProcess.CommandLine -match [regex]::Escape($script)){Stop-Process -Id $hostProcess.ProcessId -ErrorAction SilentlyContinue}
    if($running){
        $owned=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$running.pid)
        $identityPattern='(?:^|[\s"])'+[regex]::Escape((Join-Path $PSScriptRoot 'monitor.mjs'))+'(?:$|[\s"])'
        if($owned -and ($owned.Name -ne 'node.exe' -or $owned.CommandLine -notmatch $identityPattern)){throw 'Process identity changed; refusing to stop it.'}
        if($owned){Stop-Process -Id $running.pid -ErrorAction SilentlyContinue}
    }
    'Monitor stopped intentionally. Sign-in startup is preserved.';exit 0
}
if($Action -eq 'Run'){
    if($running){exit 0}
    $env:HARNESS_MONITOR_MANAGED='1'
    if($OpenAtSignIn){
        $boot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks
        $logonGroup=([Security.Principal.WindowsIdentity]::GetCurrent().Groups | Where-Object {$_.Value -like 'S-1-5-5-*'} | Select-Object -First 1).Value
        $env:HARNESS_MONITOR_SESSION="$boot-$logonGroup-$([Diagnostics.Process]::GetCurrentProcess().SessionId)"
    }
    for($attempt=0;$attempt -lt 999;$attempt++){
        $child=Start-Process -FilePath $node -ArgumentList ('"'+(Join-Path $PSScriptRoot 'monitor.mjs')+'"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'monitor.log') -RedirectStandardError (Join-Path $PSScriptRoot 'monitor-error.log') -Wait -PassThru
        Add-Content -LiteralPath (Join-Path $PSScriptRoot 'monitor-host.log') -Value ((Get-Date -Format s)+' monitor exited '+$child.ExitCode+'; restarting in3s, attempt '+($attempt+1))
        Start-Sleep -Seconds 3
    }
    exit 1
}
if(-not $running){
    if($task){Start-ScheduledTask -TaskName $name}
    else{
        Start-Process -FilePath $powershell -ArgumentList ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$script+'" Run') -WindowStyle Hidden -WorkingDirectory $PSScriptRoot -RedirectStandardOutput (Join-Path $PSScriptRoot 'monitor.log') -RedirectStandardError (Join-Path $PSScriptRoot 'monitor-error.log') | Out-Null
    }
    $deadline=[Diagnostics.Stopwatch]::StartNew()
    while($deadline.Elapsed.TotalSeconds -lt 60){Start-Sleep -Milliseconds 500;$running=Get-Monitor;if($running){break}}
    if(-not $running){
        $state=if($task){(Get-ScheduledTask -TaskName $name).State}else{'manual host'}
        $result=if($task){(Get-ScheduledTaskInfo -TaskName $name).LastTaskResult}else{'not applicable'}
        throw "Monitor startup timed out waiting for the HTTP endpoint (task: $state; last result: $result). Inspect monitor-error.log and task history."
    }
}
if($Action -eq 'InstallStartup' -and (-not $running.managed -or (Get-ScheduledTask -TaskName $name).State -ne 'Running')){throw 'Monitor responded but its managed sign-in task is not running. Inspect task ownership and monitor logs.'}
if($Action -eq 'Open'){Start-Process $url}
"Monitor ready: $url (PID $($running.pid))"
exit 0
