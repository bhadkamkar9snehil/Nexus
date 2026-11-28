$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'Nexus-Takeover.ps1') -DefinitionsOnly
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$oldRoot = 'C:\Users\Test User\Documents\Nexus Old'
$newRoot = 'C:\Users\Test User\Documents\Nexus New'
$scriptPath = Join-Path $oldRoot 'Monitor.ps1'
$action = [pscustomobject]@{
    Execute = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
    Arguments = ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $scriptPath + '" Run')
}
$task = [pscustomobject]@{
    Principal = [pscustomobject]@{ UserId = $owner }
    Actions = @($action)
}
function Assert([bool]$condition, [string]$message) {
    if (-not $condition) { throw "Installer takeover regression: $message" }
}
$denied = [Management.Automation.ErrorRecord]::new(
    [UnauthorizedAccessException]::new('Access is denied'),
    'SchedulerDenied', [Management.Automation.ErrorCategory]::PermissionDenied, $null)
$missing = [Management.Automation.ErrorRecord]::new(
    [InvalidOperationException]::new('Task not found'),
    'SchedulerMissing', [Management.Automation.ErrorCategory]::ObjectNotFound, $null)
Assert (Test-NexusAccessDenied $denied) 'permission errors must include the administrator retry guidance'
Assert (-not (Test-NexusAccessDenied $missing)) 'a missing task must not be treated as access denied'
Assert ((Get-NexusTaskAccessMessage $owner) -like '*Retry the installer as administrator*') 'scheduler denial must provide a recovery action'
Assert ((Resolve-NexusMonitorTask $task) -eq $oldRoot) 'old installation task must resolve'
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
Assert ((Resolve-NexusTaskOwnerSid $owner) -eq $currentSid) 'task account must resolve to its SID'
Assert ((Resolve-NexusTaskOwnerSid $currentSid) -eq $currentSid) 'task SID must resolve unchanged'
$otherSid = 'S-1-5-21-1-2-3-1000'
Assert-NexusTakeoverOwner $currentSid $currentSid $false
Assert-NexusTakeoverOwner $currentSid $otherSid $true
$blocked = $false
try { Assert-NexusTakeoverOwner $currentSid $otherSid $false } catch { $blocked = $true }
Assert $blocked 'cross-user task must require administrator rights'
$action.Arguments = '-NoProfile -File "C:\Windows\System32\bad.ps1" Run'
$blocked = $false
try { $null = Resolve-NexusMonitorTask $task } catch { $blocked = $true }
Assert $blocked 'non-Nexus task script must be refused'
$action.Arguments = '-NoProfile -File "' + $scriptPath + '" Run'
$action.Execute = 'C:\Windows\System32\cmd.exe'
$blocked = $false
try { $null = Resolve-NexusMonitorTask $task } catch { $blocked = $true }
Assert $blocked 'non-PowerShell task executable must be refused'
$action.Execute = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'

$process = [pscustomobject]@{
    Name = 'node.exe'
    ExecutablePath = 'C:\Program Files\nodejs\node.exe'
    CommandLine = 'node.exe "' + (Join-Path $oldRoot 'monitor.mjs') + '"'
}
Assert (Test-NexusProcessCommand $process @($oldRoot,$newRoot)) 'known monitor process must match'
Assert (-not (Test-NexusProcessCommand $process @($newRoot))) 'foreign root must not match'
$process.CommandLine = 'node.exe "C:\Other\monitor.mjs"'
Assert (-not (Test-NexusProcessCommand $process @($oldRoot))) 'unrelated Node process must survive'
$process.CommandLine = 'node.exe server.js --example "' + (Join-Path $oldRoot 'monitor.mjs') + '"'
Assert (-not (Test-NexusProcessCommand $process @($oldRoot))) 'Nexus script in a later Node argument must not match'
$process.CommandLine = 'node.exe "' + (Join-Path $oldRoot 'jev-use\start.mjs') + '"'
Assert (Test-NexusProcessCommand $process @($oldRoot)) 'Nexus MCP server must match'
$process.Name = 'powershell.exe'
$process.CommandLine = 'powershell.exe -NoProfile -File "' + $scriptPath + '" Run'
Assert (Test-NexusProcessCommand $process @($oldRoot)) 'Nexus monitor host must match'
$process.CommandLine = 'powershell.exe -File "' + $scriptPath + '" Status'
Assert (-not (Test-NexusProcessCommand $process @($oldRoot))) 'a status probe must survive'
$process.CommandLine = 'powershell.exe -NoProfile -File "' + $scriptPath + '" Status Run'
Assert (-not (Test-NexusProcessCommand $process @($oldRoot))) 'Run must be the monitor action'
$process.CommandLine = 'powershell.exe -Command "Write-Output -File ' + $scriptPath + ' Run"'
Assert (-not (Test-NexusProcessCommand $process @($oldRoot))) 'script references inside other commands must not match'
$process.Name = 'Nexus.Desktop.exe'
$process.ExecutablePath = Join-Path $oldRoot 'Nexus.Desktop.exe'
Assert (Test-NexusProcessCommand $process @($oldRoot)) 'existing Nexus desktop must match'
$process.ExecutablePath = 'C:\Other\Nexus.Desktop.exe'
Assert (-not (Test-NexusProcessCommand $process @($oldRoot))) 'unrelated desktop path must survive'
$process.Name = 'powershell.exe'
$process.CommandLine = 'powershell.exe -File "C:\Other\Monitor.ps1" Run'
Assert (-not (Test-NexusProcessCommand $process @($oldRoot))) 'unrelated PowerShell host must survive'
$process.Name = 'uffsd.exe'
$process.CommandLine = $null
$process.ExecutablePath = Join-Path $oldRoot 'runtime\uffsd.exe'
Assert (Test-NexusProcessCommand $process @($oldRoot)) 'a search daemon running from the install runtime must be stopped before its file is replaced'
$process.ExecutablePath = 'C:\Tools\uffs\uffsd.exe'
Assert (-not (Test-NexusProcessCommand $process @($oldRoot))) 'a search daemon installed elsewhere must survive'
$self = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID)
Assert ((Get-NexusProcessOwnerSid $self) -eq $currentSid) 'Win32_Process GetOwner must recognize this PowerShell process'
$blocker = Get-NexusPortBlockerDescription @([pscustomobject]@{ OwningProcess = $PID })
Assert ($blocker -match ('PID ' + $PID)) 'unknown port listener must show its PID to the user'

$listener = [pscustomobject]@{ OwningProcess = $PID }
Assert-NexusMonitorListeners @($listener, $listener) $PID
Assert-NexusMonitorListeners @() 0
foreach ($check in @(
    @{ Listeners = @($listener); Expected = 0 },
    @{ Listeners = @($listener); Expected = ($PID + 1) },
    @{ Listeners = @($listener, [pscustomobject]@{ OwningProcess = ($PID + 1) }); Expected = $PID }
)) {
    $blocked = $false
    try { Assert-NexusMonitorListeners $check.Listeners $check.Expected } catch { $blocked = $true }
    Assert $blocked 'an unverified listener must block takeover before process or task changes'
}

$testParent = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile, [Environment+SpecialFolderOption]::DoNotVerify)
if (-not [IO.Path]::IsPathRooted($testParent)) { $testParent = Split-Path $root -Parent }
$testHome = Join-Path $testParent ('nexus-installer-test-' + [guid]::NewGuid().ToString('N'))
try {
    $valid = Join-Path $testHome 'writable directory'
    Assert ((Test-NexusInstallDestination $valid) -eq $valid) 'writable install target must pass'
    Assert (@(Get-ChildItem -LiteralPath $valid -Force).Count -eq 0) 'write probe must be removed'

    $blockedFile = Join-Path $testHome 'ordinary-file'
    [IO.File]::WriteAllText($blockedFile, 'existing file')
    $blocked = $false
    try { $null = Test-NexusInstallDestination $blockedFile } catch { $blocked = $true }
    Assert $blocked 'installing to a regular file must fail before takeover'

    $repo = Join-Path $testHome 'source checkout'
    New-Item -ItemType Directory -Path (Join-Path $repo '.git') -Force | Out-Null
    $blocked = $false
    try { $null = Test-NexusInstallDestination $repo } catch { $blocked = $true }
    Assert $blocked 'installing into a Git checkout must fail before takeover'

    $blocked = $false
    try { $null = Test-NexusInstallDestination ([IO.Path]::GetPathRoot($env:TEMP)) } catch { $blocked = $true }
    Assert $blocked 'installing to a drive root must fail before takeover'

    $blocked = $false
    try { $null = Test-NexusInstallDestination (Join-Path $env:LOCALAPPDATA 'Nexus-test-rejected') } catch { $blocked = $true }
    Assert $blocked 'installing into AppData must fail before takeover'

    $repairFixture = Join-Path $testHome 'repair'
    $runtime = Join-Path $repairFixture 'runtime'
    $localAppData = Join-Path $repairFixture 'local'
    $foreignModules = Join-Path $repairFixture 'modules'
    $foreignUtility = Join-Path $foreignModules 'Microsoft.PowerShell.Utility'
    New-Item -ItemType Directory -Path $runtime,$foreignUtility | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'Setup.ps1') -Destination $repairFixture
    [IO.File]::WriteAllText((Join-Path $runtime 'node.exe'), 'hash fixture')
    $nodeHash = (Get-FileHash -LiteralPath (Join-Path $runtime 'node.exe')).Hash
    ConvertTo-Json -InputObject @(@{ name='node.exe'; sha256=$nodeHash }) |
        Set-Content -LiteralPath (Join-Path $runtime 'SHA256.json')
    'function Get-FileHash { throw "Foreign PowerShell module was imported" }' |
        Set-Content -LiteralPath (Join-Path $foreignUtility 'Microsoft.PowerShell.Utility.psm1')
    $previousLocal = $env:LOCALAPPDATA
    $previousModules = $env:PSModulePath
    try {
        $env:LOCALAPPDATA = $localAppData
        $env:PSModulePath = $foreignModules + [IO.Path]::PathSeparator + $previousModules
        $setupFile = Join-Path $repairFixture 'Setup.ps1'
        $setupError = Join-Path $repairFixture 'setup-error.txt'
        $setupProcess = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -Wait -PassThru -RedirectStandardError $setupError -ArgumentList @(
            '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"' + $setupFile + '"')
        )
        Assert ($setupProcess.ExitCode -ne 0) 'fixture must stop before takeover because its runtime is incomplete'
        Assert ((Get-Content -LiteralPath $setupError -Raw) -match 'Missing bundled component cua-driver.exe') 'repair must hash the runtime with native modules before it checks for missing components'
    } finally {
        $env:LOCALAPPDATA = $previousLocal
        $env:PSModulePath = $previousModules
    }

    $takeoverHelper = Join-Path $root 'Nexus-Takeover.ps1'
    & {
        $root = Join-Path $testHome 'rollback'
        $originalLocalAppData = $env:LOCALAPPDATA
        $env:LOCALAPPDATA = $root
        try {
            $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
            $fixture = @{}
            $proc = [pscustomobject]@{
                ProcessId = 1470000
                Name = 'node.exe'
                CreationDate = [datetime]::UtcNow
                CommandLine = 'node.exe "' + (Join-Path $root 'monitor.mjs') + '"'
            }
            function Get-ScheduledTask {
                param($TaskName,$TaskPath)
                if ($fixture.present) { $fixture.task }
            }
            function Export-ScheduledTask { param($TaskName,$TaskPath) '<Task>test backup</Task>' }
            function Stop-ScheduledTask {
                param($TaskName,$TaskPath)
                $fixture.actions.Add('stop')
                $fixture.task.State = 'Ready'
            }
            function Unregister-ScheduledTask {
                [CmdletBinding()]
                param($TaskName,$TaskPath,$Confirm)
                $fixture.actions.Add('unregister')
                if ($fixture.denied) {
                    $errorRecord = [Management.Automation.ErrorRecord]::new(
                        [Runtime.InteropServices.COMException]::new('Access is denied.', -2147024891),
                        'HRESULT 0x80070005,Unregister-ScheduledTask',
                        [Management.Automation.ErrorCategory]::PermissionDenied, $null)
                    $PSCmdlet.ThrowTerminatingError($errorRecord)
                }
                $fixture.present = $false
            }
            function Register-ScheduledTask {
                param($TaskName,$TaskPath,$Xml)
                Assert ($Xml.Trim() -eq '<Task>test backup</Task>') 'rollback must use the exported task'
                $fixture.actions.Add('restore')
                $fixture.present = $true
                $fixture.task.State = 'Ready'
                $fixture.task
            }
            function Start-ScheduledTask {
                param($TaskName,$TaskPath)
                $fixture.actions.Add('restart')
                $fixture.task.State = 'Running'
            }
            function Invoke-RestMethod { throw 'fixture does not serve HTTP' }
            function Get-NetTCPConnection { param($LocalPort,$State) }
            function Get-CimInstance {
                param($ClassName,$Filter)
                if (-not $Filter -or -not $fixture.exiting) { return $proc }
                $fixture.lookups++
                if ($fixture.lookups -eq 1) {
                    return [pscustomobject]@{ ProcessId=$proc.ProcessId; Name=$proc.Name; CreationDate=$proc.CreationDate }
                }
            }
            function Invoke-CimMethod { param($InputObject,$MethodName) @{ ReturnValue=0; Sid=$sid } }
            function Stop-Process {
                param($Id,[switch]$Force)
                Assert ($Id -eq $proc.ProcessId) 'only the matching process may be stopped'
                throw 'fixture injects a stop failure'
            }

            $cases = @(
                @{ state='Running'; actions='stop,unregister'; exiting=$true; error='' }
                @{ state='Running'; actions='stop,unregister,restore,restart'; error='fixture injects a stop failure' }
                @{ state='Ready'; actions='unregister,restore'; error='fixture injects a stop failure' }
                @{ state='Running'; actions='stop,unregister,restart'; denied=$true; error='[NexusElevationRequired] Windows denied access' }
            )
            foreach ($case in $cases) {
                $fixture.present = $true
                $fixture.denied = $case.denied
                $fixture.exiting = $case.exiting
                $fixture.lookups = 0
                $fixture.actions = [Collections.Generic.List[string]]::new()
                $fixture.task = [pscustomobject]@{
                    State = $case.state
                    Principal = @{ UserId = $sid }
                    Actions = @(@{
                        Execute = 'powershell.exe'
                        Arguments = '-NoProfile -File "' + (Join-Path $root 'Monitor.ps1') + '" Run'
                    })
                }
                $failure = ''
                try { & $takeoverHelper -TargetDir $root } catch { $failure = $_.Exception.Message }
                Assert (($failure -eq $case.error) -or ($case.error -and $failure.StartsWith($case.error))) "unexpected takeover error: $failure"
                Assert (($fixture.actions -join ',') -eq $case.actions) "unexpected rollback actions: $($fixture.actions -join ',')"
                if ($case.error) {
                    Assert ($fixture.task.State -eq $case.state) 'rollback must preserve original task state'
                } else {
                    Assert (-not $fixture.present) 'a disappearing monitor host must allow task transfer'
                }
            }
        } finally {
            $env:LOCALAPPDATA = $originalLocalAppData
        }
    }
} finally {
    Remove-Item -LiteralPath $testHome -Recurse -Force -ErrorAction SilentlyContinue
}
'PASS: Nexus takeover process identity and writable destination checks (no processes stopped).'
