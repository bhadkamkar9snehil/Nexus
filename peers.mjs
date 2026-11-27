// Peer-to-peer connections between Nexus installations: no hub. Each side keeps the other's token and a per-peer
// switch and permissions. Mail and chat travel over HTTP to the peer's receiver (the webhook port) and are kept in a local mailbox.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { beginPeerSpan, traceId, validTrace, validSpan, validMessage } from './peer-telemetry.mjs';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

const kinds = ['mail', 'chat'];
const maxBody = 64 * 1024;
const DEFAULT_MAILBOX_SETTINGS = { retentionDays: 30, maxMessages: 200 };
const folder = (root) => process.env.NEXUS_PEERS_DIR || join(root, 'secrets');
const file = (root, name) => join(folder(root), name);

async function load(root) {
  try { return JSON.parse(await readFile(file(root, 'peers.json'), 'utf8')); } catch { return { peers: [] }; }
}
async function save(root, config) {
  await mkdir(folder(root), { recursive: true });
  await writeFile(file(root, 'peers.json'), JSON.stringify(config, null, 2));
}
const clean = ({ name, url, enabled, allow, outbound, own, responder }) => ({ name, url, enabled, allow, paired: Boolean(outbound), own: Boolean(own), responder });

/** The name this installation introduces itself with: the computer name unless `self` is set in peers.json. */
export async function selfName(root) {
  return String((await load(root)).self || hostname()).toLowerCase().replace(/[^\w.-]/g, '-').slice(0, 40);
}

export async function listPeers(root) { return (await load(root)).peers.map(clean); }
export async function getPeer(root, name) { const p = (await load(root)).peers.find(x => x.name === name); return p ? clean(p) : null; }

/** Adds or updates a peer. `outbound` is the token the peer gave us; the returned `inbound` is what to give the peer. */
export async function addPeer(root, { name, url, outbound, allow, own, autoReply }) {
  if (!/^[\w.-]{1,40}$/.test(name ?? '')) throw new Error('Peer name must be 1-40 letters, digits, dot, dash or underscore');
  if (!/^https?:\/\/[^\s/]+/.test(url ?? '')) throw new Error('Peer url must be http(s)://host:port');
  // Pairing takes two steps: each side adds the other (getting the token to hand over), then each sets the token it received.
  if (outbound !== undefined && (typeof outbound !== 'string' || outbound.length < 16)) throw new Error('outbound token must be the 16+ character token the peer gave you');
  const config = await load(root);
  let peer = config.peers.find(p => p.name === name);
  if (!peer) config.peers.push(peer = { name, enabled: true, allow: { mail: true, chat: true }, inbound: randomBytes(24).toString('hex') });
  Object.assign(peer, { url: url.replace(/\/+$/, ''), ...(outbound === undefined ? {} : { outbound }) });
  if (allow) peer.allow = { mail: allow.mail !== false, chat: allow.chat !== false };
  if (own !== undefined) peer.own = own; // a device of the same Tailscale account (the owner's own computer)
  if (typeof autoReply === 'boolean') peer.responder = { ...peer.responder, enabled: autoReply };
  await save(root, config);
  return { ...clean(peer), inbound: peer.inbound };
}

export async function setPeer(root, name, { enabled, allow, outbound, responder }) {
  const config = await load(root);
  const peer = config.peers.find(p => p.name === name);
  if (!peer) throw new Error('Unknown peer');
  if (outbound !== undefined) {
    if (typeof outbound !== 'string' || outbound.length < 16) throw new Error('outbound token must be the 16+ character token the peer gave you');
    peer.outbound = outbound;
  }
  if (typeof enabled === 'boolean') peer.enabled = enabled;
  if (allow) for (const kind of kinds) if (typeof allow[kind] === 'boolean') peer.allow[kind] = allow[kind];
  if (responder) {
    peer.responder ??= {};
    if (typeof responder.enabled === 'boolean') peer.responder.enabled = responder.enabled;
    if (responder.autonomy === null) delete peer.responder.autonomy;
    if (['safe', 'full'].includes(responder.autonomy)) peer.responder.autonomy = responder.autonomy;
  }
  await save(root, config);
  return clean(peer);
}

export async function removePeer(root, name) {
  const config = await load(root);
  config.peers = config.peers.filter(p => p.name !== name);
  await save(root, config);
}

// The mailbox is append-only JSON lines: message rows and read-marker rows, folded on read.
async function mailbox(root) {
  let text = '';
  try { text = await readFile(file(root, 'mailbox.jsonl'), 'utf8'); } catch { /* empty mailbox */ }
  const read = new Set(), messages = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { const row = JSON.parse(line); if (row.read) read.add(row.read); else messages.push(row); } catch { /* skip partial line */ }
  }
  return messages.map(m => ({ ...m, read: read.has(m.id) }));
}

export async function loadMailboxSettings(root) {
  let raw = {};
  try { raw = JSON.parse(await readFile(file(root, 'mailbox-settings.json'), 'utf8')); } catch { /* defaults */ }
  const retentionDays = Number.isInteger(raw.retentionDays) && raw.retentionDays >= 0 && raw.retentionDays <= 3650 ? raw.retentionDays : DEFAULT_MAILBOX_SETTINGS.retentionDays;
  const maxMessages = Number.isInteger(raw.maxMessages) && raw.maxMessages >= 50 && raw.maxMessages <= 2000 ? raw.maxMessages : DEFAULT_MAILBOX_SETTINGS.maxMessages;
  return { retentionDays, maxMessages };
}

export async function saveMailboxSettings(root, { retentionDays, maxMessages } = {}) {
  const current = await loadMailboxSettings(root);
  const next = { ...current };
  if (retentionDays !== undefined) {
    const n = Number(retentionDays);
    if (!Number.isInteger(n) || n < 0 || n > 3650) throw new Error('retentionDays must be an integer 0-3650 (0 = keep forever)');
    next.retentionDays = n;
  }
  if (maxMessages !== undefined) {
    const n = Number(maxMessages);
    if (!Number.isInteger(n) || n < 50 || n > 2000) throw new Error('maxMessages must be an integer 50-2000');
    next.maxMessages = n;
  }
  await mkdir(folder(root), { recursive: true });
  await writeFile(file(root, 'mailbox-settings.json'), JSON.stringify(next, null, 2));
  return next;
}

export async function mailboxStats(root) {
  const messages = await mailbox(root);
  let fileBytes = 0;
  try { fileBytes = (await stat(file(root, 'mailbox.jsonl'))).size; } catch { /* no file yet */ }
  let oldestAt = null, newestAt = null;
  for (const m of messages) {
    if (typeof m.at === 'number') {
      if (oldestAt === null || m.at < oldestAt) oldestAt = m.at;
      if (newestAt === null || m.at > newestAt) newestAt = m.at;
    }
  }
  return { totalMessages: messages.length, fileBytes, oldestAt, newestAt };
}

export async function compactMailbox(root, retentionDays) {
  const settings = retentionDays === undefined ? await loadMailboxSettings(root) : { retentionDays };
  const days = settings.retentionDays;
  const messages = await mailbox(root);
  const cutoff = days > 0 ? Date.now() - days * 86_400_000 : 0;
  const kept = cutoff > 0 ? messages.filter(m => (m.at ?? 0) >= cutoff) : messages;
  const pruned = messages.length - kept.length;
  if (pruned <= 0 && messages.length > 0) {
    // Also compact if read-marker lines have grown large without any pruned messages, only when explicitly requested or pruned > 0.
    return { pruned: 0, remaining: kept.length };
  }
  if (messages.length === 0) return { pruned: 0, remaining: 0 };
  const lines = [];
  for (const m of kept) {
    const { read, ...rest } = m;
    lines.push(JSON.stringify(rest));
    if (read) lines.push(JSON.stringify({ read: m.id }));
  }
  await mkdir(folder(root), { recursive: true });
  const tmp = file(root, `mailbox.${randomBytes(4).toString('hex')}.tmp`);
  await writeFile(tmp, lines.length ? lines.join('\n') + '\n' : '');
  await rename(tmp, file(root, 'mailbox.jsonl'));
  return { pruned, remaining: kept.length };
}

export async function readMailbox(root, { box = 'in', peer, unread = false, limit = 50, sinceAt = 0 } = {}) {
  return (await mailbox(root))
    .filter(m => m.box === box && (!peer || m.peer === peer) && !(unread && m.read) && (!sinceAt || (m.at ?? 0) >= sinceAt))
    .reverse().slice(0, Math.min(Math.max(limit, 1), 2000));
}

export async function mailboxSummary(root) {
  const summaries = new Map();
  for (const m of await mailbox(root)) {
    if (!summaries.has(m.peer)) summaries.set(m.peer, { peer: m.peer, unread: 0, latest: null });
    const summary = summaries.get(m.peer);
    if (m.box === 'in' && !m.read) summary.unread++;
    if (!summary.latest || m.at >= summary.latest.at) {
      summary.latest = { at: m.at, box: m.box, preview: m.subject?.trim() || m.body.trim().slice(0, 160) };
    }
  }
  return [...summaries.values()];
}

export async function markRead(root, ids) {
  await mkdir(folder(root), { recursive: true });
  await appendFile(file(root, 'mailbox.jsonl'), ids.map(read => JSON.stringify({ read }) + '\n').join(''));
}

let lastCompactAt = 0;
async function store(root, message) {
  await mkdir(folder(root), { recursive: true });
  await appendFile(file(root, 'mailbox.jsonl'), JSON.stringify(message) + '\n');
  if (Date.now() - lastCompactAt > 3_600_000) {
    lastCompactAt = Date.now();
    const { retentionDays } = await loadMailboxSettings(root);
    if (retentionDays > 0) await compactMailbox(root, retentionDays).catch(() => {});
  }
}

function validate({ kind, subject, body, hop }) {
  if (hop !== undefined && (!Number.isInteger(hop) || hop < 0 || hop > 20)) throw new Error('hop must be an integer 0-20');
  if (!kinds.includes(kind)) throw new Error('kind must be mail or chat');
  if (typeof body !== 'string' || !body || body.length > maxBody) throw new Error('body required, at most 64 KB');
  if (subject !== undefined && (typeof subject !== 'string' || subject.length > 200)) throw new Error('subject at most 200 characters');
}

export async function sendMessage(root, { to, kind = 'mail', subject, body, hop, trace, parentSpanId }, fetcher = fetch) {
  validate({ kind, subject, body, hop });
  const messageId=randomBytes(16).toString('hex');
  const span=beginPeerSpan(root,'peer_send',{peer:to,kind,trace,parent:parentSpanId,messageId,hop,bytes:Buffer.byteLength(body)});
  let stage='refused',httpStatus;
  try {
  const peer = (await load(root)).peers.find(p => p.name === to);
  if (!peer) throw new Error('Unknown peer');
  if (!peer.enabled) throw new Error('Peer is switched off');
  if (!peer.allow[kind]) throw new Error(`Peer is not permitted to exchange ${kind}`);
  if (!peer.outbound) throw new Error('Pairing is incomplete: set the token the peer gave you (nexus_peers set outbound_token)');
  const self = (await load(root)).self ?? 'nexus';
  stage='transport_error';
  const response = await fetcher(peer.url + '/peer/message', {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + peer.outbound },
    body: JSON.stringify({ kind, subject, body, trace:span.traceId,parentSpanId:span.spanId,messageId, ...(hop === undefined ? {} : { hop }) }),
  });
  httpStatus=response.status;
  if (!response.ok) {stage='refused';throw new Error(`Peer refused the message (${response.status})`);}
  stage='storage_error';
  const message = { id: randomBytes(6).toString('hex'), trace:span.traceId,parentSpanId:span.spanId,messageId, box: 'out', at: Date.now(), peer: to, kind, subject, body, ...(hop === undefined ? {} : { hop }) };
  await store(root, message);
  span.finish('passed','delivered',{httpStatus});
  return { id: message.id, delivered: true, from: self };
  } catch(error){span.finish(stage==='refused'?'blocked':'error',stage,{httpStatus});throw error;}
}

/** Handles POST /peer/message for the receiver. Returns an HTTP status; `onMessage` is called for each stored message. */
export async function receive(root, authorization, payload, onMessage) {
  const token = Buffer.from(String(authorization ?? '').replace(/^Bearer /, ''));
  const peer = (await load(root)).peers.find(p => { const a = Buffer.from(p.inbound); return a.length === token.length && timingSafeEqual(a, token); });
  if (!peer) return 401; // not logged: anyone who can reach the port could push real entries out of the run history
  if (!peer.enabled) {beginPeerSpan(root,'peer_receive',{peer:peer.name}).finish('blocked','refused',{httpStatus:403});return 403;}
  try { validate(payload); } catch {beginPeerSpan(root,'peer_receive',{peer:peer.name}).finish('blocked','refused',{httpStatus:400});return 400;}
  if (!peer.allow[payload.kind]) {beginPeerSpan(root,'peer_receive',{peer:peer.name,kind:payload.kind}).finish('blocked','refused',{httpStatus:403});return 403;}
  const messageId=validMessage(payload.messageId)?payload.messageId:randomBytes(16).toString('hex');
  const span=beginPeerSpan(root,'peer_receive',{peer:peer.name,kind:payload.kind,trace:validTrace(payload.trace)?payload.trace:undefined,parent:validSpan(payload.parentSpanId)?payload.parentSpanId:undefined,messageId,hop:payload.hop,bytes:Buffer.byteLength(payload.body)});
  const message = { id: randomBytes(6).toString('hex'), trace:span.traceId,parentSpanId:span.spanId,messageId, box: 'in', at: Date.now(), peer: peer.name, kind: payload.kind, subject: payload.subject, body: payload.body, ...(payload.hop === undefined ? {} : { hop: payload.hop }) };
  try{await store(root, message);}catch(error){span.finish('error','storage_error');throw error;}
  span.finish('passed','received',{httpStatus:200});
  onMessage?.(message);
  return 200;
}
