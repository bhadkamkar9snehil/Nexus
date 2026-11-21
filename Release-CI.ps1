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

$sums = @(); $links = @(); $uploads = @()
foreach ($f in $files) {
    $url = "$api/projects/$project/packages/generic/nexus-harness/$version/$($f.Name)"
    # curl.exe streams the 200 MB file (Invoke-WebRequest -InFile buffers it in memory); both files upload at once.
    $p = Start-Process -FilePath curl.exe -NoNewWindow -PassThru -ArgumentList '-sS', '-f', '--retry', '3', '-H', "`"JOB-TOKEN: $env:CI_JOB_TOKEN`"", '-T', "`"$($f.FullName)`"", "`"$url`"", '-o', 'NUL'
    $null = $p.Handle # Windows PowerShell loses ExitCode unless the process handle is read while it runs
    $uploads += $p
    $hash = (Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLower()
    $sums += "- $($f.Name): SHA256 $hash"
    $links += @{ name = $f.Name; url = $url; link_type = 'package' }
}
foreach ($u in $uploads) { $u.WaitForExit() }
if ($uploads | Where-Object { $_.ExitCode -ne 0 }) { throw 'A package upload failed.' }
$notes = ($subjects | ForEach-Object { "- $_" }) -join "`n"
$body = @{
    tag_name = $tag; ref = $env:CI_COMMIT_SHA; name = "Nexus Harness $version"
    description = "## What's new`n$notes`n`n## Checksums`n$($sums -join "`n")"
    assets = @{ links = $links }
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri "$api/projects/$project/releases" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) | Out-Null
Write-Host "Published $tag"

# GitHub mirror (CI variable GITHUB_TOKEN, masked and protected): the source without the CI files, the tag, and the same installer and ZIP.
if ($env:GITHUB_TOKEN) {
    # Not named Git: PowerShell command names are case-insensitive, so the function would call itself.
    function Invoke-Git { & git.exe @args; if ($LASTEXITCODE) { throw "git $($args -join ' ') failed" } }
    $env:GH_TOKEN = $env:GITHUB_TOKEN
    $repo = 'bhadkamkar9snehil/Nexus'
    $mirror = Join-Path $env:TEMP "nexus-github-$version"
    Remove-Item -LiteralPath $mirror -Recurse -Force -ErrorAction SilentlyContinue
    Invoke-Git clone --quiet "https://x-access-token:$($env:GITHUB_TOKEN)@github.com/$repo.git" $mirror
    Invoke-Git -C $mirror rm -r -q --ignore-unmatch .
    $src = Join-Path $env:TEMP "nexus-source-$version.zip"
    Invoke-Git archive --format=zip -o $src HEAD
    Expand-Archive -LiteralPath $src -DestinationPath $mirror -Force
    Remove-Item -LiteralPath (Join-Path $mirror '.gitlab-ci.yml') -Force -ErrorAction SilentlyContinue
    Invoke-Git -C $mirror add -A
    Invoke-Git -C $mirror -c user.name=Nexus -c user.email=nexus@users.noreply.github.com commit -q -m "Nexus: synchronize v$version source"
    Invoke-Git -C $mirror tag -a $tag -m "Nexus Harness $version"
    Invoke-Git -C $mirror push --quiet origin HEAD:main $tag
    $notesFile = Join-Path $env:TEMP "nexus-notes-$version.md"
    Set-Content -LiteralPath $notesFile -Value "## What's new`n$notes`n`n## Checksums`n$($sums -join "`n")" -Encoding utf8
    & gh release create $tag @($files.FullName) --repo $repo --title "Nexus Harness $version" --notes-file $notesFile --latest
    if ($LASTEXITCODE) { throw 'GitHub release failed.' }
    Write-Host "Published $tag to GitHub"
}
