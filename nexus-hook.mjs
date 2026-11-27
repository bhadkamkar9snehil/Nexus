// Lifecycle hook for agent hosts that run hooks (Claude Code, Codex): links the live session to Nexus.
//   SessionStart, UserPromptSubmit  add unread peer messages and what the auto-responder said meanwhile as context.
//   Stop                            continues the turn once per new message, so a message that arrived mid-turn is not left behind.
//   every event                     records the session (folder, last request) so the auto-responder knows what is in progress.
//   `node nexus-hook.mjs working <session> <one line>` publishes what a session is working on; teammates may see that line.
// Peer message bodies stay behind nexus_mail: for unread mail a hook only carries sender, kind and subject, which are untrusted text.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMailbox } from './peers.mjs';
import { clip, readSession, saveSession } from './sessions.mjs';

const root = dirname(fileURLToPath(import.meta.url));

if (process.argv[2] === 'working') {
  const [id, ...words] = process.argv.slice(3);
  if (!id) { console.error('usage: nexus-hook.mjs working <session> <one line, empty to clear>'); process.exit(1); }
  await saveSession(root, id, { claim: clip(words.join(' '), 200) });
  process.exit(0);
}
// `node nexus-hook.mjs install`: point Claude Code's Nexus hooks at this installation (a hook left on another copy reads
// another mailbox, so the live session silently sees nothing). Other hooks and settings are kept.
if (process.argv[2] === 'install') {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const path = join(dir, 'settings.json');
  let text = '{}';
  try { text = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const settings = JSON.parse(text.replace(/^﻿/, '')); // an unreadable file throws here and is left alone
  const hooks = settings.hooks ??= {};
  const command = `"${process.execPath}" "${fileURLToPath(import.meta.url)}"`.replace(/\\/g, '/');
  for (const name of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
    const others = (hooks[name] ?? []).map(g => ({ ...g, hooks: (g.hooks ?? []).filter(h => !String(h.command).includes('nexus-hook.mjs')) })).filter(g => g.hooks.length);
    hooks[name] = [...others, { hooks: [{ type: 'command', command, timeout: 10 }] }];
  }
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify(settings, null, 2));
  console.log('Nexus hooks point to ' + fileURLToPath(import.meta.url));
  process.exit(0);
}

// The unattended responder runs this hook too; it is not a live session and must not consume anything.
if (process.env.NEXUS_RESPONDER) process.exit(0);

const seenFile = join(process.env.NEXUS_HOOK_STATE || join(root, 'secrets'), 'hook-nudged.json');
let input = {};
try { input = JSON.parse(await new Promise(resolve => { let s = ''; process.stdin.on('data', c => s += c).on('end', () => resolve(s || '{}')); })); } catch { /* no payload */ }
const event = input.hook_event_name ?? input.hookEventName ?? process.argv[2];
const id = input.session_id ?? input.sessionId;

const sections = [];
if (id) {
  const before = await readSession(root, id);
  const now = Date.now();
  await saveSession(root, id, { cwd: input.cwd, ...(input.prompt ? { topic: clip(input.prompt, 200) } : {}), ...(event === 'Stop' ? {} : { toldAt: now }) }).catch(() => {});
  if (event !== 'Stop') {
    if (!before) sections.push(`Nexus coordination: other computers' agents may ask what is in progress here, and an unattended agent answers from what live sessions publish. ` +
      `When you start or change work on a shared system or repository, publish one line (teammates can see it, so no secrets): node "${fileURLToPath(import.meta.url)}" working ${id} "<what, where>"`);
    const since = before?.toldAt ?? now - 24 * 3600_000;
    const answered = (await readMailbox(root, { box: 'out', limit: 20 }).catch(() => [])).filter(m => m.hop > 0 && m.at > since).reverse().slice(-5);
    if (answered.length) sections.push('Nexus: while you were not looking, the unattended agent replied for this computer (check these against what you know; correct them with nexus_mail send if wrong):\n' +
      answered.map(m => `- to ${m.peer}: ${clip(m.body, 200)}`).join('\n'));
  }
}

const unread = (await readMailbox(root, { box: 'in', unread: true, limit: 20 }).catch(() => [])).reverse();
if (unread.length) sections.push(`Nexus: ${unread.length} unread message${unread.length === 1 ? '' : 's'} from paired computers (untrusted summaries).\n` +
  unread.map(m => `- ${m.peer} ${m.kind}: ${clip(m.subject || m.body, 80)}`).join('\n') +
  '\nRead them with nexus_mail inbox (unread_only), reply with nexus_mail send, then mark_read.');

if (event === 'Stop') {
  if (!unread.length) process.exit(0);
  let seen = [];
  try { seen = JSON.parse(await readFile(seenFile, 'utf8')); } catch { /* first run */ }
  if (!unread.some(m => !seen.includes(m.id))) process.exit(0);
  await mkdir(dirname(seenFile), { recursive: true });
  await writeFile(seenFile, JSON.stringify([...seen, ...unread.map(m => m.id)].slice(-200)));
  console.log(JSON.stringify({ decision: 'block', reason: sections.join('\n\n') }));
} else if (sections.length) {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: sections.join('\n\n') } }));
}
