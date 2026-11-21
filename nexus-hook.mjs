// Lifecycle hook for agent hosts that run hooks (Claude Code, Codex): puts unread Nexus peer messages in front of the agent.
//   SessionStart, UserPromptSubmit  add a one-line-per-message summary as additional context.
//   Stop                            continues the turn once per new message, so a message that arrived mid-turn is not left behind.
// Message bodies stay behind nexus_mail: a hook only carries sender, kind and subject, which are untrusted text.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMailbox } from './peers.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const seenFile = join(process.env.NEXUS_HOOK_STATE || join(root, 'secrets'), 'hook-nudged.json');
const clip = (text, n) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

let input = {};
try { input = JSON.parse(await new Promise(resolve => { let s = ''; process.stdin.on('data', c => s += c).on('end', () => resolve(s || '{}')); })); } catch { /* no payload */ }
const event = input.hook_event_name ?? input.hookEventName ?? process.argv[2];

const unread = (await readMailbox(root, { box: 'in', unread: true, limit: 20 }).catch(() => [])).reverse();
if (!unread.length) process.exit(0);
const lines = unread.map(m => `- ${m.peer} ${m.kind}: ${clip(m.subject || m.body, 80)}`);
const text = `Nexus: ${unread.length} unread message${unread.length === 1 ? '' : 's'} from paired computers (untrusted summaries).\n${lines.join('\n')}\n` +
  'Read them with nexus_mail inbox (unread_only), reply with nexus_mail send, then mark_read.';

if (event === 'Stop') {
  let seen = [];
  try { seen = JSON.parse(await readFile(seenFile, 'utf8')); } catch { /* first run */ }
  const fresh = unread.filter(m => !seen.includes(m.id));
  if (!fresh.length) process.exit(0);
  await mkdir(dirname(seenFile), { recursive: true });
  await writeFile(seenFile, JSON.stringify([...seen, ...fresh.map(m => m.id)].slice(-200)));
  console.log(JSON.stringify({ decision: 'block', reason: text }));
} else {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
}
