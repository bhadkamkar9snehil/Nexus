# Automatic update with the least disruption. The monitor runs this every few minutes on an installed copy:
#   1. find the public GitHub release (or trusted GitLab fallback) and verify the published SHA-256;
#   2. install only in a quiet moment: no tool call running, no keyboard or mouse use for five minutes, no installer already running;
#   3. install silently through a one-off task in the user's session, so it outlives the monitor the installer closes.
# Turn it off with the Install updates automatically switch on the Updates page (updates.json, autoUpdate=false).
# -DryRun reports the decision without downloading or installing; the -Releases/-Installed/-Idle/-Runs overrides make that testable.
param([switch]$Install, [string]$File, [string]$Version, [switch]$DryRun, [string]$ReleasesJson, [string]$InstalledVersion, [int]$IdleSeconds = -1, [string]$RunsJson, [switch]$FunctionsOnly, [switch]$NoRecovery)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$folder = Join-Path $env:LOCALAPPDATA 'Nexus'
New-Item -ItemType Directory -Path $folder -Force | Out-Null
$log = Join-Path $folder 'auto-update.log'
function Write-Log([string]$message) { Add-Content -LiteralPath $log -Value ('{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $message) }
function Done([string]$action, [string]$reason, $extra = @{}) { if ($DryRun) { (@{ action = $action; reason = $reason } + $extra) | ConvertTo-Json -Compress }; exit 0 }
function Invoke-NexusCurl([string[]]$Arguments) {
    # On Windows PowerShell, curl.exe stderr can become a terminating NativeCommandError
    # when ErrorActionPreference=Stop. A failed host must not skip the next source.
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & curl.exe @Arguments 2>$null
        return $LASTEXITCODE -eq 0
    } catch { return $false }
    finally { $ErrorActionPreference = $previous }
}
function Test-NexusMonitorHealthy([string]$InstallRoot) {
    if (-not $InstallRoot -or -not [IO.Path]::IsPathRooted($InstallRoot)) { return $false }
    $root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try {
            $task = Get-ScheduledTask -TaskName 'SharedHarness-Monitor' -ErrorAction SilentlyContinue
            $health = Invoke-RestMethod 'http://127.0.0.1:8769/monitor-status' -TimeoutSec 2
            if ($task -and $task.State -eq 'Running' -and
                $health.application -eq 'shared-computer-use-monitor' -and $health.managed -eq $true -and
                [IO.Path]::IsPathRooted([string]$health.root) -and
                [IO.Path]::GetFullPath([string]$health.root).TrimEnd('\') -ieq $root) {
                return $true
            }
        } catch { }
        if ($attempt -lt 9) { Start-Sleep -Seconds 2 }
    }
    return $false
}
function Save-NexusInstallReceipt([string]$TargetVersion, [int]$ExitCode, [bool]$MonitorReady, [string]$InstallerLog, [int]$InstallerExitCode = -1, [string]$RecoveryStatus = 'not-required', [string]$RecoverySnapshot = '', [string]$PreviousVersion = '', [string]$RecoveryError = '') {
    $receipt = @{
        version = $TargetVersion
        recordedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
        exitCode = $ExitCode
        installerExitCode = $InstallerExitCode
        monitorVerified = $MonitorReady
        installerLog = $InstallerLog
        recovery = @{
            status = $RecoveryStatus
            snapshot = $RecoverySnapshot
            previousVersion = $PreviousVersion
            error = $RecoveryError
        }
    }
    $receiptFile = Join-Path $folder 'last-install-receipt.json'
    $tempFile = $receiptFile + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($tempFile, ($receipt | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $tempFile -Destination $receiptFile -Force
    } catch {
        Write-Log ('Could not save installer receipt: ' + $_.Exception.GetType().Name)
    } finally { Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue }
}
if ($FunctionsOnly) { return }

if ($Install) {
    $task = 'Nexus-AutoUpdate-Install'
    $resultCode = 1
    $installerExitCode = -1
    $monitorReady = $false
    $recoveryStatus = 'not-required'
    $recoveryError = ''
    $recoverySnapshot = ''
    $previousVersion = ''
    $previousRoot = ''
    $safeVersion = if ($Version -match '^v?\d+\.\d+\.\d+$') { $Version.TrimStart('v') } else { 'unknown' }
    $installerLog = Join-Path $folder ('installer-{0}-{1}.log' -f $safeVersion, (Get-Date -Format 'yyyyMMdd-HHmmss'))
    try {
        if (-not $File -or -not (Test-Path -LiteralPath $File -PathType Leaf)) {
            throw 'The staged Nexus installer is missing.'
        }
        if ($safeVersion -eq 'unknown') { throw 'Invalid target Nexus version.' }
        if (-not $NoRecovery) {
            $previous = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{E41F1F1C-57B8-49BB-B11D-79DC2A9A0622}_is1' -ErrorAction SilentlyContinue
            $previousVersion = [string]$previous.DisplayVersion
            $previousRoot = [string]$previous.InstallLocation
            if (-not $previousVersion -or -not [IO.Path]::IsPathRooted($previousRoot) -or
                [IO.Path]::GetFullPath($previousRoot).TrimEnd('\') -ine [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')) {
                throw 'Cannot verify the current Nexus installation. No update was started.'
            }
            if (-not (Test-NexusMonitorHealthy -InstallRoot $previousRoot)) {
                throw 'The existing managed Nexus monitor is not healthy. Repair the current version before updating.'
            }
            $recoveryScript = Join-Path $folder 'Installer-Recovery.ps1'
            $takeoverScript = Join-Path $folder 'Nexus-Takeover-Recovery.ps1'
            Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Installer-Recovery.ps1') -Destination $recoveryScript -Force
            Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Nexus-Takeover.ps1') -Destination $takeoverScript -Force
            . $recoveryScript -FunctionsOnly
            $recoverySnapshot = New-NexusRecoverySnapshot -installRoot $previousRoot -version $previousVersion -store (Join-Path $folder 'installer-recovery')
            $recoveryStatus = 'snapshot-ready'
            Write-Log "Verified rollback snapshot for $previousVersion at $recoverySnapshot"
        } else {
            $recoveryStatus = 'disabled'
            Write-Log 'Installer rollback disabled by explicit command-line option.'
        }
        Write-Log "Installing $Version; installer diagnostic log: $installerLog"
        $arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', '/RESTARTAPPLICATIONS', ('/LOG="' + $installerLog + '"'))
        $installer = Start-Process -FilePath $File -ArgumentList $arguments -Wait -PassThru
        $installerExitCode = [int]$installer.ExitCode
        $resultCode = $installerExitCode
        Write-Log "Installer finished with exit code $resultCode; log: $installerLog"
        if ($resultCode -eq 0) {
            $uninstall = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{E41F1F1C-57B8-49BB-B11D-79DC2A9A0622}_is1' -ErrorAction SilentlyContinue
            $registeredVersion = [string]$uninstall.DisplayVersion
            if ($registeredVersion -ne $safeVersion) {
                Write-Log "Installer exited successfully, but installed version was not verified (registered: $registeredVersion)"
                $resultCode = 1
            } else {
                $monitorReady = Test-NexusMonitorHealthy -InstallRoot ([string]$uninstall.InstallLocation)
                if (-not $monitorReady) {
                    Write-Log 'Installed version matches, but the managed Nexus monitor or its scheduled task is not healthy.'
                    $resultCode = 1
                } else {
                    Write-Log "Installed Nexus version and running managed monitor verified: $registeredVersion"
                }
            }
        }
    } catch {
        Write-Log ('Installer execution failed: ' + $_.Exception.Message)
        $resultCode = 1
    } finally {
        if ($recoverySnapshot -and $resultCode -eq 0) {
            $recoveryStatus = 'previous-version-saved'
            try {
                $pruned = Remove-NexusOldRecoverySnapshots -store (Join-Path $folder 'installer-recovery') -keep 2
                if ($pruned -gt 0) { Write-Log "Removed $pruned old unprotected recovery snapshot(s)." }
            } catch { Write-Log ('Recovery retention cleanup failed: ' + $_.Exception.Message) }
        }
        if ($resultCode -eq 0) {
            try {
                $stagedDir = Join-Path $folder 'staged'
                if ($File -and (Test-Path -LiteralPath $File) -and [IO.Path]::GetFullPath((Split-Path -Parent $File)).TrimEnd('\') -ieq [IO.Path]::GetFullPath($stagedDir).TrimEnd('\')) {
                    Remove-Item -LiteralPath $File -Force -ErrorAction SilentlyContinue
                }
                Get-ChildItem -LiteralPath $folder -Filter 'installer-*.log' -File -ErrorAction SilentlyContinue |
                    Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip 5 |
                    Remove-Item -Force -ErrorAction SilentlyContinue
                Get-ChildItem -LiteralPath (Join-Path $folder 'backups') -Directory -ErrorAction SilentlyContinue |
                    Sort-Object Name -Descending | Select-Object -Skip 5 |
                    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
            } catch { }
        } elseif ($recoverySnapshot -and $resultCode -ne 0) {
            try {
                $after = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{E41F1F1C-57B8-49BB-B11D-79DC2A9A0622}_is1' -ErrorAction SilentlyContinue
                if ([string]$after.DisplayVersion -eq $previousVersion -and
                    (Test-NexusMonitorHealthy -InstallRoot $previousRoot)) {
                    $recoveryStatus = 'previous-version-running'
                    Write-Log "Previous Nexus $previousVersion is still healthy; no file restore needed."
                } else {
                    $recoveryStatus = 'restore-started'
                    Write-Log "Restoring Nexus $previousVersion from $recoverySnapshot"
                    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $folder 'Nexus-Takeover-Recovery.ps1') -TargetDir $previousRoot
                    if ($LASTEXITCODE -ne 0) { throw 'Could not safely stop the failed Nexus installation for rollback.' }
                    $restored = Restore-NexusRecoveryFiles -snapshot $recoverySnapshot -installRoot $previousRoot
                    if ($restored -ne $previousVersion) { throw 'Recovery restored an unexpected version.' }
                    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $previousRoot 'Setup.ps1') -NoBrowserAtSignIn
                    if ($LASTEXITCODE -ne 0) { throw 'Previous Nexus setup failed after file restoration.' }
                    $registry = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{E41F1F1C-57B8-49BB-B11D-79DC2A9A0622}_is1' -ErrorAction SilentlyContinue
                    if ([string]$registry.DisplayVersion -ne $previousVersion -or
                        -not (Test-NexusMonitorHealthy -InstallRoot $previousRoot)) {
                        throw 'Previous Nexus version or monitor could not be verified after rollback.'
                    }
                    $recoveryStatus = 'restored-and-verified'
                    Write-Log "Restored and verified previous Nexus $previousVersion."
                }
            } catch {
                $recoveryStatus = 'restore-failed'
                $recoveryError = $_.Exception.Message
                try { Protect-NexusRecoverySnapshot -snapshot $recoverySnapshot }
                catch { Write-Log ('Could not mark failed recovery snapshot as protected: ' + $_.Exception.Message) }
                Write-Log "Nexus rollback failed: $recoveryError. Recovery snapshot retained at $recoverySnapshot"
            }
        } elseif (-not $NoRecovery -and $resultCode -ne 0) {
            $recoveryStatus = 'snapshot-unavailable'
        }
        Save-NexusInstallReceipt -TargetVersion $Version -ExitCode $resultCode -MonitorReady $monitorReady -InstallerLog $installerLog -InstallerExitCode $installerExitCode -RecoveryStatus $recoveryStatus -RecoverySnapshot $recoverySnapshot -PreviousVersion $previousVersion -RecoveryError $recoveryError
        Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
    }
    exit $resultCode
}

# Only an installer-managed copy updates itself; a source checkout is updated with git.
$key = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{E41F1F1C-57B8-49BB-B11D-79DC2A9A0622}_is1' -ErrorAction SilentlyContinue
$installed = if ($InstalledVersion) { $InstalledVersion } elseif ($key) { $key.DisplayVersion } else { $null }
if (-not $installed) { Done 'none' 'not installed from an installer' }
if (-not $InstalledVersion -and $key.InstallLocation.TrimEnd('\') -ne $PSScriptRoot.TrimEnd('\')) { Done 'none' 'this copy is not the installed one' }
$state = try { Get-Content -LiteralPath (Join-Path $folder 'updates.json') -Raw | ConvertFrom-Json } catch { $null }
if ($state -and $state.autoUpdate -eq $false) { Done 'none' 'automatic updates are switched off' }

# The newest release that has an installer and a published checksum across GitHub and GitLab (LAN + Tailscale) in parallel.
$hosts = 'http://10.2.6.112:8080', 'http://100.110.236.122:8080'
$tokenFile = Join-Path $folder 'gitlab-token.bin'
$token = try { Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($tokenFile), $null, 'CurrentUser')) } catch { $null }
$githubApi = 'https://api.github.com/repos/bhadkamkar9snehil/Nexus/releases?per_page=10'
$releases = @()
if ($ReleasesJson) {
    $parsed = Get-Content -LiteralPath $ReleasesJson -Raw | ConvertFrom-Json
    $releases = @($parsed)
} else {
    Add-Type -AssemblyName System.Net.Http
    $http = [System.Net.Http.HttpClient]::new()
    $http.Timeout = [TimeSpan]::FromSeconds(6)
    try {
        $reqGh = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $githubApi)
        [void]$reqGh.Headers.TryAddWithoutValidation('User-Agent', 'Nexus-Harness-Updater')
        [void]$reqGh.Headers.TryAddWithoutValidation('Accept', 'application/vnd.github+json')
        $taskGh = $http.SendAsync($reqGh)

        $glTasks = @()
        foreach ($h in $hosts) {
            $reqGl = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, "$h/api/v4/projects/ssm%2Fshared-computer-use/releases?per_page=10")
            if ($token) { [void]$reqGl.Headers.TryAddWithoutValidation('PRIVATE-TOKEN', $token) }
            $glTasks += $http.SendAsync($reqGl)
        }

        $allTasks = @($taskGh) + $glTasks
        try { [void][System.Threading.Tasks.Task]::WhenAll([System.Threading.Tasks.Task[]]$allTasks).Wait(7000) } catch { }

        if ($taskGh.Status -eq [System.Threading.Tasks.TaskStatus]::RanToCompletion -and $taskGh.Result.IsSuccessStatusCode) {
            $bodyGh = $taskGh.Result.Content.ReadAsStringAsync().Result
            if ($bodyGh) { $releases += @($bodyGh | ConvertFrom-Json) }
        }
        foreach ($t in $glTasks) {
            if ($t.Status -eq [System.Threading.Tasks.TaskStatus]::RanToCompletion -and $t.Result.IsSuccessStatusCode) {
                $bodyGl = $t.Result.Content.ReadAsStringAsync().Result
                if ($bodyGl) { $releases += @($bodyGl | ConvertFrom-Json); break }
            }
        }
    } finally { $http.Dispose() }
}
if (-not $releases.Count) { Done 'none' 'GitHub and GitLab releases are unreachable' }
$latest = $null
foreach ($r in $releases) {
    $tag = [string]$r.tag_name
    if ($tag -notmatch '^v\d+\.\d+\.\d+$') { continue }
    $filename = 'Nexus-Harness-Setup-' + $tag.Substring(1) + '-windows-x64.exe'
    $notes = if ($r.body) { [string]$r.body } else { [string]$r.description }
    $sha = [regex]::Match($notes, [regex]::Escape($filename) + ': SHA256 ([0-9a-fA-F]{64})').Groups[1].Value.ToLowerInvariant()
    if (-not $sha) { continue }
    $candidate = $null
    $githubAsset = @($r.assets) | Where-Object { $_.name -eq $filename -and $_.browser_download_url } | Select-Object -First 1
    if ($githubAsset) {
        $expected = 'https://github.com/bhadkamkar9snehil/Nexus/releases/download/' + $tag + '/' + $filename
        if ([string]$githubAsset.browser_download_url -ne $expected) { continue }
        $digest = [string]$githubAsset.digest
        if ($digest -and $digest -ne ('sha256:' + $sha)) { continue }
        $candidate = [pscustomobject]@{ Tag=$tag; Name=$filename; Source='github'; Url=$expected; Sha=$sha }
    }
    if (-not $candidate) {
        $gitlabAsset = @($r.assets.links) | Where-Object { $_.name -eq $filename -and $_.url } | Select-Object -First 1
        if ($gitlabAsset) {
            $assetUrl = [uri]$gitlabAsset.url
            if ($hosts -notcontains $assetUrl.GetLeftPart([UriPartial]::Authority)) { continue }
            $candidate = [pscustomobject]@{ Tag=$tag; Name=$filename; Source='gitlab'; Path=$assetUrl.PathAndQuery; Sha=$sha }
        }
    }
    if ($candidate -and (-not $latest -or [version]$candidate.Tag.TrimStart('v') -gt [version]$latest.Tag.TrimStart('v'))) {
        $latest = $candidate
    }
}
if (-not $latest) { Done 'none' 'no release with an installer and a checksum' }
if ([version]$latest.Tag.TrimStart('v') -le [version]$installed) { Done 'none' "already on $installed" }

# Download in the background while the machine is in use; nothing is installed yet.
$staged = Join-Path $folder ('staged\' + $latest.Name)
if (-not $DryRun) {
    $stagedDir = Split-Path $staged
    New-Item -ItemType Directory -Path $stagedDir -Force | Out-Null
    Get-ChildItem -LiteralPath $stagedDir -Filter 'Nexus-Harness-Setup-*.exe' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -ine $staged } |
        Remove-Item -Force -ErrorAction SilentlyContinue
    if (-not ((Test-Path $staged) -and (Get-FileHash $staged -Algorithm SHA256).Hash.ToLower() -eq $latest.Sha)) {
        $ok = $false
        if ($latest.Source -eq 'github' -and $token) {
            # On the office LAN, use the same package without the public CDN transfer.
            $lanAsset = "http://10.2.6.112:8080/api/v4/projects/ssm%2Fshared-computer-use/packages/generic/nexus-harness/$($latest.Tag.Substring(1))/$($latest.Name)"
            $ok = (Invoke-NexusCurl -Arguments @('-fsS', '--connect-timeout', '3', '--max-time', '90', '-o', $staged, '-H', "PRIVATE-TOKEN: $token", $lanAsset)) -and
                (Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash.ToLowerInvariant() -eq $latest.Sha
        }
        if (-not $ok -and $latest.Source -eq 'github') {
            # Never send the private GitLab token to GitHub or its download CDN.
            $ok = Invoke-NexusCurl -Arguments @('-fsSL', '--retry', '2', '--connect-timeout', '8', '--max-time', '900', '--proto', '=https', '--proto-redir', '=https', '-o', $staged, $latest.Url)
        } elseif (-not $ok) {
            foreach ($h in $hosts) {
                $arguments = @('-sS', '-f', '--connect-timeout', '5', '--max-time', '900', '-o', $staged) + $(if ($token) { '-H', "PRIVATE-TOKEN: $token" }) + ($h + $latest.Path)
                if (Invoke-NexusCurl -Arguments $arguments) { $ok = $true; break }
            }
        }
        if ($ok -and (Get-FileHash $staged -Algorithm SHA256).Hash.ToLower() -ne $latest.Sha) { Remove-Item $staged -Force; $ok = $false; Write-Log "Discarded a download that did not match the published checksum for $($latest.Tag)" }
        if (-not $ok) { Done 'none' 'download failed; will retry' }
        Write-Log "Downloaded and verified $($latest.Name)"
    }
}

# Wait for a quiet moment: nothing running, and the owner away from the keyboard.
$runs = if ($RunsJson) { Get-Content -LiteralPath $RunsJson -Raw | ConvertFrom-Json } else { try { Invoke-RestMethod 'http://127.0.0.1:8769/runs' -TimeoutSec 5 } catch { @() } }
$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
if (@($runs | Where-Object { $_.status -eq 'running' -and ($nowMs - [int64]$_.started) -lt 150000 }).Count) { Done 'wait' 'a tool call is running' @{ latest = $latest.Tag } }
$idle = $IdleSeconds
if ($idle -lt 0) {
    Add-Type -Namespace Nexus -Name Input -MemberDefinition '[StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; } [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);'
    $info = New-Object Nexus.Input+LASTINPUTINFO; $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($info)
    $idle = if ([Nexus.Input]::GetLastInputInfo([ref]$info)) { [int](([Environment]::TickCount - [int]$info.dwTime) / 1000) } else { 0 }
}
if ($idle -lt 300) { Done 'wait' "the owner is active (idle ${idle}s)" @{ latest = $latest.Tag } }
if (Get-Process -Name 'Nexus-Harness-Setup*' -ErrorAction SilentlyContinue) { Done 'wait' 'an installer is already running' }
if ($DryRun) { Done 'install' 'quiet moment' @{ latest = $latest.Tag; installed = $installed } }

# Keep the keys and tool assignments so a bad version can be rolled back without re-entering them, then hand over to a one-off task.
$secrets = Join-Path $PSScriptRoot 'secrets'
if (Test-Path $secrets) {
    $backup = Join-Path $folder ('backups\{0:yyyyMMdd-HHmmss}-{1}' -f (Get-Date), $installed)
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    Get-ChildItem $secrets -File | Copy-Item -Destination $backup -Force
}
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Install -File "{1}" -Version {2}' -f $PSCommandPath, $staged, $latest.Tag
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
try {
    $registered = Register-ScheduledTask -TaskName 'Nexus-AutoUpdate-Install' -Action $action -Principal $principal -Force -ErrorAction Stop
    if ($registered.Actions.Count -ne 1 -or $registered.Actions[0].Arguments -ne $arguments) {
        throw 'The scheduled action does not match the verified installer.'
    }
    Start-ScheduledTask -InputObject $registered -ErrorAction Stop
} catch {
    Write-Log ('Could not schedule the verified Nexus update: ' + $_.Exception.Message)
    exit 1
}
Write-Log "Starting the update from $installed to $($latest.Tag)"
