param([switch]$EnrollKey, [switch]$NoBrowserAtSignIn)
$ErrorActionPreference = 'Stop'
$existingTask = Get-ScheduledTask -TaskName 'SharedHarness-Monitor' -ErrorAction SilentlyContinue
$monitorScript = Join-Path $PSScriptRoot 'Monitor.ps1'
if ($existingTask -and $existingTask.Actions.Arguments -notlike ('*-File "' + $monitorScript + '" *')) {
    throw 'Another Nexus installation owns the monitor task. Its services and registrations were preserved; choose that installation or migrate it deliberately.'
}
try { $existingMonitor = Invoke-RestMethod 'http://127.0.0.1:8769/monitor-status' -TimeoutSec 2 } catch { $existingMonitor = $null }
if ($existingMonitor -and ($existingMonitor.application -ne 'shared-computer-use-monitor' -or $existingMonitor.root -ne $PSScriptRoot)) {
    throw 'Another installation owns the Nexus monitor port. Its services and registrations were preserved.'
}
$runtime = Join-Path $PSScriptRoot 'runtime'
$manifest = Get-Content -LiteralPath (Join-Path $runtime 'SHA256.json') -Raw | ConvertFrom-Json
foreach ($entry in $manifest) {
    if ([IO.Path]::GetFileName($entry.name) -ne $entry.name) { throw 'Invalid runtime manifest.' }
    if ((Get-FileHash -LiteralPath (Join-Path $runtime $entry.name) -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Runtime checksum mismatch: $($entry.name)" }
}
foreach ($name in 'node.exe','cua-driver.exe','uffs.exe','uffsd.exe','uffs-broker.exe','rg.exe') {
    if (-not (Test-Path -LiteralPath (Join-Path $runtime $name))) { throw "Missing bundled component $name. Extract the deployment ZIP completely." }
}
$env:PATH = $runtime + ';' + $env:PATH
$browsers = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
)
if (-not ($browsers | Where-Object { Test-Path -LiteralPath $_ })) {
    & winget.exe install --id Google.Chrome --exact --source winget --accept-source-agreements --accept-package-agreements --silent --disable-interactivity
    if ($LASTEXITCODE -ne 0) { throw 'Browser installation failed.' }
}
& (Join-Path $PSScriptRoot 'Install.ps1') -InstallSearch -RegisterAgents -UseBundledDependencies
$cuaStatus = & (Join-Path $runtime 'cua-driver.exe') autostart status
if ($LASTEXITCODE -ne 0) { throw 'Cua Driver status check failed.' }
$cuaStatus | Write-Host
if (-not ($cuaStatus -match '^registered \(')) {
    & (Join-Path $runtime 'cua-driver.exe') autostart enable
    if ($LASTEXITCODE -ne 0) { throw 'Cua sign-in task setup failed.' }
}
if (-not ($cuaStatus -match '^registered \(running\)')) {
    & (Join-Path $runtime 'cua-driver.exe') autostart kick
    if ($LASTEXITCODE -ne 0) { throw 'Cua startup failed.' }
}
if ($EnrollKey) { & (Join-Path $PSScriptRoot 'Set-ComputerUseKey.ps1') }
& (Join-Path $PSScriptRoot 'Monitor.ps1') InstallStartup -NoBrowserAtSignIn:$NoBrowserAtSignIn
& (Join-Path $PSScriptRoot 'Install-Skills.ps1')
Write-Host 'Setup completed: runtime checks and tool catalog passed; monitor is managed and its sign-in task is running.'
Write-Host 'Search status, actual file search, Jev authentication, browser and desktop actions have not been verified by setup.'
Write-Host 'Reconnect agents, then use the documented bounded checks as needed.'
