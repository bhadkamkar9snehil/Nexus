$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'Release-Mirror.ps1')
function Assert($condition,[string]$message) { if (!$condition) { throw $message } }
function Assert-Throws([scriptblock]$action,[string]$pattern) {
    $caught = $false
    try { & $action | Out-Null } catch { if ($_.Exception.Message -notmatch $pattern) { throw }; $caught = $true }
    if (!$caught) { throw "Expected exception: $pattern" }
}
$tag='v1.25.2'
$name='Nexus-Harness-Setup-1.25.2-windows-x64.exe'
$hash='a'*64
$description="## Checksums"+[Environment]::NewLine+"- $($name): SHA256 $hash"
$c=Get-ReleaseInstallerContract $tag $description
Assert ($c.name -eq $name -and $c.sha256 -eq $hash) 'Installer contract invalid'
Assert-Throws { Get-ReleaseInstallerContract 'v2.0.0-beta.1' $description } 'Invalid Stable'
Assert-Throws { Get-ReleaseInstallerContract $tag 'no digest' } 'Missing or ambiguous'
Assert-Throws { Get-ReleaseInstallerContract $tag ($description+[Environment]::NewLine+$description) } 'Missing or ambiguous'
Assert ((Get-MirrorAssetState $null $c) -eq 'missing-release') 'Missing release not detected'
$r=[pscustomobject]@{draft=$false;prerelease=$false;body=$description;assets=@()}
Assert ((Get-MirrorAssetState $r $c) -eq 'missing-asset') 'Missing asset not detected'
$r.assets=@([pscustomobject]@{name=$name;state='uploaded';digest=''})
Assert ((Get-MirrorAssetState $r $c) -eq 'download-to-verify') 'Digest fallback missing'
$r.assets[0].digest='sha256:'+$hash
Assert ((Get-MirrorAssetState $r $c) -eq 'verified') 'Matching digest rejected'
$r.assets[0].digest='sha256:'+('b'*64)
Assert-Throws { Get-MirrorAssetState $r $c } 'checksum differs'
$r.assets[0].digest='sha256:'+$hash
$r.draft=$true
Assert-Throws { Get-MirrorAssetState $r $c } 'not a published Stable'
$r.draft=$false
$r.prerelease=$true
Assert-Throws { Get-MirrorAssetState $r $c } 'not a published Stable'
$r.prerelease=$false
$r.assets+=@($r.assets[0])
Assert-Throws { Get-MirrorAssetState $r $c } 'Ambiguous'
$r.assets=@($r.assets[0])
$original=$env:GITHUB_TOKEN
try { Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue; Assert-Throws { Assert-MirrorAccess 'fixture/repo' } 'required protected CI variable' }
finally { if ($null -ne $original) { $env:GITHUB_TOKEN=$original } else { Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue } }
# Mock remote reads/writes; no live host calls or credentials required.
$script:fixtureRelease=$r
$script:tagReads=0
function Get-GithubRelease([string]$Repo,[string]$Tag) { return $script:fixtureRelease }
function Invoke-ReleaseGit { $script:tagReads++; return ('b'*40)+[char]9+'refs/tags/v1.25.2' }
Sync-GithubRelease 'fixture/repo' $tag $tag $description 'http://fixture.invalid' @{}
Assert ($script:tagReads -eq 1) 'Verified existing release should only check tag, not publish'
$script:fixtureRelease.body=$description.Replace($hash,('b'*64))
Assert-Throws { Sync-GithubRelease 'fixture/repo' $tag $tag $description 'http://fixture.invalid' @{} } 'notes checksum differs'
$script:fixtureRelease.body=$description
$root=Split-Path $PSScriptRoot -Parent
$release=[IO.File]::ReadAllText((Join-Path $root 'Release-CI.ps1'))
$gate=$release.IndexOf('Assert-MirrorAccess $repo')
$repair=$release.IndexOf('Sync-GithubRelease $repo $last')
$allocate=$release.IndexOf('$subjects =')
Assert ($gate -ge 0 -and $gate -lt $repair -and $repair -lt $allocate) 'Missing required preflight or retry-before-bump'
Assert ($release.Contains('Sync-GithubRelease $repo $tag $env:CI_COMMIT_SHA')) 'New release does not require mirror'
$ci=[IO.File]::ReadAllText((Join-Path $root '.gitlab-ci.yml'))
Assert ($ci.Contains("'Release-CI.ps1'") -and $ci.Contains("'Release-Mirror.ps1'")) 'Release changes do not trigger release'
Write-Host 'PASS: required token, checksums, mirror state, idempotent verification, fail-closed conflicts and retry ordering.'

# A GitLab release already exists but GitHub publication was interrupted.
# The mirror must download its exact existing installer and reuse the same tag.
$fixtureDir=Join-Path $env:TEMP ('nexus-mirror-fixture-'+[guid]::NewGuid())
New-Item -ItemType Directory -Path $fixtureDir | Out-Null
try {
    $script:fixtureFile=Join-Path $fixtureDir $name
    [IO.File]::WriteAllText($script:fixtureFile,'fixture installer bytes')
    $script:fixtureDigest=(Get-FileHash -LiteralPath $script:fixtureFile -Algorithm SHA256).Hash.ToLowerInvariant()
    $script:fixtureNotes="## Checksums"+[Environment]::NewLine+"- $($name): SHA256 $script:fixtureDigest"
    $script:fixtureRelease=$null
    $script:sourceCalls=0;$script:downloads=0;$script:publishCalls=0
    $script:simulateFailure=$true
    function Invoke-WebRequest {
        param($Uri,$Headers,[switch]$UseBasicParsing,$OutFile,$TimeoutSec)
        $script:downloads++
        Copy-Item -LiteralPath $script:fixtureFile -Destination $OutFile
    }
    function Sync-GithubSource($Repo,$Tag,$SourceRef,$Scratch) {
        Assert ($Tag -eq 'v1.25.2' -and $SourceRef -eq 'v1.25.2') 'Retry changed tag/source'
        $script:sourceCalls++
    }
    function gh {
        $script:publishCalls++
        Assert ($args[0] -eq 'release' -and $args[1] -eq 'create' -and $args[2] -eq 'v1.25.2') 'Unexpected mirror publication'
        Assert ($args -contains '--verify-tag') 'Tag verification not requested'
        Assert ((Get-FileHash -LiteralPath $args[3] -Algorithm SHA256).Hash.ToLowerInvariant() -eq $script:fixtureDigest) 'Retry changed installer bytes'
        if ($script:simulateFailure) { $global:LASTEXITCODE=1; return }
        $global:LASTEXITCODE=0
        $script:fixtureRelease=[pscustomobject]@{draft=$false;prerelease=$false;body=$script:fixtureNotes;assets=@([pscustomobject]@{name=$name;state='uploaded';digest='sha256:'+$script:fixtureDigest})}
    }
    Assert-Throws { Sync-GithubRelease 'fixture/repo' $tag $tag $script:fixtureNotes 'http://fixture.invalid' @{} } 'creation failed'
    Assert ($null -eq $script:fixtureRelease) 'Failed mirror unexpectedly succeeded'
    $script:simulateFailure=$false
    Sync-GithubRelease 'fixture/repo' $tag $tag $script:fixtureNotes 'http://fixture.invalid' @{}
    Assert ($script:sourceCalls -eq 2 -and $script:downloads -eq 2 -and $script:publishCalls -eq 2) 'Interrupted publication not retried exactly once'
    Sync-GithubRelease 'fixture/repo' $tag $tag $script:fixtureNotes 'http://fixture.invalid' @{}
    Assert ($script:publishCalls -eq 2 -and $script:downloads -eq 2) 'Healthy mirror was needlessly republished'
    Write-Host 'PASS: interrupted publication retries same tag and exact installer, then verifies without duplicate publication.'
} finally {
    Remove-Item -LiteralPath $fixtureDir -Recurse -Force -ErrorAction SilentlyContinue
}
