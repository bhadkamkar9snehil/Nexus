// Peer-to-peer connections between Nexus installations: no hub. Each side keeps the other's token and a per-peer
// switch and permissions. Mail and chat travel over HTTP to the peer's receiver (the webhook port) and are kept in a local mailbox.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const kinds = ['mail', 'chat'];
const maxBody = 64 * 1024;
const file = (root, name) => join(root, 'secrets', name);

async function load(root) {
  try { return JSON.parse(await readFile(file(root, 'peers.json'), 'utf8')); } catch { return { peers: [] }; }
}
async function save(root, config) {
  await mkdir(join(root, 'secrets'), { recursive: true });
  await writeFile(file(root, 'peers.json'), JSON.stringify(config, null, 2));
}
const clean = ({ name, url, enabled, allow }) => ({ name, url, enabled, allow });

export async function listPeers(root) { return (await load(root)).peers.map(clean); }

/** Adds or updates a peer. `outbound` is the token the peer gave us; the returned `inbound` is what to give the peer. */
export async function addPeer(root, { name, url, outbound, allow }) {
  if (!/^[\w.-]{1,40}$/.test(name ?? '')) throw new Error('Peer name must be 1-40 letters, digits, dot, dash or underscore');
  if (!/^https?:\/\/[^\s/]+/.test(url ?? '')) throw new Error('Peer url must be http(s)://host:port');
  if (typeof outbound !== 'string' || outbound.length < 16) throw new Error('outbound token required');
  const config = await load(root);
  let peer = config.peers.find(p => p.name === name);
  if (!peer) config.peers.push(peer = { name, enabled: true, allow: { mail: true, chat: true }, inbound: randomBytes(24).toString('hex') });
  Object.assign(peer, { url: url.replace(/\/+$/, ''), outbound });
  if (allow) peer.allow = { mail: allow.mail !== false, chat: allow.chat !== false };
  await save(root, config);
  return { ...clean(peer), inbound: peer.inbound };
}

export async function setPeer(root, name, { enabled, allow }) {
  const config = await load(root);
  const peer = config.peers.find(p => p.name === name);
  if (!peer) throw new Error('Unknown peer');
  if (typeof enabled === 'boolean') peer.enabled = enabled;
  if (allow) for (const kind of kinds) if (typeof allow[kind] === 'boolean') peer.allow[kind] = allow[kind];
  await save(root, config);
  return clean(peer);
}

export async function removePeer(root, name) {
  const config = await load(root);
  config.peers = config.peers.filter(p => p.name !== name);
  await save(root, config);
}

// The mailbox is append-only JSON lines: message rows and read-marker rows, folded on read.
export async function readMailbox(root, { box = 'in', unread = false, limit = 50 } = {}) {
  let text = '';
  try { text = await readFile(file(root, 'mailbox.jsonl'), 'utf8'); } catch { /* empty mailbox */ }
  const read = new Set(), messages = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { const row = JSON.parse(line); if (row.read) read.add(row.read); else messages.push(row); } catch { /* skip partial line */ }
  }
  return messages.filter(m => m.box === box && !(unread && read.has(m.id)))
    .map(m => ({ ...m, read: read.has(m.id) })).reverse().slice(0, Math.min(Math.max(limit, 1), 200));
}

export async function markRead(root, ids) {
  await mkdir(join(root, 'secrets'), { recursive: true });
  await appendFile(file(root, 'mailbox.jsonl'), ids.map(read => JSON.stringify({ read }) + '\n').join(''));
}

async function store(root, message) {
  await mkdir(join(root, 'secrets'), { recursive: true });
  await appendFile(file(root, 'mailbox.jsonl'), JSON.stringify(message) + '\n');
}

function validate({ kind, subject, body }) {
  if (!kinds.includes(kind)) throw new Error('kind must be mail or chat');
  if (typeof body !== 'string' || !body || body.length > maxBody) throw new Error('body required, at most 64 KB');
  if (subject !== undefined && (typeof subject !== 'string' || subject.length > 200)) throw new Error('subject at most 200 characters');
}

export async function sendMessage(root, { to, kind = 'mail', subject, body }, fetcher = fetch) {
  validate({ kind, subject, body });
  const peer = (await load(root)).peers.find(p => p.name === to);
  if (!peer) throw new Error('Unknown peer');
  if (!peer.enabled) throw new Error('Peer is switched off');
  if (!peer.allow[kind]) throw new Error(`Peer is not permitted to exchange ${kind}`);
  const self = (await load(root)).self ?? 'nexus';
  const response = await fetcher(peer.url + '/peer/message', {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + peer.outbound },
    body: JSON.stringify({ kind, subject, body }),
  });
  if (!response.ok) throw new Error(`Peer refused the message (${response.status})`);
  const message = { id: randomBytes(6).toString('hex'), box: 'out', at: Date.now(), peer: to, kind, subject, body };
  await store(root, message);
  return { id: message.id, delivered: true, from: self };
}

/** Handles POST /peer/message for the receiver. Returns an HTTP status; `onMessage` is called for each stored message. */
export async function receive(root, authorization, payload, onMessage) {
  const token = Buffer.from(String(authorization ?? '').replace(/^Bearer /, ''));
  const peer = (await load(root)).peers.find(p => { const a = Buffer.from(p.inbound); return a.length === token.length && timingSafeEqual(a, token); });
  if (!peer) return 401;
  if (!peer.enabled) return 403;
  try { validate(payload); } catch { return 400; }
  if (!peer.allow[payload.kind]) return 403;
  const message = { id: randomBytes(6).toString('hex'), box: 'in', at: Date.now(), peer: peer.name, kind: payload.kind, subject: payload.subject, body: payload.body };
  await store(root, message);
  onMessage?.(message);
  return 200;
}
