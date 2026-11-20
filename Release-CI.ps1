# Runs on the Windows runner after a push to main: next version, build, upload, GitLab release with changelog.
# Uses CI_JOB_TOKEN only. Creating the release creates the tag, so tag pipelines are disabled in .gitlab-ci.yml.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Use-CITools.ps1')
. (Join-Path $PSScriptRoot 'Use-BuildTools.ps1')
$api = $ciApi; $project = $env:CI_PROJECT_ID; $headers = @{ 'JOB-TOKEN' = $env:CI_JOB_TOKEN }

git fetch --tags --force | Out-Null
$last = git tag --list 'v*.*.*' --sort=-v:refname | Select-Object -First 1
if (-not $last) { throw 'No previous vX.Y.Z tag to bump from.' }
$subjects = @(git log "$last..HEAD" --no-merges --pretty=format:%s | Where-Object { $_ })
if (-not $subjects) { Write-Host "No commits since $last; nothing to release."; exit 0 }
$major, $minor, $patch = ($last.TrimStart('v') -split '\.') | ForEach-Object { [int]$_ }
if ($subjects -match '^(?i)(feat|add|new)\b') { $minor++; $patch = 0 } else { $patch++ }
$version = "$major.$minor.$patch"
$tag = "v$version"
Write-Host "Releasing $tag (previous $last)"

./Build-Deployment.ps1 -Version $version -Installer
$files = Get-ChildItem dist -File | Where-Object { $_.Name -like "*-$version-windows-x64.*" }
if ($files.Count -lt 2) { throw "Expected installer and ZIP for $version in dist." }

$sums = @(); $links = @()
foreach ($f in $files) {
    $url = "$api/projects/$project/packages/generic/nexus-harness/$version/$($f.Name)"
    Invoke-WebRequest -Method Put -Uri $url -Headers $headers -InFile $f.FullName -UseBasicParsing | Out-Null
    $hash = (Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLower()
    $sums += "- $($f.Name): SHA256 $hash"
    $links += @{ name = $f.Name; url = $url; link_type = 'package' }
}
$notes = ($subjects | ForEach-Object { "- $_" }) -join "`n"
$body = @{
    tag_name = $tag; ref = $env:CI_COMMIT_SHA; name = "Nexus Harness $version"
    description = "## What's new`n$notes`n`n## Checksums`n$($sums -join "`n")"
    assets = @{ links = $links }
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri "$api/projects/$project/releases" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) | Out-Null
Write-Host "Published $tag"
