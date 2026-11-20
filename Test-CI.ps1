$ErrorActionPreference = 'Stop'
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    $version = 'v22.22.0'
    $asset = "node-$version-win-x64.zip"
    $tools = Join-Path $PSScriptRoot '.ci-tools'
    New-Item -ItemType Directory -Path $tools -Force | Out-Null
    $zip = Join-Path $tools $asset
    Invoke-WebRequest "https://nodejs.org/dist/$version/$asset" -UseBasicParsing -OutFile $zip
    $sums = (Invoke-WebRequest "https://nodejs.org/dist/$version/SHASUMS256.txt" -UseBasicParsing).Content
    $expected = (($sums -split "`n" | Where-Object { $_.Trim().EndsWith(" $asset") }) -split '\s+')[0]
    if (-not $expected -or (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Node archive checksum mismatch.' }
    Expand-Archive -LiteralPath $zip -DestinationPath $tools -Force
    $env:PATH = (Join-Path $tools "node-$version-win-x64") + ';' + $env:PATH
}
if (-not (Get-Command rg.exe -ErrorAction SilentlyContinue)) {
    $tools = Join-Path $PSScriptRoot '.ci-tools'
    New-Item -ItemType Directory -Path $tools -Force | Out-Null
    $asset = 'ripgrep-15.1.0-x86_64-pc-windows-msvc.zip'
    $zip = Join-Path $tools $asset
    Invoke-WebRequest "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/$asset" -UseBasicParsing -OutFile $zip
    if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne '124510B94B6BAA3380D051FDF4650EAA80A302C876D611E9DBA0B2E18D87493A') { throw 'ripgrep archive checksum mismatch.' }
    Expand-Archive -LiteralPath $zip -DestinationPath $tools -Force
    $env:PATH = (Join-Path $tools 'ripgrep-15.1.0-x86_64-pc-windows-msvc') + ';' + $env:PATH
}
Push-Location (Join-Path $PSScriptRoot 'jev-use')
try {
    & npm.cmd ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'Dependency restore failed.' }
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw 'Reference tests failed.' }
} finally { Pop-Location }
& (Join-Path $PSScriptRoot 'Test-Package.ps1')
& node (Join-Path $PSScriptRoot 'monitor-ui\build.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Monitor production build failed.' }
