$ErrorActionPreference = 'Stop'
$source = Split-Path $PSScriptRoot -Parent
$testRoot = Join-Path (Split-Path $source -Parent) ('nexus-updater-recovery-' + [guid]::NewGuid().ToString('N'))
$install = Join-Path $testRoot 'installed Nexus'
try {
    $null = New-Item -ItemType Directory -Path (Join-Path $install 'runtime') -Force
    $null = New-Item -ItemType Directory -Path (Join-Path $install 'secrets') -Force
    foreach ($name in 'Update-Nexus.ps1','Installer-Recovery.ps1','Nexus-Takeover.ps1') {
        Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $install $name)
    }
    foreach ($name in 'Setup.ps1','Monitor.ps1','Test-Package.ps1','Nexus.Desktop.exe','runtime\node.exe') {
        [IO.File]::WriteAllText((Join-Path $install $name), "original $name")
    }
    [IO.File]::WriteAllText((Join-Path $install 'VERSION'), '1.18.4')
    [IO.File]::WriteAllText((Join-Path $install 'secrets\key.txt'), 'STAY_PRIVATE')
    $wrapper = Join-Path $testRoot 'mock-run.ps1'
    $mock = @'
$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = $env:NEXUS_TEST_HOME
$env:NEXUS_TEST_STATE = 'before'
function Get-ItemProperty {
    param([string]$LiteralPath, [string]$Path, [string]$ErrorAction)
    $v = if ($env:NEXUS_TEST_STATE -eq 'failed') { '1.18.5' } else { '1.18.4' }
    [pscustomobject]@{ DisplayVersion = $v; InstallLocation = $env:NEXUS_TEST_ROOT }
}
function Get-ScheduledTask {
    param([string]$TaskName, [string]$ErrorAction)
    if ($env:NEXUS_TEST_STATE -eq 'failed') { return $null }
    [pscustomobject]@{ State = 'Running' }
}
function Invoke-RestMethod {
    param([string]$Uri, [int]$TimeoutSec)
    if ($env:NEXUS_TEST_STATE -eq 'failed') { throw 'simulated monitor offline' }
    [pscustomobject]@{ application = 'shared-computer-use-monitor'; managed = $true; root = $env:NEXUS_TEST_ROOT }
}
function Start-Sleep { param([int]$Seconds) }
function reg.exe {
    if ($args[0] -eq 'export') { [IO.File]::WriteAllText([string]$args[2], 'synthetic registry backup') }
    $global:LASTEXITCODE = 0
}
function powershell.exe {
    $line = $args -join ' '
    if ($line -match 'Setup.ps1') { $env:NEXUS_TEST_STATE = 'restored' }
    elseif ($line -notmatch 'Nexus-Takeover-Recovery.ps1') { throw 'Unexpected PowerShell child command.' }
    $global:LASTEXITCODE = 0
}
function Start-Process {
    param([string]$FilePath, [string[]]$ArgumentList, [switch]$Wait, [switch]$PassThru)
    [IO.File]::WriteAllText((Join-Path $env:NEXUS_TEST_ROOT 'Setup.ps1'), 'FAILED-UPDATE')
    [IO.File]::WriteAllText((Join-Path $env:NEXUS_TEST_ROOT 'VERSION'), '1.18.5')
    $env:NEXUS_TEST_STATE = 'failed'
    [pscustomobject]@{ ExitCode = 5 }
}
function Unregister-ScheduledTask {
    param([string]$TaskName, [switch]$Confirm, [string]$ErrorAction)
    Write-Output 'MOCK_TASK_CLEANUP'
}
& (Join-Path $env:NEXUS_TEST_ROOT 'Update-Nexus.ps1') -Install -File $env:ComSpec -Version v1.18.5
exit $LASTEXITCODE
'@
    [IO.File]::WriteAllText($wrapper,$mock)
    $env:NEXUS_TEST_ROOT = $install
    $env:NEXUS_TEST_HOME = Join-Path $testRoot 'appdata'
    $output = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $wrapper 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 5) { throw "Expected installer exit 5, got $code; output: $($output -join ' ')" }
    $receipt = Get-Content -LiteralPath (Join-Path $testRoot 'appdata\Nexus\last-install-receipt.json') -Raw | ConvertFrom-Json
    if ($receipt.installerExitCode -ne 5 -or $receipt.recovery.status -ne 'restored-and-verified') {
        throw "Unexpected restore receipt: $($receipt | ConvertTo-Json -Compress)"
    }
    if ((Get-Content -LiteralPath (Join-Path $install 'Setup.ps1') -Raw) -ne 'original Setup.ps1' -or
        (Get-Content -LiteralPath (Join-Path $install 'VERSION') -Raw) -ne '1.18.4') {
        throw 'Failed installer did not restore the previous files.'
    }
    if ((Get-Content -LiteralPath (Join-Path $install 'secrets\key.txt') -Raw) -ne 'STAY_PRIVATE') {
        throw 'Private files changed during recovery.'
    }
    'PASS: Failed-update orchestration restores previous files, verifies monitor and preserves exit code.'
} finally {
    Remove-Item Env:\NEXUS_TEST_ROOT, Env:\NEXUS_TEST_HOME -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
