param([switch]$Update)
$ErrorActionPreference='Stop'
foreach($agent in 'codex','claude'){
    $parent=Join-Path $env:USERPROFILE ".$agent"
    if(-not(Test-Path -LiteralPath $parent)){Write-Output "$agent not detected; skill installation skipped.";continue}
    $destination=Join-Path $parent 'skills\shared-harness'
    $marker=Join-Path $destination '.harness-managed'
    if(Test-Path -LiteralPath $destination){
        if(-not $Update){Write-Warning "$agent shared-harness skill already exists; preserved. Use -Update for a deliberate refresh.";continue}
        if(-not(Test-Path -LiteralPath $marker) -or (Get-Content -LiteralPath $marker -Raw).Trim() -ne $PSScriptRoot){throw 'Existing skill was not managed by this installation; preserved.'}
    }
    New-Item -ItemType Directory -Path (Join-Path $destination 'references') -Force | Out-Null
    foreach($file in 'SKILL.md','references\tools.md'){
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot "skills\shared-harness\$file") -Destination (Join-Path $destination $file) -Force
    }
    Set-Content -LiteralPath $marker -Value $PSScriptRoot -Encoding UTF8
    Write-Output "Installed shared-harness skill for $agent."
}
