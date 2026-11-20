# Puts the release build tools (Cua driver, UFFS, ripgrep, Inno Setup compiler) on PATH for the CI release job.
# They are pinned in this project's package registry (nexus-build-tools/1) and cached outside the workspace.
# To change a tool: upload a new zip as a new version, update $version and $sha256, merge. Dot-source this file.
$version = '1'
$sha256 = '445AA8464D6B9F7EE5D6233ED6136E3C5C4D95BC2A9CFAF2A9407B1F6894FD43'
$dir = "C:\CI-Tools\nexus-build-tools-$version"
if (-not (Test-Path -LiteralPath (Join-Path $dir 'cua-driver.exe'))) {
    $zip = Join-Path $env:TEMP "nexus-build-tools-$version.zip"
    $uri = "$ciApi/projects/$env:CI_PROJECT_ID/packages/generic/nexus-build-tools/$version/nexus-build-tools.zip"
    Invoke-WebRequest $uri -Headers @{ 'JOB-TOKEN' = $env:CI_JOB_TOKEN } -UseBasicParsing -OutFile $zip
    if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $sha256) { throw 'Build tools checksum mismatch.' }
    $part = "$dir.partial"
    Remove-Item -LiteralPath $part -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path (Split-Path $dir) -Force | Out-Null
    Expand-Archive -LiteralPath $zip -DestinationPath $part
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    Rename-Item -LiteralPath $part -NewName (Split-Path $dir -Leaf)
    Remove-Item -LiteralPath $zip -Force
}
$env:PATH = "$dir;$dir\inno;$env:PATH"
