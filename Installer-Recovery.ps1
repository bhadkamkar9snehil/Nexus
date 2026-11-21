param([switch]$FunctionsOnly)
$ErrorActionPreference = 'Stop'

$script:NexusUninstallKey = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{E41F1F1C-57B8-49BB-B11D-79DC2A9A0622}_is1'
$script:NexusRecoveryFiles = @('Setup.ps1','Monitor.ps1','Test-Package.ps1','Nexus.Desktop.exe','VERSION','runtime\node.exe')

function Invoke-NexusRecoveryCopy([string]$from, [string]$to) {
    $null = New-Item -ItemType Directory -Path $to -Force
    $arguments = @($from,$to,'/E','/COPY:DAT','/DCOPY:DAT','/R:2','/W:1','/XJ',
        '/XD','secrets','/XF','*.log','*.jsonl','/NFL','/NDL','/NJH','/NJS','/NP')
    & robocopy.exe @arguments | Out-Null
    $result = $LASTEXITCODE
    if ($result -ge 8) { throw "Recovery file copy failed (robocopy exit code $result). The existing installation was not intentionally changed." }
}

function Test-NexusRecoverySnapshot([string]$snapshot, [string]$installRoot) {
    $metadataPath = Join-Path $snapshot 'manifest.json'
    if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) { throw 'Recovery snapshot manifest is missing.' }
    $info = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    $root = [IO.Path]::GetFullPath($installRoot).TrimEnd('\')
    if (-not [string]::Equals([IO.Path]::GetFullPath([string]$info.installRoot).TrimEnd('\'), $root, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Recovery snapshot belongs to a different installation.'
    }
    if ([string]$info.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Recovery snapshot version is invalid.' }
    if ([string]::IsNullOrWhiteSpace([string]$info.capturedAtUtc)) { throw 'Recovery snapshot has no capture time.' }
    $payload = Join-Path $snapshot 'payload'
    foreach ($name in $script:NexusRecoveryFiles) {
        $file = Join-Path $payload $name
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Recovery snapshot is missing $name." }
        $expected = [string]$info.hashes.$name
        if ($expected -notmatch '^[0-9A-Fa-f]{64}$') { throw "Recovery checksum is missing for $name." }
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ine $expected) {
            throw "Recovery snapshot checksum mismatch: $name."
        }
    }
    if ((Get-Content -LiteralPath (Join-Path $payload 'VERSION') -Raw).Trim() -ne [string]$info.version) {
        throw 'Recovery snapshot version file does not match its receipt.'
    }
    if ($info.registrySha256) {
        $registryBackup = Join-Path $snapshot 'uninstall.reg'
        if (-not (Test-Path -LiteralPath $registryBackup -PathType Leaf) -or
            (Get-FileHash -LiteralPath $registryBackup -Algorithm SHA256).Hash -ine [string]$info.registrySha256) {
            throw 'Nexus uninstall registry backup failed checksum verification.'
        }
    }
    return $info
}

function New-NexusRecoverySnapshot([string]$installRoot, [string]$version, [string]$store, [switch]$SkipRegistry) {
    if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Cannot back up an unknown installed Nexus version.' }
    $root = [IO.Path]::GetFullPath($installRoot).TrimEnd('\')
    $store = [IO.Path]::GetFullPath($store).TrimEnd('\')
    if ($store.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Recovery snapshots must be outside the installation folder.'
    }
    if ((Get-Content -LiteralPath (Join-Path $root 'VERSION') -Raw).Trim() -ne $version) {
        throw 'Registered Nexus version differs from the installed payload. Repair the installation before updating.'
    }
    $requiredSpace = (Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction Stop | Measure-Object Length -Sum).Sum + 128MB
    $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($store))
    if ($drive.AvailableFreeSpace -lt $requiredSpace) {
        throw ('Not enough space for a safe update. Free at least {0:N0} MB on {1}, then retry.' -f ([math]::Ceiling(($requiredSpace - $drive.AvailableFreeSpace) / 1MB)), $drive.Name)
    }
    $null = New-Item -ItemType Directory -Path $store -Force
    $name = 'snapshot-' + $version + '-' + [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmss') + '-' + [guid]::NewGuid().ToString('N')
    $snapshot = Join-Path $store $name
    $partial = $snapshot + '.partial'
    try {
        $payload = Join-Path $partial 'payload'
        Invoke-NexusRecoveryCopy $root $payload
        $hashes = @{}
        foreach ($file in $script:NexusRecoveryFiles) {
            $sourceFile = Join-Path $root $file
            $copyFile = Join-Path $payload $file
            if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf) -or
                -not (Test-Path -LiteralPath $copyFile -PathType Leaf)) {
                throw "Required recovery component is missing: $file."
            }
            $hash = (Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash
            if ((Get-FileHash -LiteralPath $copyFile -Algorithm SHA256).Hash -ine $hash) {
                throw "Recovery copy verification failed: $file."
            }
            $hashes[$file] = $hash
        }
        $registryHash = $null
        if (-not $SkipRegistry) {
            $registryBackup = Join-Path $partial 'uninstall.reg'
            & reg.exe export $script:NexusUninstallKey $registryBackup /y | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Unable to back up the Nexus uninstall registry entry.' }
            $registryHash = (Get-FileHash -LiteralPath $registryBackup -Algorithm SHA256).Hash
        }
        $metadata = @{
            schemaVersion = 1
            installRoot = $root
            version = $version
            capturedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
            registrySha256 = $registryHash
            hashes = $hashes
        }
        [IO.File]::WriteAllText((Join-Path $partial 'manifest.json'), ($metadata | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
        $null = Test-NexusRecoverySnapshot $partial $root
        [IO.Directory]::Move($partial, $snapshot)
        return $snapshot
    } finally {
        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

function Protect-NexusRecoverySnapshot([string]$snapshot) {
    if (-not (Test-Path -LiteralPath (Join-Path $snapshot 'manifest.json') -PathType Leaf)) {
        throw 'Cannot protect a missing recovery snapshot.'
    }
    [IO.File]::WriteAllText((Join-Path $snapshot '.keep'), [DateTimeOffset]::UtcNow.ToString('o'))
}

function Remove-NexusOldRecoverySnapshots([string]$store, [int]$keep = 2) {
    if ($keep -lt 1) { throw 'At least one recovery snapshot must be kept.' }
    if (-not (Test-Path -LiteralPath $store -PathType Container)) { return 0 }
    $candidates = @(Get-ChildItem -LiteralPath $store -Directory -ErrorAction Stop |
        Where-Object {
            $_.Name -match '^snapshot-\d+\.\d+\.\d+-\d{8}T\d{6}-[a-f0-9]{32}$' -and
            -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
            -not (Test-Path -LiteralPath (Join-Path $_.FullName '.keep')) -and
            (Test-Path -LiteralPath (Join-Path $_.FullName 'manifest.json'))
        } | Sort-Object Name -Descending)
    $old = @($candidates | Select-Object -Skip $keep)
    foreach ($entry in $old) { Remove-Item -LiteralPath $entry.FullName -Recurse -Force -ErrorAction Stop }
    return $old.Count
}

function Restore-NexusRecoveryFiles([string]$snapshot, [string]$installRoot, [switch]$SkipRegistry) {
    $info = Test-NexusRecoverySnapshot $snapshot $installRoot
    $root = [IO.Path]::GetFullPath($installRoot).TrimEnd('\')
    Invoke-NexusRecoveryCopy (Join-Path $snapshot 'payload') $root
    foreach ($name in $script:NexusRecoveryFiles) {
        if ((Get-FileHash -LiteralPath (Join-Path $root $name) -Algorithm SHA256).Hash -ine [string]$info.hashes.$name) {
            throw "Recovery failed to restore $name."
        }
    }
    if (-not $SkipRegistry) {
        $registryBackup = Join-Path $snapshot 'uninstall.reg'
        if (-not $info.registrySha256) { throw 'Previous Nexus registry checksum is missing.' }
        if (-not (Test-Path -LiteralPath $registryBackup -PathType Leaf)) { throw 'Previous Nexus registry backup is missing.' }
        & reg.exe import $registryBackup | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Unable to restore the previous Nexus registry entry.' }
    }
    return [string]$info.version
}
if ($FunctionsOnly) { return }
throw 'Import Installer-Recovery.ps1 with -FunctionsOnly or run the updater.'
