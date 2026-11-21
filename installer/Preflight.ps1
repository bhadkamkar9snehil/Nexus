param([Parameter(Mandatory=$true)][string]$InstallDir, [Parameter(Mandatory=$true)][string]$ResultFile)
$ErrorActionPreference = 'Stop'
try {
    $target = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
    $takeover = Join-Path $PSScriptRoot 'Nexus-Takeover.ps1'
    if (-not (Test-Path -LiteralPath $takeover)) { throw 'Nexus monitor takeover helper is missing from setup.' }
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $takeover -TargetDir $target
    if ($LASTEXITCODE -ne 0) { throw 'Nexus monitor takeover failed. No files were replaced.' }
    exit 0
} catch {
    [IO.File]::WriteAllText($ResultFile, $_.Exception.Message, (New-Object Text.UTF8Encoding($false)))
    exit 1
}
