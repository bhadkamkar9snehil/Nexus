param(
    [Parameter(Position = 0)][ValidateSet('status','monitor','tools','call','doctor')][string]$Action = 'status',
    [Parameter(Position = 1)][string]$Tool,
    [Parameter(Position = 2)][string]$Arguments = '{}'
)
$ErrorActionPreference = 'Stop'
$bundled = Join-Path $PSScriptRoot 'runtime\node.exe'
$node = if (Test-Path -LiteralPath $bundled) { $bundled } else { (Get-Command node -ErrorAction Stop).Source }
$cli = Join-Path $PSScriptRoot 'jev-use\cli.mjs'
switch ($Action) {
    'status' { & $node $cli search_status }
    'monitor' { & (Join-Path $PSScriptRoot 'Monitor.ps1') Start }
    'tools' { & $node $cli tools }
    'doctor' { & (Join-Path $PSScriptRoot 'Diagnose.ps1') }
    'call' {
        if (-not $Tool) { throw 'Usage: Harness.ps1 call <tool> [JSON object or @file.json]' }
        # Windows PowerShell 5.1 strips double quotes from native-command arguments, so inline JSON is
        # written to a temp file and passed as @file. An @file argument is passed through unchanged.
        $temp = $null
        if ($Arguments.StartsWith('@')) { $arg = $Arguments }
        else {
            $temp = Join-Path ([IO.Path]::GetTempPath()) ("harness-args-" + [guid]::NewGuid().ToString('N') + '.json')
            [IO.File]::WriteAllText($temp, $Arguments, (New-Object Text.UTF8Encoding $false))
            $arg = '@' + $temp
        }
        try { & $node $cli $Tool $arg } finally { if ($temp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue } }
    }
}
exit $LASTEXITCODE
