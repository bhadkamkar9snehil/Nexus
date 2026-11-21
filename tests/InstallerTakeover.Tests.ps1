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
Assert ((Resolve-NexusMonitorTask $task) -eq $oldRoot) 'same-user old installation task must resolve'
$task.Principal.UserId = ($owner -split '\\')[-1]
Assert ((Resolve-NexusMonitorTask $task) -eq $oldRoot) 'unqualified task owner must resolve to the current Windows SID'
$task.Principal.UserId = 'OTHERDOMAIN\DifferentUser'
$blocked = $false
try { $null = Resolve-NexusMonitorTask $task } catch { $blocked = $true }
Assert $blocked 'other-user task must be refused'
$task.Principal.UserId = $owner
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
$process.CommandLine = 'node.exe "' + (Join-Path $oldRoot 'jev-use\start.mjs') + '"'
Assert (Test-NexusProcessCommand $process @($oldRoot)) 'Nexus MCP server must match'
$process.Name = 'powershell.exe'
$process.CommandLine = 'powershell.exe -NoProfile -File "' + $scriptPath + '" Run'
Assert (Test-NexusProcessCommand $process @($oldRoot)) 'Nexus monitor host must match'
$process.CommandLine = 'powershell.exe -File "' + $scriptPath + '" Status'
Assert (-not (Test-NexusProcessCommand $process @($oldRoot))) 'a status probe must survive'
$process.Name = 'Nexus.Desktop.exe'
$process.ExecutablePath = Join-Path $oldRoot 'Nexus.Desktop.exe'
Assert (Test-NexusProcessCommand $process @($oldRoot)) 'existing Nexus desktop must match'
$process.ExecutablePath = 'C:\Other\Nexus.Desktop.exe'
Assert (-not (Test-NexusProcessCommand $process @($oldRoot))) 'unrelated desktop path must survive'
$process.Name = 'powershell.exe'
$process.CommandLine = 'powershell.exe -File "C:\Other\Monitor.ps1" Run'
Assert (-not (Test-NexusProcessCommand $process @($oldRoot))) 'unrelated PowerShell host must survive'
$self = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID)
Assert (Test-NexusProcessOwner $self) 'Win32_Process GetOwner must recognize this PowerShell process'
'PASS: Nexus takeover task ownership and exact process identity (no processes stopped).'
