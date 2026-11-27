# Stable releases are not complete until the exact installer is verified on both hosts.
# GitLab is authoritative for the version, source, changelog and installer hash.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Use-CITools.ps1')
. (Join-Path $PSScriptRoot 'Use-BuildTools.ps1')
. (Join-Path $PSScriptRoot 'Release-Mirror.ps1')
$api = $ciApi; $project = $env:CI_PROJECT_ID; $headers = @{ 'JOB-TOKEN' = $env:CI_JOB_TOKEN }
$repo = 'bhadkamkar9snehil/Nexus'
if (!$project -or !$env:CI_JOB_TOKEN -or !$env:CI_COMMIT_SHA -or $env:CI_COMMIT_BRANCH -ne $env:CI_DEFAULT_BRANCH) {
    throw 'Stable release requires the protected main-branch CI context.'
}
Assert-MirrorAccess $repo
Invoke-ReleaseGit fetch --tags --force | Out-Null
$last = Invoke-ReleaseGit tag --list 'v*.*.*' --sort=-v:refname | Where-Object { $_ -match '^v\d+\.\d+\.\d+$' } | Select-Object -First 1
if (!$last) { throw 'No previous Stable release tag.' }

# Before allocating a new version, finish/verify the preceding publication.
# This also makes a retry after GitLab publication repair the SAME release and bytes.
$previous = Invoke-RestMethod -Uri "$api/projects/$project/releases/$last" -Headers $headers -TimeoutSec 30
if ($previous.tag_name -ne $last) { throw 'Previous GitLab release identity could not be verified.' }
$prior = Get-ReleaseInstallerContract $last ([string]$previous.description)
$priorVersion = $last.Substring(1)
$priorUrl = "$api/projects/$project/packages/generic/nexus-harness/$priorVersion/$($prior.name)"
# Match the GitLab package link before sending a job credential to the canonical package endpoint.
$priorLinks = @($previous.assets.links | Where-Object { $_.name -eq $prior.name })
if ($priorLinks.Count -ne 1 -or ([uri]$priorLinks[0].url).AbsolutePath -ne ([uri]$priorUrl).AbsolutePath) {
    throw 'Previous release package link could not be verified.'
}
Sync-GithubRelease $repo $last $last ([string]$previous.description) $priorUrl $headers
& git.exe merge-base --is-ancestor $last HEAD
if ($LASTEXITCODE -ne 0) { throw 'Release job checkout does not contain the latest Stable tag. No version allocated.' }
$subjects = @(Invoke-ReleaseGit log "$last..HEAD" --no-merges --pretty=format:%s | Where-Object { $_ })
if (!$subjects) { Write-Host "Both GitLab and GitHub publication verified for $last; nothing new to release."; exit 0 }
$major, $minor, $patch = ($last.TrimStart('v') -split '\.') | ForEach-Object { [int]$_ }
if ($subjects -match '^(?i)(?:[\w-]+:\s*)?(feat|add|new)\b') { $minor++; $patch = 0 } else { $patch++ }
$version = "$major.$minor.$patch"
$tag = "v$version"
Write-Host "Releasing $tag (previous $last)"
./Build-Deployment.ps1 -Version $version -Installer -InstallerOnly
$files = @(Get-ChildItem dist -File | Where-Object { $_.Name -eq "Nexus-Harness-Setup-$version-windows-x64.exe" })
if ($files.Count -ne 1) { throw "Expected the installer for $version in dist." }
$f = $files[0]
$url = "$api/projects/$project/packages/generic/nexus-harness/$version/$($f.Name)"
# Stream the installer, not the payload in memory. Do not echo authentication arguments.
$p = Start-Process -FilePath curl.exe -NoNewWindow -PassThru -ArgumentList '-sS', '-f', '--retry', '3', '-H', ('"JOB-TOKEN: '+$env:CI_JOB_TOKEN+'"'), '-T', ('"'+$f.FullName+'"'), ('"'+$url+'"'), '-o', 'NUL'
$null = $p.Handle
$p.WaitForExit()
if ($p.ExitCode -ne 0) { throw 'GitLab package upload failed.' }
$hash = (Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$notes = ($subjects | ForEach-Object { "- $_" }) -join [Environment]::NewLine
$description = "## What's new" + [Environment]::NewLine + $notes + [Environment]::NewLine + [Environment]::NewLine + '## Checksums' + [Environment]::NewLine + "- $($f.Name): SHA256 $hash"
$body = @{
    tag_name = $tag; ref = $env:CI_COMMIT_SHA; name = "Nexus Harness $version"
    description = $description
    assets = @{ links = @(@{name=$f.Name;url=$url;link_type='package'}) }
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri "$api/projects/$project/releases" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 60 | Out-Null
Write-Host "GitLab published $tag; required GitHub publication follows."
Sync-GithubRelease $repo $tag $env:CI_COMMIT_SHA $description $url $headers $f.FullName
Write-Host "RELEASE VERIFIED: $tag on GitLab and GitHub with matching installer SHA256."
