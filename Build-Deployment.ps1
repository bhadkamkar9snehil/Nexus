param([string]$Version = 'dev', [string]$SourceRef = 'HEAD', [switch]$Installer)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^[A-Za-z0-9.-]+$') { throw 'Invalid version label.' }
$stageRoot = Join-Path $env:TEMP ('harness-bundle-' + [guid]::NewGuid())
$stage = Join-Path $stageRoot 'shared-computer-use'
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
$archive = Join-Path $stageRoot 'source.zip'
& git -C $PSScriptRoot archive --format=zip --output=$archive $SourceRef
if ($LASTEXITCODE -ne 0) { throw 'Source archive failed.' }
Expand-Archive -LiteralPath $archive -DestinationPath $stage
$runtime = Join-Path $stage 'runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
Push-Location (Join-Path $stage 'jev-use')
try {
    $env:NPM_CONFIG_CACHE = Join-Path $env:LOCALAPPDATA 'NexusBuildCache\npm'
    & npm.cmd ci --ignore-scripts --prefer-offline --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dependency restore failed.' }
} finally { Pop-Location }
& node (Join-Path $stage 'monitor-ui\build.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Monitor build failed.' }
# The Windows CI baseline is also the redistributable Node runtime.
$nodeVersion = 'v22.22.0'
$nodeAsset = "node-$nodeVersion-win-x64.zip"
# Download once and keep the verified archive; the checksum is re-checked on every use.
$cache = Join-Path $env:LOCALAPPDATA 'NexusBuildCache'
New-Item -ItemType Directory -Path $cache -Force | Out-Null
$nodeZip = Join-Path $cache $nodeAsset
$expectedFile = Join-Path $cache "$nodeAsset.sha256"
if (-not (Test-Path -LiteralPath $nodeZip) -or -not (Test-Path -LiteralPath $expectedFile)) {
    Invoke-WebRequest "https://nodejs.org/dist/$nodeVersion/$nodeAsset" -UseBasicParsing -OutFile $nodeZip
    $sums = (Invoke-WebRequest "https://nodejs.org/dist/$nodeVersion/SHASUMS256.txt" -UseBasicParsing).Content
    Set-Content -LiteralPath $expectedFile -Value ((($sums -split "`n" | Where-Object { $_.Trim().EndsWith(" $nodeAsset") }) -split '\s+')[0]) -Encoding ASCII
}
$expected = (Get-Content -LiteralPath $expectedFile -Raw).Trim()
if (-not $expected -or (Get-FileHash -LiteralPath $nodeZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { Remove-Item -LiteralPath $nodeZip, $expectedFile -Force; throw 'Node checksum mismatch.' }
Expand-Archive -LiteralPath $nodeZip -DestinationPath $stageRoot
$nodeFolder = Join-Path $stageRoot "node-$nodeVersion-win-x64"
[IO.File]::Copy((Join-Path $nodeFolder 'node.exe'), (Join-Path $runtime 'node.exe'))
[IO.File]::Copy((Join-Path $nodeFolder 'LICENSE'), (Join-Path $runtime 'NODE-LICENSE'))
Invoke-WebRequest 'https://raw.githubusercontent.com/skyllc-ai/UltraFastFileSearch/v0.6.47/LICENSES/MPL-2.0.txt' -UseBasicParsing -OutFile (Join-Path $runtime 'UFFS-MPL-2.0.txt')
Invoke-WebRequest 'https://raw.githubusercontent.com/BurntSushi/ripgrep/15.1.0/LICENSE-MIT' -UseBasicParsing -OutFile (Join-Path $runtime 'RIPGREP-LICENSE-MIT')
$driver = (Get-Command cua-driver -ErrorAction Stop).Source
foreach ($path in @($driver, (Join-Path (Split-Path $driver) 'cua-driver-uia.exe'))) {
    if (Test-Path -LiteralPath $path) { [IO.File]::Copy($path, (Join-Path $runtime (Split-Path $path -Leaf))) }
}
foreach ($name in 'uffs','uffsd','uffs-broker','rg') {
    $alias = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\$name.exe"
    $path = if (Test-Path -LiteralPath $alias) { $alias } else { (Get-Command $name -ErrorAction Stop).Source }
    [IO.File]::Copy($path, (Join-Path $runtime "$name.exe"))
}
$lock = (Get-FileHash -LiteralPath (Join-Path $stage 'jev-use\package-lock.json') -Algorithm SHA256).Hash
Set-Content -LiteralPath (Join-Path $stage '.bundled-lock.sha256') -Value $lock -Encoding ASCII
$manifest = Get-ChildItem -LiteralPath $runtime -File | ForEach-Object {
    [pscustomobject]@{name=$_.Name;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime 'SHA256.json') -Encoding UTF8
$env:PATH = $runtime + ';' + $env:PATH
& (Join-Path $stage 'Test-Package.ps1')
$outputDir = Join-Path $PSScriptRoot 'dist'
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$output = Join-Path $outputDir "shared-computer-use-$Version-windows-x64.zip"
if (Test-Path -LiteralPath $output) { throw 'Output archive exists; choose a fresh version label.' }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$sevenZip = Get-Command 7z.exe -ErrorAction SilentlyContinue
if ($sevenZip) {
    Push-Location $stageRoot
    try {
        & $sevenZip.Source a -tzip -mx=1 -bd -bso0 $output 'shared-computer-use'
        if ($LASTEXITCODE -ne 0) { throw 'Deployment archive creation failed.' }
    } finally { Pop-Location }
} else {
    [IO.Compression.ZipFile]::CreateFromDirectory($stage,$output,[IO.Compression.CompressionLevel]::Fastest,$true)
}
Get-Item -LiteralPath $output | Select-Object FullName,Length
Get-FileHash -LiteralPath $output -Algorithm SHA256
if ($Installer) {
    $iscc = Join-Path $PSScriptRoot 'dist\inno-compiler\ISCC.exe'
    if (-not (Test-Path -LiteralPath $iscc)) { $iscc = (Get-Command ISCC.exe -ErrorAction Stop).Source }
    & (Join-Path $stage 'Publish-Desktop.ps1') -PayloadDir $stage
    & $iscc "/DPayloadDir=$stage" "/DOutputDir=$outputDir" "/DVersion=$Version" (Join-Path $stage 'installer\Nexus.iss')
    if ($LASTEXITCODE -ne 0) { throw 'Installer build failed.' }
    Get-FileHash -LiteralPath (Join-Path $outputDir "Nexus-Harness-Setup-$Version-windows-x64.exe") -Algorithm SHA256
}
