$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot 'jev-use')
try {
    & .\node_modules\.bin\tsc.cmd --noEmit --target es2022 --module nodenext --strict --skipLibCheck shared.ts
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript validation failed.' }
    & node .\node_modules\typescript\bin\tsc -p (Join-Path $PSScriptRoot 'monitor-ui\tsconfig.json')
    if ($LASTEXITCODE -ne 0) { throw 'Monitor TypeScript validation failed.' }
    & node --check (Join-Path $PSScriptRoot 'monitor.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Monitor syntax check failed.' }
    & node --check (Join-Path $PSScriptRoot 'runtime-status.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Runtime observation syntax check failed.' }
    foreach ($script in 'Monitor.ps1','Runtime-Status.ps1','Install-Skills.ps1','Setup.ps1') {
        $parseErrors=$null
        $tokens=$null
        $null=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $script),[ref]$tokens,[ref]$parseErrors)
        if ($parseErrors.Count) { throw "PowerShell parser failed for $script" }
    }
    $reply = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | & node .\start.mjs
    if ($LASTEXITCODE -ne 0) { throw 'MCP launcher failed.' }
    $json = $reply | ConvertFrom-Json
    foreach ($name in 'jev_browse','jev_desktop','jev_search_content','search_local','network_probe','map_files','find_files','search_status','jev_select_workflow','jev_rank_results','jev_classify_failure','jev_verify_result') {
        if ($name -notin $json.result.tools.name) { throw "Missing MCP tool $name" }
    }
    'PASS: TypeScript, monitor syntax, and MCP tool discovery.'
} finally { Pop-Location }
