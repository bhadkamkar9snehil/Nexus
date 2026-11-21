$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'Installer-Recovery.ps1') -FunctionsOnly
function Assert([bool]$condition, [string]$description) {
    if (-not $condition) { throw "Recovery regression: $description" }
}
$testRoot = Join-Path (Split-Path $root -Parent) ('nexus-recovery-test-' + [guid]::NewGuid().ToString('N'))
$install = Join-Path $testRoot 'installed Nexus'
$store = Join-Path $testRoot 'snapshots'
try {
    $null = New-Item -ItemType Directory -Path (Join-Path $install 'runtime') -Force
    $null = New-Item -ItemType Directory -Path (Join-Path $install 'secrets') -Force
    foreach ($name in $script:NexusRecoveryFiles) {
        $file = Join-Path $install $name
        $parent = Split-Path $file -Parent
        $null = New-Item -ItemType Directory -Path $parent -Force
        if ($name -eq 'VERSION') { [IO.File]::WriteAllText($file, '1.18.3') }
        else { [IO.File]::WriteAllText($file, "old version $name") }
    }
    [IO.File]::WriteAllText((Join-Path $install 'secrets\credential.txt'), 'PRIVATE_FIXTURE')
    [IO.File]::WriteAllText((Join-Path $install 'monitor.log'), 'ACTIVE LOG')
    $snapshot = New-NexusRecoverySnapshot $install '1.18.3' $store -SkipRegistry
    Assert (Test-Path -LiteralPath (Join-Path $snapshot 'manifest.json')) 'snapshot metadata must exist'
    Assert (-not (Test-Path -LiteralPath (Join-Path $snapshot 'payload\secrets'))) 'secret files must not be copied'
    Assert (-not (Test-Path -LiteralPath (Join-Path $snapshot 'payload\monitor.log'))) 'live log files must not be copied'
    [IO.File]::WriteAllText((Join-Path $install 'Setup.ps1'), 'partial failed installer content')
    [IO.File]::WriteAllText((Join-Path $install 'VERSION'), '1.18.5')
    [IO.File]::WriteAllText((Join-Path $install 'secrets\credential.txt'), 'PRIVATE_FIXTURE_UPDATED')
    [IO.File]::WriteAllText((Join-Path $install 'new-version-file.bin'), 'new release')
    $blocked = $false
    try { $null = Restore-NexusRecoveryFiles $snapshot (Join-Path $testRoot 'wrong installation') -SkipRegistry }
    catch { $blocked = $true }
    Assert $blocked 'snapshot must reject a different installation directory'
    Assert ((Get-Content -LiteralPath (Join-Path $install 'VERSION') -Raw) -eq '1.18.5') 'invalid restore must not change the installation'
    $restoredVersion = Restore-NexusRecoveryFiles $snapshot $install -SkipRegistry
    Assert ($restoredVersion -eq '1.18.3') 'restored version must match saved release'
    Assert ((Get-Content -LiteralPath (Join-Path $install 'Setup.ps1') -Raw) -eq 'old version Setup.ps1') 'failed setup file must be replaced'
    Assert ((Get-Content -LiteralPath (Join-Path $install 'VERSION') -Raw) -eq '1.18.3') 'version file must be restored'
    Assert ((Get-Content -LiteralPath (Join-Path $install 'secrets\credential.txt') -Raw) -eq 'PRIVATE_FIXTURE_UPDATED') 'private data must be preserved'
    Assert (Test-Path -LiteralPath (Join-Path $install 'new-version-file.bin')) 'rollback must not delete unrelated user files'
    $snapshotVersionFile = Join-Path $snapshot 'payload\VERSION'
    [IO.File]::WriteAllText($snapshotVersionFile, 'CORRUPTED')
    $blocked = $false
    try { $null = Restore-NexusRecoveryFiles $snapshot $install -SkipRegistry } catch { $blocked = $true }
    Assert $blocked 'corrupt snapshots must be rejected before restoring files'
    Assert ((Get-Content -LiteralPath (Join-Path $install 'VERSION') -Raw) -eq '1.18.3') 'corrupt snapshot must not alter installed version'
    $extra = @()
    foreach ($hour in 10,11,12) {
        $folder = Join-Path $store ('snapshot-1.18.2-20261120T' + $hour + '0000-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $folder -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $folder 'manifest.json'), '{}')
        $extra += $folder
    }
    Protect-NexusRecoverySnapshot $extra[0]
    $ordinary = Join-Path $store 'user-notes'
    New-Item -ItemType Directory -Path $ordinary -Force | Out-Null
    $removed = Remove-NexusOldRecoverySnapshots $store 2
    Assert ($removed -eq 1) 'retention must remove only older unprotected snapshots'
    Assert (Test-Path -LiteralPath $extra[0]) 'a protected failed recovery snapshot must survive'
    Assert (Test-Path -LiteralPath $ordinary) 'unrelated folders must survive'
    Assert (-not (Test-Path -LiteralPath $extra[1])) 'the oldest unprotected snapshot must be removed'
    'PASS: Recovery snapshots, verified restore, corruption refusal, secret preservation and retention.'

} finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
