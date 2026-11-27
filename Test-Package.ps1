$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot 'jev-use')
try {
    & .\node_modules\.bin\tsc.cmd --noEmit --target es2022 --module nodenext --strict --skipLibCheck shared.ts
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript validation failed.' }
    & node .\node_modules\typescript\bin\tsc -p (Join-Path $PSScriptRoot 'monitor-ui\tsconfig.json')
    if ($LASTEXITCODE -ne 0) { throw 'Monitor TypeScript validation failed.' }
    & node --check (Join-Path $PSScriptRoot 'monitor.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Monitor syntax check failed.' }
    & node --check (Join-Path $PSScriptRoot 'jev-use\terminal-worker.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Terminal worker syntax check failed.' }
    & node --check (Join-Path $PSScriptRoot 'jev-use\chatgpt-bridge.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'ChatGPT MCP bridge syntax check failed.' }
    # Add-Type's compiler resolves System.dll from the process working directory first, and an installed copy keeps a .NET Core System.dll in its root.
    [Environment]::CurrentDirectory = $env:TEMP
    Add-Type -Path (Join-Path $PSScriptRoot 'jev-use\process-identity.cs')
    & node --check (Join-Path $PSScriptRoot 'runtime-status.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Runtime observation syntax check failed.' }
    foreach ($script in 'Monitor.ps1','Runtime-Status.ps1','Install-Skills.ps1','Setup.ps1','Nexus-Takeover.ps1','Installer-Recovery.ps1','Update-Nexus.ps1','jev-use\restart-supervisor.ps1') {
        $parseErrors=$null
        $tokens=$null
        $null=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $script),[ref]$tokens,[ref]$parseErrors)
        if ($parseErrors.Count) { throw "PowerShell parser failed for $script" }
    }
    $takeoverTests = Join-Path $PSScriptRoot 'installer\InstallerTakeover.Tests.ps1'
    if (Test-Path -LiteralPath $takeoverTests) {
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $takeoverTests
        if ($LASTEXITCODE -ne 0) { throw 'Nexus installer takeover safety tests failed.' }
    }
    $recoveryTests = Join-Path $PSScriptRoot 'tests\InstallerRecovery.Tests.ps1'
    if (Test-Path -LiteralPath $recoveryTests) {
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $recoveryTests
        if ($LASTEXITCODE -ne 0) { throw 'Nexus installer rollback tests failed.' }
    }
    $updaterRecoveryTests = Join-Path $PSScriptRoot 'tests\UpdaterRecovery.Tests.ps1'
    if (Test-Path -LiteralPath $updaterRecoveryTests) {
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $updaterRecoveryTests
        if ($LASTEXITCODE -ne 0) { throw 'Nexus updater recovery orchestration tests failed.' }
    }
    & node --test (Join-Path $PSScriptRoot 'tests\DesktopAssets.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Desktop asset resolution check failed.' }
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'tests\ReleaseMirror.Tests.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Release mirror safety checks failed.' }
    # Redirect from a file: piping from PowerShell is not reliable for a stdio server.
    $request = Join-Path ([IO.Path]::GetTempPath()) ('mcp-request-' + [guid]::NewGuid() + '.json')
    [IO.File]::WriteAllText($request, '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' + "`n")
    try { $reply = cmd.exe /c "node .\start.mjs < `"$request`"" } finally { Remove-Item -LiteralPath $request -Force -ErrorAction SilentlyContinue }
    if ($LASTEXITCODE -ne 0) { throw 'MCP launcher failed.' }
    $json = $reply | ConvertFrom-Json
    foreach ($name in 'jev_browse','jev_desktop','jev_search_content','search_local','network_probe','map_files','find_files','search_status','jev_select_workflow','jev_rank_results','jev_classify_failure','jev_verify_result','nexus_start_task','start_process','read_process_output','interact_with_process','list_sessions','force_terminate','list_processes','kill_process','restart_application','restart_status','visual_verify','visual_compare','visual_classify','visual_route','visual_grade','visual_find','visual_extract','visual_diff','visual_remember','visual_search','visual_contract','visual_wait','visual_watch','visual_asset','visual_redact','visual_capture','visual_contract_registry','visual_recipe','visual_watch_manage','visual_ocr','visual_novelty','visual_handover','visual_memory_record','visual_retention','jev_semantic_judge') {
        if ($name -notin $json.result.tools.name) { throw "Missing MCP tool $name" }
    }
    'PASS: TypeScript, monitor syntax, and MCP tool discovery.'
} finally { Pop-Location }
