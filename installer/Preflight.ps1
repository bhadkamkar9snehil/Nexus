param([Parameter(Mandatory=$true)][string]$InstallDir, [Parameter(Mandatory=$true)][string]$ResultFile)
$ErrorActionPreference = 'Stop'
try {
    $target = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
    $takeover = Join-Path $PSScriptRoot 'Nexus-Takeover.ps1'
    if (-not (Test-Path -LiteralPath $takeover)) { throw 'Nexus takeover helper is missing. Download the installer again.' }

    $message = ''
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        # Capture a child PowerShell failure without suppressing its diagnostic.
        $previous = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $output = @(& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $takeover -TargetDir $target 2>&1)
            $exitCode = $LASTEXITCODE
        } finally { $ErrorActionPreference = $previous }
        if ($exitCode -eq 0) { exit 0 }

        $message = (($output | ForEach-Object { [string]$_ }) -join ' ').Trim()
        if (-not $message) { $message = 'The previous Nexus monitor could not stop.' }
        if ($attempt -lt 2) { Start-Sleep -Milliseconds 750 }
    }

    throw ('Nexus could not transfer its previous monitor after two attempts. ' +
        $message + ' Options: close Nexus desktop windows and retry; ' +
        'if a different Windows user owns the task, sign in as that user; ' +
        'if another application uses port 8769, close that application; ' +
        'then click Back and Next to retry. Existing installation files remain intact.')
} catch {
    [IO.File]::WriteAllText($ResultFile, $_.Exception.Message, (New-Object Text.UTF8Encoding($false)))
    exit 1
}
