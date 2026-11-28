import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Runs the native auto-updater (or Update-Nexus.ps1 in source checkouts) shortly after the monitor starts and every ten minutes.
export function startAutoUpdate(root, { log = () => {}, firstMs = 60_000, everyMs = 600_000 } = {}) {
  if (process.platform !== 'win32') return () => {};
  const nativeUpdater = join(root, 'Nexus.Setup.exe');
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    const useNative = existsSync(nativeUpdater);
    const exe = useNative ? nativeUpdater : powershell;
    const args = useNative ? ['auto-update'] : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'Update-Nexus.ps1')];
    execFile(exe, args,
      { windowsHide: true, timeout: 20 * 60_000 }, (error, _out, stderr) => {
        running = false;
        if (error) log('Automatic update check failed: ' + (stderr.trim() || error.message));
      });
  };
  const first = setTimeout(run, firstMs);
  const every = setInterval(run, everyMs);
  first.unref();
  every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}
