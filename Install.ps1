param([switch]$InstallDriver, [switch]$InstallSearch, [switch]$RegisterAgents, [switch]$UseBundledDependencies)
$ErrorActionPreference = 'Stop'
if ($PSScriptRoot -like '*\AppData\*') { throw 'Clone into Documents or another ordinary folder outside AppData.' }
$node = (Get-Command node -ErrorAction Stop).Source
Write-Host "Setup root: $PSScriptRoot"
Write-Host "Node: $(& $node --version) ($node)"
Write-Host "Credential enrolled: $(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'secrets\computeruse_1.xml')) (authentication not tested)"
if ($InstallSearch) {
    $uffs = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\uffs.exe'
    $packageDir = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\SkyLLC.UFFS_Microsoft.Winget.Source_8wekyb3d8bbwe\uffs-windows-x64'
    if (-not (Get-Command uffs -ErrorAction SilentlyContinue) -and -not (Test-Path -LiteralPath $uffs) -and -not (Test-Path -LiteralPath (Join-Path $packageDir 'uffs.exe'))) {
        & winget.exe install --id SkyLLC.UFFS --exact --source winget --accept-source-agreements --accept-package-agreements --silent --disable-interactivity
        if ($LASTEXITCODE -ne 0) { throw 'UFFS installation failed.' }
    }
    if (-not (Get-Service UffsAccessBroker -ErrorAction SilentlyContinue)) {
        $broker = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\uffs-broker.exe'
        if (-not (Test-Path -LiteralPath $broker)) { $broker = Join-Path $packageDir 'uffs-broker.exe' }
        if (-not (Test-Path -LiteralPath $broker)) { $broker = (Get-Command uffs-broker -ErrorAction Stop).Source }
        $setup = Start-Process -FilePath $broker -Verb RunAs -ArgumentList '--install' -WindowStyle Hidden -PassThru -Wait
        if ($setup.ExitCode -ne 0) { throw 'UFFS broker installation failed.' }
    }
}
if ([int]((& $node --version) -replace '^v(\d+).*','$1') -lt 22) { throw 'Node.js 22 or later is required.' }
$driver = Get-Command cua-driver -ErrorAction SilentlyContinue
if (-not $driver) {
    if (-not $InstallDriver) { throw 'Install Cua Driver first, or rerun with -InstallDriver.' }
    $installer = Join-Path $env:TEMP ('cua-install-' + [guid]::NewGuid() + '.ps1')
    Invoke-WebRequest 'https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.38.0/install.ps1' -UseBasicParsing -OutFile $installer
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Release 0.38.0 -AutoStart
    if ($LASTEXITCODE -ne 0) { throw 'Cua Driver installation failed.' }
    $driverPath = Join-Path $env:LOCALAPPDATA 'Programs\Cua\cua-driver\bin\cua-driver.exe'
} else { $driverPath = $driver.Source }
if (-not (Test-Path -LiteralPath $driverPath)) { throw 'Cua Driver executable missing.' }
Write-Host "Cua Driver: $driverPath"
Write-Host "UFFS on current PATH: $([bool](Get-Command uffs -ErrorAction SilentlyContinue))"
$brokerStatus = Get-Service UffsAccessBroker -ErrorAction SilentlyContinue
Write-Host "UFFS broker: $(if ($brokerStatus) { $brokerStatus.Status } else { 'not installed' })"
$monitorTask = Get-ScheduledTask -TaskName SharedHarness-Monitor -ErrorAction SilentlyContinue
Write-Host "Monitor task: $(if ($monitorTask) { $monitorTask.State } else { 'not installed' })"
Push-Location (Join-Path $PSScriptRoot 'jev-use')
try {
    if ($UseBundledDependencies) {
        $marker = Join-Path $PSScriptRoot '.bundled-lock.sha256'
        $actual = (Get-FileHash -LiteralPath '.\package-lock.json' -Algorithm SHA256).Hash
        if (-not (Test-Path -LiteralPath $marker) -or (Get-Content -LiteralPath $marker -Raw).Trim() -ne $actual -or -not (Test-Path '.\node_modules\tsx\dist\loader.mjs')) { throw 'Bundled dependencies do not match the lockfile. Use a fresh deployment bundle.' }
    } else {
        $lockHash = (Get-FileHash -LiteralPath '.\package-lock.json' -Algorithm SHA256).Hash
        $marker = '.\node_modules\.harness-lock.sha256'
        if (Test-Path -LiteralPath '.\node_modules') {
            if (-not (Test-Path -LiteralPath $marker) -or (Get-Content -LiteralPath $marker -Raw).Trim() -ne $lockHash -or -not (Test-Path -LiteralPath '.\node_modules\tsx\dist\loader.mjs')) {
                throw 'Existing node_modules was preserved. Stop agents using this installation and use a fresh checkout for the dependency update; do not run npm ci over the active directory.'
            }
            Write-Host 'Dependencies already match the recorded lockfile; reusing them.'
        } else {
            $stage = Join-Path (Get-Location).Path ('.harness-npm-' + [guid]::NewGuid())
            New-Item -ItemType Directory -Path $stage | Out-Null
            try {
                Copy-Item -LiteralPath '.\package.json','.\package-lock.json' -Destination $stage
                & npm.cmd ci --ignore-scripts --prefix $stage
                if ($LASTEXITCODE -ne 0) { throw 'Staged npm dependency install failed; the active installation was not changed.' }
                Set-Content -LiteralPath (Join-Path $stage 'node_modules\.harness-lock.sha256') -Value $lockHash -Encoding ASCII
                [IO.Directory]::Move((Join-Path $stage 'node_modules'), (Join-Path (Get-Location).Path 'node_modules'))
            } finally {
                Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
} finally { Pop-Location }
& (Join-Path $PSScriptRoot 'Test-Package.ps1')
if ($RegisterAgents) {
    $launcher = Join-Path $PSScriptRoot 'jev-use\start.mjs'
    if (Get-Command claude -ErrorAction SilentlyContinue) {
        & $node (Join-Path $PSScriptRoot 'nexus-hook.mjs') install
        if ($LASTEXITCODE -ne 0) { Write-Warning 'Claude Code hooks were not registered; run nexus-hook.mjs install.' }
    }
    foreach ($agent in 'codex','claude') {
        if (-not (Get-Command $agent -ErrorAction SilentlyContinue)) { continue }
        foreach ($name in 'shared_jev','shared_cua') {
            $oldPreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = 'Continue'
                & $agent mcp get $name *> $null
                $registrationExit = $LASTEXITCODE
            } finally { $ErrorActionPreference = $oldPreference }
            if ($registrationExit -eq 0) {
                Write-Warning "$agent already has $name. Existing registration preserved; check its path manually."
                continue
            }
            $commandArgs = if ($name -eq 'shared_jev') { @($node,$launcher) } else { @($driverPath,'mcp','--socket','\\.\pipe\cua-driver') }
            if ($agent -eq 'claude') { & $agent mcp add -s user $name -- @commandArgs }
            else { & $agent mcp add $name -- @commandArgs }
            if ($LASTEXITCODE -ne 0) { throw "$agent registration failed for $name." }
        }
    }
}
'Installed. Enroll your own TypeSafe key with .\Set-ComputerUseKey.ps1, then reconnect agents.'
