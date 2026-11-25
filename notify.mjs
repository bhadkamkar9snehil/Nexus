// Use the installed Nexus notification identity even when the desktop window is closed.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('./Nexus.Desktop.exe', import.meta.url));

export function notify(title, body, view = 'updates') {
  if (process.platform !== 'win32' || process.env.NEXUS_NOTIFY === '0' || !existsSync(desktop)) return;
  const child = spawn(desktop, ['--notify'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  child.on('error', () => console.error('Could not start the Nexus notification host.'));
  child.on('exit', code => { if (code) console.error('Windows did not accept the Nexus notification.'); });
  child.stdin.on('error', () => {}); // The notification host can exit before the pipe is written.
  child.stdin.end(JSON.stringify({ title: String(title ?? ''), body: String(body ?? ''), view }));
}
