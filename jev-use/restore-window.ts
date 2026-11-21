import { execFile } from 'node:child_process';
import { join } from 'node:path';

/** Restores a minimized top-level window without activating it, so the owner's foreground work is not interrupted. The cua window_id is the window handle. */
export function restoreWindow(handle: number) {
  if (!Number.isSafeInteger(handle) || handle < 1) throw new Error('Invalid window handle');
  const script = `Add-Type -Namespace Nexus -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr window, int command);'; [Nexus.Win]::ShowWindowAsync([System.IntPtr]${handle}, 4) | Out-Null`;
  const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise<void>((resolve, reject) => execFile(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 },
    (error, _out, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve()));
}
