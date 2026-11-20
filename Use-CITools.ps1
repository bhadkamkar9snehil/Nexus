# Puts Node (with npm) and ripgrep on PATH for CI jobs when the runner lacks them. Dot-source it.
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
# GitLab API base reachable from this runner: the host the job cloned from (CI_API_V4_URL points at an address the runner cannot reach).
$ciRemote = [uri](git remote get-url origin)
$ciApi = if ($ciRemote.Host) { "$($ciRemote.Scheme)://$($ciRemote.Authority)/api/v4" } else { $env:CI_API_V4_URL }
# Keep the npm download cache between jobs so npm ci installs from disk.
$env:NPM_CONFIG_CACHE = Join-Path $env:LOCALAPPDATA 'NexusBuildCache\npm'
