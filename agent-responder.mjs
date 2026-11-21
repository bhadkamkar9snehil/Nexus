// Agent-to-agent without a human: when a chat message arrives from one of the owner's own computers, run the owner's agent
// headlessly (Claude Code by default) with the message, and send its answer back to that computer.
// Safeguards against loops and runaway cost: only paired own devices, chat only, a hop counter (default 6), the reply
// "NO_REPLY" ends a conversation, one agent run per peer at a time, and a timeout.
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getPeer, markRead, selfName, sendMessage } from './peers.mjs';

const folder = (root) => process.env.NEXUS_PEERS_DIR || join(root, 'secrets');
const configFile = (root) => join(folder(root), 'agent-responder.json');
const NO_REPLY = 'NO_REPLY';

/**
 * agent-responder.json (all optional): enabled (default true), autonomy "safe" (default: Nexus tools only) or "full"
 * (the agent may use any tool without asking), command and args to run another agent, maxHops, timeoutMs.
 */
export async function loadResponderConfig(root) {
  let config = {};
  try { config = JSON.parse(await readFile(configFile(root), 'utf8')); } catch { /* defaults */ }
  return { enabled: true, autonomy: 'safe', maxHops: 6, timeoutMs: 300_000, ...config };
}

/** Changes enabled and/or autonomy ("safe" or "full"); other settings in the file are kept. */
export async function saveResponderConfig(root, { enabled, autonomy }) {
  let stored = {};
  try { stored = JSON.parse(await readFile(configFile(root), 'utf8')); } catch { /* new file */ }
  if (typeof enabled === 'boolean') stored.enabled = enabled;
  if (autonomy !== undefined) { if (!['safe', 'full'].includes(autonomy)) throw new Error('autonomy must be safe or full'); stored.autonomy = autonomy; }
  await mkdir(folder(root), { recursive: true });
  await writeFile(configFile(root), JSON.stringify(stored, null, 2));
  return loadResponderConfig(root);
}

function findClaude() {
  return new Promise((resolve) => execFile('where.exe', ['claude'], { windowsHide: true }, (error, stdout) => resolve(error ? null : stdout.split(/\r?\n/)[0].trim() || null)));
}

async function agentCommand(config) {
  if (config.command) return { command: config.command, args: config.args ?? [] };
  const claude = await findClaude();
  if (!claude) return null;
  return { command: claude, args: config.autonomy === 'full'
    ? ['-p', '--permission-mode', 'bypassPermissions']
    : ['-p', '--allowedTools', 'mcp__shared_jev'] };
}

function run({ command, args }, prompt, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: homedir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.stdout.on('data', d => { if (out.length < 60_000) out += d; });
    child.stderr.on('data', d => { if (err.length < 4_000) err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ error: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? { out: out.trim() } : { error: (err || `exit ${code}`).trim() }); });
    child.stdin.end(prompt);
  });
}

const busy = new Map(); // peer -> promise of the run in progress (one agent run per peer at a time)

/** Called for every stored incoming message. Resolves with what happened (for tests and logs). */
export async function respondTo(root, message, { log = () => {}, send = sendMessage } = {}) {
  const config = await loadResponderConfig(root);
  const hop = message.hop ?? 0;
  const peer = await getPeer(root, message.peer);
  if (!config.enabled) return 'disabled';
  if (message.kind !== 'chat') return 'not a chat message';
  if (!peer?.own) return 'peer is not one of the owner\'s own computers';
  if (hop >= config.maxHops) return 'hop limit reached';
  const next = (busy.get(message.peer) ?? Promise.resolve()).then(async () => {
    const agent = await agentCommand(config);
    if (!agent) { log('Agent responder: no agent command found (install Claude Code or set command in agent-responder.json).'); return 'no agent'; }
    const me = await selfName(root);
    const prompt = `You are the AI agent running on the computer "${me}". The AI agent on the owner's other computer "${message.peer}" sent you this message (conversation step ${hop + 1}):\n\n${message.body}\n\n` +
      `Do what it asks, using your tools if needed. Your final answer is sent back to it automatically, so write only the answer, concisely. ` +
      `If the message needs no action or reply (a thanks, an acknowledgement, or a conversation that is finished), answer with exactly ${NO_REPLY}.`;
    const result = await run(agent, prompt, config.timeoutMs);
    const answer = result.error ? `I could not handle that: ${result.error.slice(0, 500)}` : result.out;
    await markRead(root, [message.id]);
    if (!answer || answer.trim() === NO_REPLY) return 'finished';
    await send(root, { to: message.peer, kind: 'chat', subject: ('re: ' + (message.subject ?? '')).slice(0, 200), body: answer.slice(0, 60_000), hop: hop + 1 });
    return 'replied';
  }).catch((error) => { log('Agent responder: ' + error.message); return 'error'; });
  busy.set(message.peer, next);
  return next;
}
