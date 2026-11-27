// What the live agent sessions on this computer are doing, so the unattended responder can answer for them.
// Discovers active sessions across Nexus hooks, Antigravity, Claude Code, and Codex, and merges them by session ID.
import { existsSync, statSync } from 'node:fs';
import { mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const ACTIVE_MS = 12 * 3600_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_RE = /\b(glpat-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|Bearer\s+[A-Za-z0-9._-]{16,})\b/g;
const folder = (root) => join(process.env.NEXUS_HOOK_STATE || process.env.NEXUS_PEERS_DIR || join(root, 'secrets'), 'sessions');
const file = (root, id) => join(folder(root), String(id).replace(/[^\w-]/g, '_').slice(0, 80) + '.json');

export const clip = (text, n) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
export const scrubSecrets = (text) => String(text ?? '').replace(SECRET_RE, '[REDACTED]');

export async function readSession(root, id) {
  try { return JSON.parse(await readFile(file(root, id), 'utf8')); } catch { return null; }
}

export async function saveSession(root, id, change) {
  const session = { ...await readSession(root, id), ...change, id, at: Date.now() };
  await mkdir(folder(root), { recursive: true });
  await writeFile(file(root, id), JSON.stringify(session));
  return session;
}

async function readHeadAndTail(filePath, headBytes = 12_288, tailBytes = 49_152) {
  let fh;
  try {
    fh = await open(filePath, 'r');
    const { size, mtimeMs } = await fh.stat();
    if (size === 0) return { head: [], tail: [], mtimeMs };
    const headLen = Math.min(size, headBytes);
    const headBuf = Buffer.alloc(headLen);
    await fh.read(headBuf, 0, headLen, 0);
    const head = headBuf.toString('utf8').split(/\r?\n/).filter(Boolean);
    if (size <= headBytes + tailBytes) {
      const fullBuf = Buffer.alloc(size);
      await fh.read(fullBuf, 0, size, 0);
      const lines = fullBuf.toString('utf8').split(/\r?\n/).filter(Boolean);
      return { head: lines, tail: lines, mtimeMs };
    }
    const offset = Math.max(0, size - tailBytes);
    const tailBuf = Buffer.alloc(size - offset);
    await fh.read(tailBuf, 0, tailBuf.length, offset);
    const tail = tailBuf.toString('utf8').split(/\r?\n/).slice(offset ? 1 : 0).filter(Boolean);
    return { head, tail, mtimeMs };
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

function parseJsonLines(lines) {
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch { /* ignore partial line */ }
  }
  return out;
}

function cleanUserText(raw) {
  return String(raw ?? '')
    .replace(/<\/?USER_REQUEST>/gi, '')
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, '')
    .trim();
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c && (c.type === 'text' || c.type === 'input_text' || c.type === 'output_text' || typeof c.text === 'string'))
      .map(c => c.text ?? '')
      .join(' ');
  }
  return '';
}

function inferWorkspaceFromText(text) {
  const matches = String(text ?? '').match(/[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n`']+\\)*[^\\/:*?"<>|\r\n`',;)]+/g) ?? [];
  for (const raw of matches) {
    const cleaned = raw.replace(/[.,;:'")\]`\s]+$/, '');
    if (/\\(\.gemini|Windows|Program Files)\\/i.test(cleaned)) continue;
    if (/\\AppData\\Local\\Temp$/i.test(cleaned)) continue;
    try {
      const st = statSync(cleaned);
      if (st.isDirectory()) return cleaned;
      if (st.isFile()) {
        const parent = join(cleaned, '..');
        if (existsSync(parent)) return parent;
      }
    } catch { /* ignore non-existent paths */ }
  }
  return '';
}

async function discoverAntigravity(brainDir, cutoff) {
  const entries = await readdir(brainDir, { withFileTypes: true }).catch(() => []);
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
    const transcriptPath = join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
    const st = await stat(transcriptPath).catch(() => null);
    if (!st || st.mtimeMs < cutoff) continue;
    const data = await readHeadAndTail(transcriptPath);
    if (!data) continue;
    const rows = parseJsonLines([...data.head, ...data.tail]);
    const users = rows.filter(r => r.type === 'USER_INPUT' && r.content).map(r => cleanUserText(r.content)).filter(Boolean);
    const replies = rows.filter(r => r.type === 'PLANNER_RESPONSE' && (r.content || r.thinking)).map(r => r.content || r.thinking).filter(Boolean);
    const topic = clip(scrubSecrets(users.at(-1) ?? users[0] ?? ''), 240);
    const summary = clip(scrubSecrets(replies.at(-1) ?? ''), 400);
    const cwd = inferWorkspaceFromText([...users, ...replies].join('\n'));
    sessions.push({ id: entry.name, host: 'antigravity', at: st.mtimeMs, cwd, topic, summary, transcriptPath });
  }
  return sessions;
}

async function discoverClaude(projectsDir, cutoff) {
  const dirs = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  const sessions = [];
  for (const dir of dirs) {
    if (!dir.isDirectory() || /nexus-reply-/i.test(dir.name)) continue;
    const fullDir = join(projectsDir, dir.name);
    const files = await readdir(fullDir, { withFileTypes: true }).catch(() => []);
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const transcriptPath = join(fullDir, f.name);
      const st = await stat(transcriptPath).catch(() => null);
      if (!st || st.mtimeMs < cutoff) continue;
      const data = await readHeadAndTail(transcriptPath);
      if (!data) continue;
      const rows = parseJsonLines([...data.head, ...data.tail]);
      const cwd = rows.find(r => r.cwd)?.cwd ?? '';
      const users = rows.filter(r => r.type === 'user' && r.message).map(r => cleanUserText(extractTextContent(r.message.content))).filter(Boolean);
      const replies = rows.filter(r => r.type === 'assistant' && r.message).map(r => extractTextContent(r.message.content)).filter(Boolean);
      sessions.push({
        id: f.name.replace(/\.jsonl$/i, ''),
        host: 'claude',
        at: st.mtimeMs,
        cwd,
        topic: clip(scrubSecrets(users.at(-1) ?? users[0] ?? ''), 240),
        summary: clip(scrubSecrets(replies.at(-1) ?? ''), 400),
        transcriptPath,
      });
    }
  }
  return sessions;
}

async function listJsonlRecursive(dir, cutoff, depth = 0) {
  if (depth > 4) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listJsonlRecursive(full, cutoff, depth + 1));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const st = await stat(full).catch(() => null);
      if (st && st.mtimeMs >= cutoff) out.push({ path: full, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

async function discoverCodex(codexSessionsDir, cutoff) {
  const files = await listJsonlRecursive(codexSessionsDir, cutoff);
  const sessions = [];
  for (const f of files) {
    const data = await readHeadAndTail(f.path);
    if (!data) continue;
    const rows = parseJsonLines([...data.head, ...data.tail]);
    const meta = rows.find(r => r.type === 'session_meta')?.payload ?? {};
    const id = meta.id || meta.session_id || basename(f.path, '.jsonl');
    const cwd = meta.cwd || '';
    const users = rows
      .filter(r => (r.type === 'response_item' && r.payload?.role === 'user') || (r.type === 'event_msg' && r.payload?.type === 'user_message'))
      .map(r => cleanUserText(r.payload?.message ?? extractTextContent(r.payload?.content)))
      .filter(Boolean);
    const replies = rows
      .filter(r => (r.type === 'response_item' && r.payload?.role === 'assistant') || (r.type === 'event_msg' && r.payload?.type === 'agent_message'))
      .map(r => r.payload?.message ?? extractTextContent(r.payload?.content))
      .filter(Boolean);
    sessions.push({
      id,
      host: 'codex',
      at: f.mtimeMs,
      cwd,
      topic: clip(scrubSecrets(users.at(-1) ?? users[0] ?? ''), 240),
      summary: clip(scrubSecrets(replies.at(-1) ?? ''), 400),
      transcriptPath: f.path,
    });
  }
  return sessions;
}

/** Discovers active sessions across Nexus hooks, Antigravity, Claude Code, and Codex. */
export async function discoverSessions(root, { maxAgeMs = ACTIVE_MS, limit = 15, home = homedir(), includeHosts = true } = {}) {
  const cutoff = Date.now() - maxAgeMs;
  const hookNames = await readdir(folder(root)).catch(() => []);
  const hookRows = (await Promise.all(hookNames.map(async n => {
    try { return JSON.parse(await readFile(join(folder(root), n), 'utf8')); } catch { return null; }
  }))).filter(s => s && s.at >= cutoff);

  const hostRows = includeHosts ? (await Promise.all([
    discoverAntigravity(join(home, '.gemini', 'antigravity', 'brain'), cutoff),
    discoverClaude(join(home, '.claude', 'projects'), cutoff),
    discoverCodex(join(home, '.codex', 'sessions'), cutoff),
  ])).flat() : [];

  const merged = new Map();
  for (const s of [...hostRows, ...hookRows]) {
    if (!s?.id) continue;
    const prev = merged.get(s.id) ?? {};
    merged.set(s.id, {
      id: s.id,
      host: s.host || prev.host || 'hook',
      at: Math.max(prev.at ?? 0, s.at ?? 0),
      cwd: s.cwd || prev.cwd || '',
      folder: (s.cwd || prev.cwd) ? basename(s.cwd || prev.cwd) : '',
      claim: s.claim || prev.claim || '',
      topic: s.topic || prev.topic || '',
      summary: s.summary || prev.summary || '',
      transcriptPath: s.transcriptPath || prev.transcriptPath || '',
    });
  }
  return [...merged.values()].sort((a, b) => b.at - a.at).slice(0, limit);
}

/** Picks the best existing workspace directory from discovered sessions for a given query. */
export async function selectWorkspace(sessions, query = '', fallback = homedir()) {
  const tokens = String(query ?? '').toLowerCase().split(/[^a-z0-9_#-]+/).filter(t => t.length >= 2);
  const scored = [];
  for (const s of sessions) {
    if (!s.cwd) continue;
    const st = await stat(s.cwd).catch(() => null);
    if (!st?.isDirectory()) continue;
    const haystack = `${s.cwd} ${s.folder} ${s.claim} ${s.topic} ${s.summary}`.toLowerCase();
    let score = 0;
    for (const t of tokens) if (haystack.includes(t)) score += 1;
    scored.push({ cwd: s.cwd, score, at: s.at });
  }
  scored.sort((a, b) => b.score - a.score || b.at - a.at);
  return scored[0]?.cwd || fallback;
}

/** Formats discovered sessions for the responder prompt, bounded to maxChars. */
export function formatSessionContext(sessions, { own = false, maxChars = 6000 } = {}) {
  if (!sessions.length) return '';
  const lines = [];
  let len = 0;
  for (const s of sessions) {
    const parts = [
      `[${s.host}]`,
      `last active ${new Date(s.at).toISOString()}`,
      own && s.cwd ? `cwd ${s.cwd}` : (s.folder ? `folder ${s.folder}` : ''),
      s.claim ? `working on: ${s.claim}` : '',
      s.topic ? `last request: ${s.topic}` : '',
      s.summary ? `latest progress: ${s.summary}` : '',
      own && s.transcriptPath ? `transcript: ${s.transcriptPath}` : '',
    ];
    const line = '- ' + parts.filter(Boolean).join('; ');
    if (len + line.length + 1 > maxChars) break;
    lines.push(line);
    len += line.length + 1;
  }
  return lines.join('\n');
}

/** One line per recently active hook-published session, as much of it as this audience may see. */
export async function describeSessions(root, own) {
  const names = await readdir(folder(root)).catch(() => []);
  const all = await Promise.all(names.map(async n => { try { return JSON.parse(await readFile(join(folder(root), n), 'utf8')); } catch { return null; } }));
  return all.filter(s => s && Date.now() - s.at < ACTIVE_MS && (own || s.claim)).sort((a, b) => b.at - a.at).slice(0, 15).map(s => {
    const parts = [`last active ${new Date(s.at).toISOString()}`, own && s.cwd ? `folder ${basename(s.cwd)}` : '', s.claim ? `working on: ${s.claim}` : '', own && s.topic ? `last request: ${s.topic}` : ''];
    return '- ' + parts.filter(Boolean).join('; ');
  }).join('\n');
}
