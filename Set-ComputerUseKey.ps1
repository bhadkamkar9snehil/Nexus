param([ValidatePattern('^[a-zA-Z0-9_-]{1,40}$')][string]$Alias = 'computeruse_1')
$ErrorActionPreference = 'Stop'
$folder = Join-Path $PSScriptRoot 'secrets'
New-Item -ItemType Directory -Force -Path $folder | Out-Null
$key = Read-Host "Paste the $Alias TypeSafe key" -AsSecureString
if ($key.Length -eq 0) { throw 'Empty key' }
$target = Join-Path $folder "$Alias.xml"
$temp = Join-Path $folder ([guid]::NewGuid().ToString() + '.xml')
try {
    $key | Export-Clixml -LiteralPath $temp
    if (Test-Path -LiteralPath $target) {
        [IO.File]::Replace($temp, $target, $null)
    } else {
        [IO.File]::Move($temp, $target)
    }
    "Saved $Alias for this Windows account."
} finally {
    $key.Dispose()
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp }
}
