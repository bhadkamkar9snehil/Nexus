param(
    [ValidateSet('status','monitor','tools','call')][string]$Action = 'status',
    [string]$Tool,
    [string]$Arguments = '{}'
)
$ErrorActionPreference = 'Stop'
$bundled = Join-Path $PSScriptRoot 'runtime\node.exe'
$node = if (Test-Path -LiteralPath $bundled) { $bundled } else { (Get-Command node -ErrorAction Stop).Source }
$cli = Join-Path $PSScriptRoot 'jev-use\cli.mjs'
switch ($Action) {
    'status' { & $node $cli search_status }
    'monitor' { & (Join-Path $PSScriptRoot 'Monitor.ps1') Start }
    'tools' { & $node $cli tools }
    'call' {
        if (-not $Tool) { throw 'Specify -Tool and optionally -Arguments JSON or @file.json.' }
        & $node $cli $Tool $Arguments
    }
}
exit $LASTEXITCODE
