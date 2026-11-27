// What the live agent sessions on this computer are doing, so the unattended responder can answer for them.
// One file per session (hooks of parallel sessions never overwrite each other). `topic` is the last prompt and stays
// among the owner's computers; `claim` is the line a session publishes on purpose and may be shared with teammates.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const ACTIVE_MS = 12 * 3600_000;
const folder = (root) => join(process.env.NEXUS_HOOK_STATE || process.env.NEXUS_PEERS_DIR || join(root, 'secrets'), 'sessions');
const file = (root, id) => join(folder(root), String(id).replace(/[^\w-]/g, '_').slice(0, 80) + '.json');
export const clip = (text, n) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export async function readSession(root, id) {
  try { return JSON.parse(await readFile(file(root, id), 'utf8')); } catch { return null; }
}

export async function saveSession(root, id, change) {
  const session = { ...await readSession(root, id), ...change, id, at: Date.now() };
  await mkdir(folder(root), { recursive: true });
  await writeFile(file(root, id), JSON.stringify(session));
  return session;
}

/** One line per recently active session, as much of it as this audience may see. */
export async function describeSessions(root, own) {
  const names = await readdir(folder(root)).catch(() => []);
  const all = await Promise.all(names.map(async n => { try { return JSON.parse(await readFile(join(folder(root), n), 'utf8')); } catch { return null; } }));
  return all.filter(s => s && Date.now() - s.at < ACTIVE_MS && (own || s.claim)).sort((a, b) => b.at - a.at).slice(0, 15).map(s => {
    const parts = [`last active ${new Date(s.at).toISOString()}`, own && s.cwd ? `folder ${basename(s.cwd)}` : '', s.claim ? `working on: ${s.claim}` : '', own && s.topic ? `last request: ${s.topic}` : ''];
    return '- ' + parts.filter(Boolean).join('; ');
  }).join('\n');
}
