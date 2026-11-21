param([switch]$EnrollKey, [switch]$NoBrowserAtSignIn)
$ErrorActionPreference = 'Stop'
$folder = Join-Path $env:LOCALAPPDATA 'Nexus'
New-Item -ItemType Directory -Path $folder -Force | Out-Null
try { Start-Transcript -Path (Join-Path $folder 'setup.log') -Force | Out-Null } catch { }
$warnings = New-Object 'System.Collections.Generic.List[string]'
function Warn-Optional([string]$label, [string]$detail) {
    $message = "$label is not ready: $detail. Use Nexus Settings > Set up or repair after correcting it."
    $warnings.Add($message)
    Write-Warning $message
}

# Core: transfer only verified Nexus ownership and validate the shipped runtime.
# Optional external CLIs must not prevent the Nexus monitor from starting.
& (Join-Path $PSScriptRoot 'Nexus-Takeover.ps1') -TargetDir $PSScriptRoot
$runtime = Join-Path $PSScriptRoot 'runtime'
$manifest = Get-Content -LiteralPath (Join-Path $runtime 'SHA256.json') -Raw | ConvertFrom-Json
foreach ($entry in $manifest) {
    if ([IO.Path]::GetFileName($entry.name) -ne $entry.name) { throw 'Invalid runtime manifest.' }
    if ((Get-FileHash -LiteralPath (Join-Path $runtime $entry.name) -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Runtime checksum mismatch: $($entry.name)" }
}
foreach ($name in 'node.exe','cua-driver.exe','uffs.exe','uffsd.exe','uffs-broker.exe','rg.exe') {
    if (-not (Test-Path -LiteralPath (Join-Path $runtime $name))) { throw "Missing bundled component $name. Download and run the installer again." }
}
$env:PATH = $runtime + ';' + $env:PATH
& (Join-Path $PSScriptRoot 'Install.ps1') -UseBundledDependencies

# Mandatory: managed monitor task and HTTP health. Copied files alone are not a successful install.
& (Join-Path $PSScriptRoot 'Monitor.ps1') InstallStartup -NoBrowserAtSignIn:$NoBrowserAtSignIn
$task = Get-ScheduledTask -TaskName 'SharedHarness-Monitor' -ErrorAction Stop
$health = Invoke-RestMethod 'http://127.0.0.1:8769/monitor-status' -TimeoutSec 5
if ($task.State -ne 'Running' -or $health.application -ne 'shared-computer-use-monitor' -or
    -not $health.managed -or
    [IO.Path]::GetFullPath([string]$health.root).TrimEnd('\') -ine [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')) {
    throw 'Nexus monitor health or scheduled task ownership did not pass. Inspect setup.log and monitor-error.log, then run Set up or repair.'
}
Write-Host "Nexus monitor verified: PID $($health.pid); task running; installation root matches."

# Optional integrations can report warnings, but cannot prevent the verified monitor from working.
try {
    $browsers = @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft\Edge\Application\msedge.exe')
    )
    if (-not ($browsers | Where-Object { Test-Path -LiteralPath $_ })) {
        & winget.exe install --id Google.Chrome --exact --source winget --accept-source-agreements --accept-package-agreements --silent --disable-interactivity
        if ($LASTEXITCODE -ne 0) { throw 'Chrome installation failed or requires administrator approval' }
    }
} catch { Warn-Optional 'Browser integration' $_.Exception.Message }

try {
    & (Join-Path $PSScriptRoot 'Install.ps1') -InstallSearch -UseBundledDependencies
} catch { Warn-Optional 'UFFS search service' $_.Exception.Message }

try {
    $cuaStatus = & (Join-Path $runtime 'cua-driver.exe') autostart status
    if ($LASTEXITCODE -ne 0) { throw 'Cua Driver status check failed' }
    if (-not ($cuaStatus -match '^registered \(')) {
        & (Join-Path $runtime 'cua-driver.exe') autostart enable
        if ($LASTEXITCODE -ne 0) { throw 'Cua Driver sign-in task registration failed' }
    }
    if (-not ($cuaStatus -match '^registered \(running\)')) {
        & (Join-Path $runtime 'cua-driver.exe') autostart kick
        if ($LASTEXITCODE -ne 0) { throw 'Cua Driver startup failed' }
    }
} catch { Warn-Optional 'Cua Driver sign-in startup' $_.Exception.Message }

try {
    & (Join-Path $PSScriptRoot 'Install.ps1') -RegisterAgents -UseBundledDependencies
} catch { Warn-Optional 'Codex/Claude MCP registration' $_.Exception.Message }

if ($EnrollKey) {
    try { & (Join-Path $PSScriptRoot 'Set-ComputerUseKey.ps1') }
    catch { Warn-Optional 'Computer-use key enrollment' $_.Exception.Message }
}
try {
    & (Join-Path $PSScriptRoot 'Install-Skills.ps1')
} catch { Warn-Optional 'Agent skill registration' $_.Exception.Message }

$warningPath = Join-Path $folder 'setup-warnings.json'
[IO.File]::WriteAllText($warningPath, (ConvertTo-Json -InputObject $warnings.ToArray() -Compress), [Text.UTF8Encoding]::new($false))
Write-Host ('Nexus installation completed: monitor verified. Optional warnings: ' + $warnings.Count)
Write-Host 'Optional integrations and agent authentication can be repaired from Nexus Settings. See setup.log and setup-warnings.json.'
