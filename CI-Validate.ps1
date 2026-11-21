# Branch-only validation. Produces bounded evidence for GitLab; never publishes or installs Nexus.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$evidence = Join-Path $root 'ci-evidence'
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$summaryFile = Join-Path $evidence 'validation.json'
$junitFile = Join-Path $evidence 'unit-tests.xml'
Remove-Item -LiteralPath $summaryFile, $junitFile -Force -ErrorAction SilentlyContinue
$startUtc = [DateTimeOffset]::UtcNow
$clock = [Diagnostics.Stopwatch]::StartNew()
$phases = New-Object System.Collections.ArrayList
$failedPhase = $null
$status = 'failed'
$tests = 0
$failures = 0

function Invoke-ValidationStep([string]$name, [scriptblock]$operation) {
    $step = [Diagnostics.Stopwatch]::StartNew()
    Write-Host ('CI START {0}' -f $name)
    try {
        & $operation
        [void]$script:phases.Add([pscustomobject]@{
            name = $name; status = 'passed'; duration_seconds = [Math]::Round($step.Elapsed.TotalSeconds, 2)
        })
        Write-Host ('CI PASS {0}: {1:N2}s' -f $name, $step.Elapsed.TotalSeconds)
    } catch {
        $script:failedPhase = $name
        [void]$script:phases.Add([pscustomobject]@{
            name = $name; status = 'failed'; duration_seconds = [Math]::Round($step.Elapsed.TotalSeconds, 2)
        })
        Write-Host ('CI FAIL {0}: {1:N2}s' -f $name, $step.Elapsed.TotalSeconds)
        throw
    }
}

try {
    Invoke-ValidationStep 'npm-restore' {
        Push-Location (Join-Path $root 'jev-use')
        try {
            & npm.cmd ci --ignore-scripts --prefer-offline --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw 'npm dependency restore failed' }
        } finally { Pop-Location }
    }
    Invoke-ValidationStep 'package-check' {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'Test-Package.ps1')
        if ($LASTEXITCODE -ne 0) { throw 'Package check failed' }
    }
    Invoke-ValidationStep 'mcp-tool-call' {
        $requestFile = Join-Path $evidence 'mcp-smoke-input.json'
        [IO.File]::WriteAllText($requestFile, '{"session":"nexus_ci_missing_probe_2026"}', [Text.UTF8Encoding]::new($false))
        try {
            Push-Location (Join-Path $root 'jev-use')
            try {
                $raw = & node (Join-Path $root 'jev-use\cli.mjs') browser_read_page ('@' + $requestFile)
                $exit = $LASTEXITCODE
            } finally { Pop-Location }
            if ($exit -ne 2) { throw 'MCP read-only smoke returned an unexpected exit code' }
            $result = $raw | ConvertFrom-Json
            if ($result.status -ne 'blocked' -or $result.reason -ne 'session_not_open') {
                throw 'MCP smoke did not return the expected missing-session result'
            }
        } finally { Remove-Item -LiteralPath $requestFile -Force -ErrorAction SilentlyContinue }
    }
    Invoke-ValidationStep 'headless-tests' {
        Push-Location (Join-Path $root 'jev-use')
        try {
            $files = @(Get-ChildItem '.\typescript\*.test.ts' |
                Where-Object { $_.Name -ne 'restart-application.test.ts' } |
                ForEach-Object { $_.FullName })
            if ($files.Count -lt 1) { throw 'No headless tests found' }
            & node --import tsx --test --test-reporter=junit ("--test-reporter-destination=$junitFile") $files
            if ($LASTEXITCODE -ne 0) { throw 'Headless tests failed' }
        } finally { Pop-Location }
    }
    $status = 'passed'
} catch {
    Write-Host ('CI FAILED in phase {0}. Review job trace and JUnit report.' -f $failedPhase)
    throw
} finally {
    $clock.Stop()
    if (Test-Path -LiteralPath $junitFile) {
        $xml = Get-Content -LiteralPath $junitFile -Raw
        $tests = [regex]::Matches($xml, '<testcase[\s>]').Count
        $failures = [regex]::Matches($xml, '<failure[\s>]').Count
    }
    $summary = [ordered]@{
        schemaVersion = 1
        type = 'branch-validation'
        status = $status
        failedPhase = $failedPhase
        commit = $env:CI_COMMIT_SHA
        pipelineId = $env:CI_PIPELINE_ID
        jobId = $env:CI_JOB_ID
        nodeVersion = (& node --version)
        startedAtUtc = $startUtc.ToString('o')
        totalSeconds = [Math]::Round($clock.Elapsed.TotalSeconds, 2)
        targetSeconds = 120
        targetExceeded = ($clock.Elapsed.TotalSeconds -gt 120)
        testCases = $tests
        failures = $failures
        phases = @($phases.ToArray())
    }
    $summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $summaryFile -Encoding UTF8
    Write-Host ('CI RESULT status={0} tests={1} failures={2} totalSeconds={3}' -f $status, $tests, $failures, $summary.totalSeconds)
    if ($summary.targetExceeded) { Write-Warning ('CI validation exceeded 120-second target: {0}s' -f $summary.totalSeconds) }
    Write-Host ('CI EVIDENCE {0}' -f $summaryFile)
}
