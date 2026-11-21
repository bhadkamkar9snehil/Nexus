# Automatic update with the least disruption. The monitor runs this every few minutes on an installed copy:
#   1. find a newer release on GitLab and download it in the background (verified against its published SHA-256);
#   2. install only in a quiet moment: no tool call running, no keyboard or mouse use for five minutes, no installer already running;
#   3. install silently through a one-off task in the user's session, so it outlives the monitor the installer closes.
# Turn it off with the Install updates automatically switch on the Updates page (updates.json, autoUpdate=false).
# -DryRun reports the decision without downloading or installing; the -Releases/-Installed/-Idle/-Runs overrides make that testable.
param([switch]$Install, [string]$File, [string]$Version, [switch]$DryRun, [string]$ReleasesJson, [string]$InstalledVersion, [int]$IdleSeconds = -1, [string]$RunsJson)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$folder = Join-Path $env:LOCALAPPDATA 'Nexus'
New-Item -ItemType Directory -Path $folder -Force | Out-Null
$log = Join-Path $folder 'auto-update.log'
function Write-Log([string]$message) { Add-Content -LiteralPath $log -Value ('{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $message) }
function Done([string]$action, [string]$reason, $extra = @{}) { if ($DryRun) { (@{ action = $action; reason = $reason } + $extra) | ConvertTo-Json -Compress }; exit 0 }

if ($Install) {
    $task = 'Nexus-AutoUpdate-Install'
    try {
        Write-Log "Installing $Version"
        $p = Start-Process -FilePath $File -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', '/RESTARTAPPLICATIONS' -Wait -PassThru
        Write-Log "Installer finished with exit code $($p.ExitCode)"
    } finally { Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue }
    exit 0
}

# Only an installer-managed copy updates itself; a source checkout is updated with git.
$key = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{E41F1F1C-57B8-49BB-B11D-79DC2A9A0622}_is1' -ErrorAction SilentlyContinue
$installed = if ($InstalledVersion) { $InstalledVersion } elseif ($key) { $key.DisplayVersion } else { $null }
if (-not $installed) { Done 'none' 'not installed from an installer' }
if (-not $InstalledVersion -and $key.InstallLocation.TrimEnd('\') -ne $PSScriptRoot.TrimEnd('\')) { Done 'none' 'this copy is not the installed one' }
$state = try { Get-Content -LiteralPath (Join-Path $folder 'updates.json') -Raw | ConvertFrom-Json } catch { $null }
if ($state -and $state.autoUpdate -eq $false) { Done 'none' 'automatic updates are switched off' }

# The newest release that has an installer and a published checksum.
$hosts = 'http://100.110.236.122:8080', 'http://10.2.6.112:8080'
$tokenFile = Join-Path $folder 'gitlab-token.bin'
$token = try { Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($tokenFile), $null, 'CurrentUser')) } catch { $null }
$headers = if ($token) { @{ 'PRIVATE-TOKEN' = $token } } else { @{} }
$releases = $null
if ($ReleasesJson) { $releases = Get-Content -LiteralPath $ReleasesJson -Raw | ConvertFrom-Json }
else {
    foreach ($h in $hosts) {
        try { $releases = Invoke-RestMethod "$h/api/v4/projects/ssm%2Fshared-computer-use/releases?per_page=10" -Headers $headers -TimeoutSec 6; break } catch { }
    }
}
if (-not $releases) { Done 'none' 'GitLab is not reachable or no access token is saved' }
$latest = $null
foreach ($r in $releases) {
    $link = @($r.assets.links) | Where-Object { $_.name -like 'Nexus-Harness-Setup-*.exe' } | Select-Object -First 1
    if (-not $link) { continue }
    $sha = [regex]::Match([string]$r.description, [regex]::Escape($link.name) + ': SHA256 ([0-9a-fA-F]{64})').Groups[1].Value
    if ($sha) { $latest = [pscustomobject]@{ Tag = $r.tag_name; Name = $link.name; Path = ([uri]$link.url).PathAndQuery; Sha = $sha.ToLower() }; break }
}
if (-not $latest) { Done 'none' 'no release with an installer and a checksum' }
if ([version]$latest.Tag.TrimStart('v') -le [version]$installed) { Done 'none' "already on $installed" }

# Download in the background while the machine is in use; nothing is installed yet.
$staged = Join-Path $folder ('staged\' + $latest.Name)
if (-not $DryRun) {
    New-Item -ItemType Directory -Path (Split-Path $staged) -Force | Out-Null
    if (-not ((Test-Path $staged) -and (Get-FileHash $staged -Algorithm SHA256).Hash.ToLower() -eq $latest.Sha)) {
        $ok = $false
        foreach ($h in $hosts) {
            $arguments = @('-sS', '-f', '--max-time', '900', '-o', $staged) + $(if ($token) { '-H', "PRIVATE-TOKEN: $token" }) + ($h + $latest.Path)
            & curl.exe @arguments 2>$null
            if ($LASTEXITCODE -eq 0) { $ok = $true; break }
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
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'Nexus-AutoUpdate-Install' -Action $action -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'Nexus-AutoUpdate-Install'
Write-Log "Starting the update from $installed to $($latest.Tag)"
