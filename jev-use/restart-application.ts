import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listProcesses } from './terminal-sessions.js';

const base = () => join(process.env.LOCALAPPDATA!, 'Nexus', 'restarts');
const validId = (id: string) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id);
const ps = (script: string) => new Promise<string>((resolve, reject) => {
  const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  execFile(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 },
    (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout));
});

export async function restartApplication(args: { pid: number; expected_name: string; expected_start_time: string; confirm: boolean; quit_via_ctrl_q?: boolean }) {
  if (!Number.isSafeInteger(args.pid) || args.pid < 1 || args.confirm !== true ||
      !/^[\w .-]{1,100}$/.test(args.expected_name) || !/^\d{1,20}$/.test(args.expected_start_time))
    throw new Error('Provide the exact observed PID, name, start identity, and confirm=true');
  if (args.quit_via_ctrl_q !== undefined && typeof args.quit_via_ctrl_q !== 'boolean')
    throw new Error('quit_via_ctrl_q must be a boolean');
  const found = (await listProcesses({ pid: args.pid, limit: 1 })).processes[0];
  if (!found || found.name.toLowerCase() !== args.expected_name.toLowerCase() || found.start_identity !== args.expected_start_time)
    throw new Error('Process identity mismatch; refresh the process list');
  const id = randomUUID();
  await mkdir(base(), { recursive: true });
  await writeFile(join(base(), id + '.json'), JSON.stringify({ ...args, id, state: 'preparing', updated_at: Date.now() }), { flag: 'wx' });
  const script = join(import.meta.dirname, 'restart-supervisor.ps1').replace(/'/g, "''");
  const task = 'Nexus-Restart-' + id;
  try {
    await ps(`$ErrorActionPreference='Stop'; $a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}" -Id ${id}'; $p=New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive -RunLevel Limited; Register-ScheduledTask -TaskName '${task}' -Action $a -Principal $p | Out-Null; Start-ScheduledTask -TaskName '${task}'`);
  } catch (error) {
    await ps(`Unregister-ScheduledTask -TaskName '${task}' -Confirm:$false -ErrorAction SilentlyContinue`).catch(() => {});
    await writeFile(join(base(), id + '.json'), JSON.stringify({ ...args, id, state: 'failed', error: String(error) }));
    throw error;
  }
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const result = await restartStatus(id);
    if (result.state === 'ready') {
      await writeFile(join(base(), id + '.commit'), '', { flag: 'wx' });
      return result;
    }
    if (result.state === 'failed') throw new Error(String(result.error));
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  await ps(`Stop-ScheduledTask -TaskName '${task}' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName '${task}' -Confirm:$false -ErrorAction SilentlyContinue`);
  const failed = { ...args, id, state: 'failed', error: 'Restart supervisor did not become ready; the scheduled task was stopped.' };
  await writeFile(join(base(), id + '.json'), JSON.stringify(failed));
  throw new Error(failed.error + ' Restart id: ' + id);
}

export async function restartStatus(id: string): Promise<Record<string, unknown>> {
  if (!validId(id)) throw new Error('Invalid restart id');
  const state = JSON.parse(await readFile(join(base(), id + '.json'), 'utf8'));
  if (['preparing', 'ready', 'close_requested', 'exited'].includes(state.state) && Date.now() - state.updated_at > 120000)
    return { ...state, state: 'unknown', error: 'The supervisor has not reported a result; inspect the application before retrying.' };
  return state;
}
