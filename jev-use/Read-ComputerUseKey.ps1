param([ValidatePattern('^[a-zA-Z0-9_-]{1,40}$')][string]$Alias = 'computeruse_1')
$ErrorActionPreference = 'Stop'
$secret = Join-Path $PSScriptRoot "..\secrets\$Alias.xml"
$key = Import-Clixml -LiteralPath $secret
try {
    [Console]::Out.Write([Net.NetworkCredential]::new('', $key).Password)
} finally {
    $key.Dispose()
}
