// Inbound firewall rule for the peer port. When Nexus runs as administrator it creates the rule itself; otherwise it
// only reports the state so the UI can say what to do.
import { execFile } from 'node:child_process';

const port = () => Number(process.env.NEXUS_WEBHOOK_PORT || 8770);
const RULE = 'Nexus peers';

const script = (create) => `
$ErrorActionPreference = 'SilentlyContinue'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$rule = Get-NetFirewallRule -DisplayName 'Nexus*' | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' } | Select-Object -First 1
$created = $false
if (${create ? '$true' : '$false'} -and $admin -and -not $rule) {
  New-NetFirewallRule -DisplayName '${RULE}' -Direction Inbound -Protocol TCP -LocalPort ${port()} -Action Allow -Profile Any | Out-Null
  $created = $true
  $rule = Get-NetFirewallRule -DisplayName '${RULE}'
}
if ($rule) { $rule = [pscustomobject]@{ Enabled = 'True' } }
@{ admin = [bool]$admin; open = [bool]($rule -and $rule.Enabled -eq 'True'); created = $created; port = ${port()} } | ConvertTo-Json -Compress`;

/** Checks the rule; with `create` (and administrator rights) adds it when missing. Resolves {admin, open, created, port}. */
export function firewall({ create = false } = {}) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ admin: false, open: true, created: false, port: port() });
    const encoded = Buffer.from(script(create), 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 15000 }, (error, stdout) => {
      try { resolve(JSON.parse(stdout)); } catch { resolve({ admin: false, open: false, created: false, port: port(), error: error?.message }); }
    });
  });
}
