# Optional feature-branch preview. Builds distributable artifacts; cannot tag, publish or install.
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^preview\.[0-9a-f]{7,12}$')]
    [string]$Version
)
$ErrorActionPreference = 'Stop'
if (-not $env:CI_COMMIT_BRANCH -or $env:CI_COMMIT_BRANCH -eq $env:CI_DEFAULT_BRANCH) {
    throw 'Preview build requires a non-main CI branch'
}
$root = $PSScriptRoot
$folder = Join-Path $root 'ci-evidence'
New-Item -ItemType Directory -Path $folder -Force | Out-Null
$reportPath = Join-Path $folder 'preview.json'
$start = [DateTimeOffset]::UtcNow
$timer = [Diagnostics.Stopwatch]::StartNew()
$step = 'build'
$status = 'failed'
$artifacts = @()

try {
    Write-Host ('CI START preview build {0}' -f $Version)
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'Build-Deployment.ps1') -Version $Version -Installer
    if ($LASTEXITCODE -ne 0) { throw 'Preview package build failed' }
    $step = 'verify'
    $wanted = @(
        "shared-computer-use-$Version-windows-x64.zip",
        "Nexus-Harness-Setup-$Version-windows-x64.exe"
    )
    foreach ($name in $wanted) {
        $file = Join-Path (Join-Path $root 'dist') $name
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Expected preview artifact missing' }
        $info = Get-Item -LiteralPath $file
        if ($info.Length -lt 1024) { throw 'Preview artifact is unexpectedly small' }
        if ($name.EndsWith('.zip')) {
            Add-Type -AssemblyName System.IO.Compression
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $archive = [IO.Compression.ZipFile]::OpenRead($file)
            try {
                if ($archive.Entries.Count -lt 20) { throw 'Preview ZIP has too few entries' }
            } finally { $archive.Dispose() }
        }
        $artifacts += [pscustomobject]@{
            fileName = $name
            bytes = $info.Length
            sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        Write-Host ('CI PREVIEW VERIFIED {0} bytes={1}' -f $name, $info.Length)
    }
    $status = 'passed'
} catch {
    Write-Host ('CI PREVIEW FAILED in phase {0}; artifacts are not a release.' -f $step)
    throw
} finally {
    $timer.Stop()
    $report = [ordered]@{
        schemaVersion = 1
        type = 'branch-preview'
        status = $status
        failedPhase = if ($status -eq 'passed') { $null } else { $step }
        version = $Version
        commit = $env:CI_COMMIT_SHA
        pipelineId = $env:CI_PIPELINE_ID
        jobId = $env:CI_JOB_ID
        startedAtUtc = $start.ToString('o')
        totalSeconds = [Math]::Round($timer.Elapsed.TotalSeconds, 2)
        targetSeconds = 480
        targetExceeded = ($timer.Elapsed.TotalSeconds -gt 480)
        artifacts = $artifacts
        releasesPublished = $false
        installsPerformed = $false
    }
    $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding UTF8
    Write-Host ('CI PREVIEW RESULT status={0} seconds={1} artifacts={2}' -f $status, $report.totalSeconds, $artifacts.Count)
    if ($report.targetExceeded) { Write-Warning ('CI preview exceeded 480-second target: {0}s' -f $report.totalSeconds) }
}
