import { execFile } from 'node:child_process';
import { join } from 'node:path';

// Runs Update-Nexus.ps1 shortly after the monitor starts and every ten minutes. The script does nothing unless this is an
// installed copy, a newer release exists, and the machine is quiet, so a check costs one small request.
export function startAutoUpdate(root, { log = () => {}, firstMs = 60_000, everyMs = 600_000 } = {}) {
  if (process.platform !== 'win32') return () => {};
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'Update-Nexus.ps1')],
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
