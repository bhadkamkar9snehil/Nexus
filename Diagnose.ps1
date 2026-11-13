$ErrorActionPreference = 'Stop'
$runtime = Join-Path $PSScriptRoot 'runtime'
$node = Join-Path $runtime 'node.exe'
if (-not (Test-Path -LiteralPath $node)) { $node = (Get-Command node -ErrorAction Stop).Source }
'Node:'
& $node --version
'MCP tool catalog:'
& $node (Join-Path $PSScriptRoot 'jev-use\cli.mjs') tools
if ($LASTEXITCODE -ne 0) { throw 'MCP discovery failed.' }
'Search runtime:'
& $node (Join-Path $PSScriptRoot 'jev-use\cli.mjs') search_status
if ($LASTEXITCODE -ne 0) { throw 'Search status failed.' }
$driver = Join-Path $runtime 'cua-driver.exe'
if (-not (Test-Path -LiteralPath $driver)) { $driver = (Get-Command cua-driver -ErrorAction Stop).Source }
'Cua Driver:'
& $driver --version
& $driver status
if ($LASTEXITCODE -ne 0) { throw 'Cua status failed.' }
'Local key enrollment (does not decrypt):'
Test-Path -LiteralPath (Join-Path $PSScriptRoot 'secrets\computeruse_1.xml')
'Monitor:'
try { (Invoke-WebRequest 'http://127.0.0.1:8769/' -UseBasicParsing -TimeoutSec 3).StatusCode }
catch { 'Not reachable; start Harness.ps1 monitor if needed.' }
'PASS: catalog, search and Cua checks finished. This does not test API authentication or an actual UI task.'
