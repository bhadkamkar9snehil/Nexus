import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// One desktop task at a time across every Nexus MCP process (Codex, Claude, CLI). The holder refreshes the lock
// file's timestamp every 2 s; a lock not refreshed for 10 s belongs to a crashed holder and is taken over.
const STALE_MS = 10000;
const folder = () => process.env.NEXUS_LOCK_DIR ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Nexus', 'locks');

export async function withDesktopLock<T>(owner: string, run: () => Promise<T>): Promise<T> {
  const file = join(folder(), 'desktop.lock');
  await mkdir(folder(), { recursive: true });
  const mine = JSON.stringify({ owner, pid: process.pid, since: Date.now() });
  for (let attempt = 0; ; attempt++) {
    try { await writeFile(file, mine, { flag: 'wx' }); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const age = Date.now() - await stat(file).then(s => s.mtimeMs, () => 0);
      if (age > STALE_MS && attempt < 3) { await rm(file, { force: true }); continue; }
      const holder = JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as { owner?: string; since?: number };
      throw new Error(`Desktop is in use by another agent (${holder.owner ?? 'unknown tool'}, ${holder.since ? Math.round((Date.now() - holder.since) / 1000) + ' s' : 'unknown time'}); try again when it finishes`);
    }
  }
  const beat = setInterval(() => { const now = new Date(); utimes(file, now, now).catch(() => {}); }, 2000);
  try { return await run(); } finally {
    clearInterval(beat);
    // Only remove a lock that is still ours.
    if ((await readFile(file, 'utf8').catch(() => '')) === mine) await rm(file, { force: true });
  }
}
