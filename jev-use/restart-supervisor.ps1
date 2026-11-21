param([Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F-]{36}$')][string]$Id)
$ErrorActionPreference = 'Stop'
$path = Join-Path $env:LOCALAPPDATA "Nexus\restarts\$Id.json"
$task = "Nexus-Restart-$Id"
$state = $null
function Save-State {
    $state | Add-Member -NotePropertyName updated_at -NotePropertyValue ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) -Force
    $temp = "$path.tmp"
    [IO.File]::WriteAllText($temp, ($state | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temp -Destination $path -Force
}
try {
    $state = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $target = Get-Process -Id $state.pid -ErrorAction Stop
    if ($target.ProcessName -ine $state.expected_name -or $target.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $state.expected_start_time) { throw 'Process identity changed.' }
    $exe = $target.Path
    if (-not $exe -or -not $target.MainWindowHandle) { throw 'Target must have an accessible executable and a main window.' }
    # The relaunch gets the original command-line arguments back (the working directory is not recorded by Windows).
    $line = [string](Get-CimInstance Win32_Process -Filter "ProcessId=$($target.Id)").CommandLine
    $arguments = if ($line -match '^\s*"[^"]*"\s*(.*)$') { $Matches[1] } elseif ($line -match '^\s*\S+\s*(.*)$') { $Matches[1] } else { '' }
    $state.state = 'ready'; Save-State
    $commit = Join-Path $env:LOCALAPPDATA "Nexus\restarts\$Id.commit"
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while (-not (Test-Path -LiteralPath $commit) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
    if (-not (Test-Path -LiteralPath $commit)) { throw 'The restart handoff was not confirmed.' }
    Remove-Item -LiteralPath $commit -Force
    Start-Sleep -Seconds 10
    $target = Get-Process -Id $state.pid -ErrorAction Stop
    if ($target.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $state.expected_start_time) { throw 'Process identity changed before closing.' }
    if ($state.quit_via_ctrl_q) {
        $driver = Join-Path (Split-Path $PSScriptRoot -Parent) 'runtime\cua-driver.exe'
        if (-not (Test-Path -LiteralPath $driver)) { $driver = Join-Path $env:LOCALAPPDATA 'Programs\Cua\cua-driver\bin\cua-driver.exe' }
        if (-not (Test-Path -LiteralPath $driver)) { throw 'Cua Driver is unavailable for the requested quit shortcut.' }
        $request = @{ pid = $target.Id; window_id = [long]$target.MainWindowHandle; keys = @('ctrl','q'); session = "nexus-restart-$Id" }
        $result = ($request | ConvertTo-Json -Compress) | & $driver call hotkey
        $response = ($result -join "`n") | ConvertFrom-Json
        if ($response.effect -eq 'unverifiable') { $null = $target.WaitForExit(3000) }
        if (-not $target.HasExited -and ($response.code -eq 'background_unavailable' -or $response.effect -eq 'unverifiable')) {
            $request.delivery_mode = 'foreground'
            $result = ($request | ConvertTo-Json -Compress) | & $driver call hotkey
        }
        if ($LASTEXITCODE -ne 0 -and -not $target.HasExited) { throw "Quit shortcut failed: $result" }
    } elseif (-not $target.CloseMainWindow()) { throw 'The application refused the graceful close request.' }
    $state.state = 'close_requested'; Save-State
    if (-not $target.WaitForExit(30000)) { throw 'The application did not exit after the graceful close request.' }
    $state.state = 'exited'; Save-State
    $new = if ($arguments) { Start-Process -FilePath $exe -ArgumentList $arguments -PassThru } else { Start-Process -FilePath $exe -PassThru }
    $state | Add-Member -NotePropertyName arguments_restored -NotePropertyValue ([bool]$arguments) -Force
    $state | Add-Member -NotePropertyName new_pid -NotePropertyValue $new.Id -Force
    Start-Sleep -Seconds 3
    if ($new.HasExited) { throw 'The relaunched process exited before it could be verified.' }
    $state.state = 'restarted'; Save-State
} catch {
    if ($state) { $state.state = 'failed'; $state | Add-Member -NotePropertyName error -NotePropertyValue $_.Exception.Message -Force; Save-State }
} finally {
    Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
}
