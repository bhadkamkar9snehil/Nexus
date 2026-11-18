$ErrorActionPreference = 'Stop'
$config = Join-Path $PSScriptRoot 'jev-browse\.env'
if (Test-Path -LiteralPath $config) {
    throw 'jev-browse\.env already exists. Existing text model settings were not changed; see the Nexus README.'
}
$command = Get-Command ollama.exe -ErrorAction SilentlyContinue
$ollama = if ($command) { $command.Source } else { $null }
if (-not $ollama) {
    $path = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
    if (Test-Path -LiteralPath $path) { $ollama = $path }
}
if (-not $ollama) { throw 'Install and start Ollama first: https://ollama.com/download/windows' }
Write-Host 'Downloading the local text model (approximately 1 GB). This can take several minutes.'
& $ollama pull 'qwen2.5:1.5b'
if ($LASTEXITCODE -ne 0) { throw 'The local model download failed. Start Ollama and try again.' }
$settings = @(
    'TEXT_MODEL_API_KEY=ollama'
    'TEXT_MODEL_BASE_URL=http://127.0.0.1:11434/v1'
    'TEXT_MODEL=qwen2.5:1.5b'
    'TEXT_MODEL_OMIT_REASONING=1'
)
try {
    $stream = [IO.File]::Open($config, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $writer = New-Object IO.StreamWriter($stream, (New-Object Text.UTF8Encoding $false))
    try { foreach ($line in $settings) { $writer.WriteLine($line) } } finally { $writer.Dispose() }
} catch { throw 'The local model was downloaded, but settings could not be saved. Check jev-browse\.env before retrying.' }
Write-Host 'Local browser text model configured. Keep Ollama running while using browser text tasks.'
