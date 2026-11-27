# Shared, fail-closed Stable release mirror helpers. No credentials in URLs or diagnostics.
function Get-ReleaseInstallerContract([string]$Tag, [string]$Description) {
    if ($Tag -notmatch '^v\d+\.\d+\.\d+$') { throw 'Invalid Stable release tag.' }
    $name = "Nexus-Harness-Setup-$($Tag.Substring(1))-windows-x64.exe"
    $pattern = '(?im)^\s*-\s*' + [regex]::Escape($name) + ':\s*SHA256\s+([a-f0-9]{64})\s*$'
    $matches = [regex]::Matches($Description, $pattern)
    if ($matches.Count -ne 1) { throw "Missing or ambiguous installer checksum for $Tag." }
    return [pscustomobject]@{ name = $name; sha256 = $matches[0].Groups[1].Value.ToLowerInvariant() }
}
function Get-MirrorAssetState($Release, $Contract) {
    if ($null -eq $Release) { return 'missing-release' }
    if ($Release.draft -or $Release.prerelease) { throw 'Stable mirror is not a published Stable release.' }
    $found = @($Release.assets | Where-Object { $_.name -eq $Contract.name })
    if ($found.Count -eq 0) { return 'missing-asset' }
    if ($found.Count -ne 1 -or $found[0].state -ne 'uploaded') { throw 'Ambiguous or incomplete mirror installer.' }
    if ([string]::IsNullOrWhiteSpace($found[0].digest)) { return 'download-to-verify' }
    if ($found[0].digest -ne ('sha256:' + $Contract.sha256)) { throw 'GitHub installer checksum differs; refusing to overwrite published asset.' }
    return 'verified'
}
function Invoke-ReleaseGit {
    & git.exe @args
    if ($LASTEXITCODE -ne 0) { throw 'Release Git command failed; review sanitized command output.' }
}
function Get-GithubRelease([string]$Repo, [string]$Tag) {
    try {
        return Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag" -Headers @{
            Authorization = "Bearer $env:GH_TOKEN"; 'User-Agent' = 'Nexus-CI'; 'Accept' = 'application/vnd.github+json'
        } -TimeoutSec 30
    } catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) { return $null }
        throw 'GitHub release lookup failed; cannot establish publication state.'
    }
}
function Assert-MirrorAccess([string]$Repo) {
    if ([string]::IsNullOrWhiteSpace($env:GITHUB_TOKEN)) { throw 'Required protected CI variable GITHUB_TOKEN is missing. No release will be published.' }
    if (!(Get-Command gh -ErrorAction SilentlyContinue)) { throw 'GitHub CLI is required on the release runner.' }
    $env:GH_TOKEN = $env:GITHUB_TOKEN
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GH_PROMPT_DISABLED = '1'
    $permission = & gh api "repos/$Repo" --jq '.permissions.push'
    if ($LASTEXITCODE -ne 0 -or ([string]$permission).Trim() -ne 'true') { throw 'GitHub release repository push access could not be verified.' }
}
function Assert-InstallerHash([string]$Path, $Contract) {
    if (!(Test-Path -LiteralPath $Path -PathType Leaf) -or
        (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Contract.sha256) {
        throw 'Installer SHA256 verification failed.'
    }
}
function Sync-GithubSource([string]$Repo, [string]$Tag, [string]$SourceRef, [string]$Scratch) {
    $mirror = Join-Path $Scratch 'mirror'
    $archive = Join-Path $Scratch 'source.zip'
    # Use the GitHub CLI credential helper only for these Git invocations. Never embed tokens in URLs.
    $auth = @('-c','credential.helper=','-c','credential.helper=!gh auth git-credential')
    Invoke-ReleaseGit @auth clone --quiet "https://github.com/$Repo.git" $mirror
    Invoke-ReleaseGit -C $mirror rm -r -q --ignore-unmatch .
    Invoke-ReleaseGit archive --format=zip -o $archive $SourceRef
    Expand-Archive -LiteralPath $archive -DestinationPath $mirror -Force
    Remove-Item -LiteralPath (Join-Path $mirror '.gitlab-ci.yml') -Force -ErrorAction SilentlyContinue
    Invoke-ReleaseGit -C $mirror add -A -f -- .
    $tree = [string](Invoke-ReleaseGit -C $mirror write-tree)
    $tagRef = "refs/tags/$Tag"
    & git.exe -C $mirror show-ref --verify --quiet $tagRef
    $tagExit = $LASTEXITCODE
    if ($tagExit -eq 0) {
        $existing = [string](Invoke-ReleaseGit -C $mirror rev-parse "$tagRef^{tree}")
        if ($tree.Trim() -ne $existing.Trim()) { throw "GitHub tag $Tag has different source; refusing to retag." }
    } elseif ($tagExit -eq 1) {
        Invoke-ReleaseGit -C $mirror -c user.name=Nexus -c user.email=nexus@users.noreply.github.com commit -q --allow-empty -m "Nexus: synchronize $Tag source"
        Invoke-ReleaseGit -C $mirror tag -a $Tag -m "Nexus Harness $Tag"
        Invoke-ReleaseGit @auth -C $mirror push --quiet --atomic origin HEAD:main $tagRef
    } else { throw 'Could not inspect GitHub tag.' }
    # Read remote tag after push or retry; no force updates.
    $localTag = [string](Invoke-ReleaseGit -C $mirror rev-parse $tagRef)
    $remoteTag = @(Invoke-ReleaseGit @auth -C $mirror ls-remote --refs origin $tagRef)
    if ($remoteTag.Count -ne 1 -or ($remoteTag[0] -split '\s+')[0] -ne $localTag.Trim()) { throw 'Remote GitHub tag verification failed.' }
}
function Sync-GithubRelease([string]$Repo, [string]$Tag, [string]$SourceRef, [string]$Description, [string]$PackageUrl, [hashtable]$GitlabHeaders, [string]$LocalInstaller = '') {
    $contract = Get-ReleaseInstallerContract $Tag $Description
    $release = Get-GithubRelease $Repo $Tag
    $state = Get-MirrorAssetState $release $contract
    if ($state -eq 'verified') {
        # Published asset is immutable for our purposes. Check its published note checksum too.
        $note = Get-ReleaseInstallerContract $Tag ([string]$release.body)
        if ($note.sha256 -ne $contract.sha256) { throw 'GitHub release notes checksum differs.' }
        $tagLine = @(Invoke-ReleaseGit ls-remote --refs "https://github.com/$Repo.git" "refs/tags/$Tag")
        if ($tagLine.Count -ne 1) { throw 'GitHub release tag is missing.' }
        Write-Host "Verified matching GitHub release $Tag and installer SHA256."
        return
    }
    $scratch = Join-Path $env:TEMP ('nexus-release-mirror-' + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $scratch | Out-Null
    try {
        if ($state -eq 'download-to-verify') {
            $download = Join-Path $scratch $contract.name
            & gh release download $Tag --repo $Repo --pattern $contract.name --dir $scratch
            if ($LASTEXITCODE -ne 0) { throw 'Could not download existing GitHub installer for verification.' }
            Assert-InstallerHash $download $contract
            $note = Get-ReleaseInstallerContract $Tag ([string]$release.body)
            if ($note.sha256 -ne $contract.sha256) { throw 'GitHub release notes checksum differs.' }
            Sync-GithubSource $Repo $Tag $SourceRef (New-Item -ItemType Directory -Path (Join-Path $scratch 'source')).FullName
            Write-Host "Verified existing GitHub release $Tag by downloaded installer."
            return
        }
        $installer = $LocalInstaller
        if (!$installer) {
            $installer = Join-Path $scratch $contract.name
            Invoke-WebRequest -Uri $PackageUrl -Headers $GitlabHeaders -UseBasicParsing -OutFile $installer -TimeoutSec 900
        }
        Assert-InstallerHash $installer $contract
        Sync-GithubSource $Repo $Tag $SourceRef $scratch
        $notesFile = Join-Path $scratch 'notes.md'
        [IO.File]::WriteAllText($notesFile,$Description,[Text.UTF8Encoding]::new($false))
        if ($state -eq 'missing-release') {
            & gh release create $Tag $installer --verify-tag --repo $Repo --title "Nexus Harness $($Tag.Substring(1))" --notes-file $notesFile --latest
            if ($LASTEXITCODE -ne 0) { throw 'Required GitHub release creation failed; retry the same GitLab job.' }
        } elseif ($state -eq 'missing-asset') {
            $note = Get-ReleaseInstallerContract $Tag ([string]$release.body)
            if ($note.sha256 -ne $contract.sha256) { throw 'GitHub release notes checksum differs.' }
            & gh release upload $Tag $installer --repo $Repo
            if ($LASTEXITCODE -ne 0) { throw 'Required GitHub installer upload failed; retry the same GitLab job.' }
        }
        # Allow bounded API propagation delay; never mark the job successful without matching asset digest.
        for ($i=0;$i -lt 6;$i++) {
            $published = Get-GithubRelease $Repo $Tag
            $finalState = Get-MirrorAssetState $published $contract
            if ($finalState -eq 'verified') {
                $note = Get-ReleaseInstallerContract $Tag ([string]$published.body)
                if ($note.sha256 -ne $contract.sha256) { throw 'GitHub release notes checksum differs.' }
                Write-Host "Verified matching GitHub release $Tag and installer SHA256."
                return
            }
            Start-Sleep -Seconds 3
        }
        throw 'Required GitHub release or checksum verification incomplete; retry the same GitLab job.'
    } finally {
        Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
    }
}
