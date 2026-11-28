// Reaching peers over the internet through the Nexus relay (relay/worker.mjs). Each computer keeps one outbound WebSocket,
// so no inbound port, VPN or per-user Cloudflare account is needed. Everything is sealed with AES-256-GCM; the key is part
// of the peer address (shared inside the pairing code) and is never sent to the relay.
//   node relay-client.mjs setup https://nexus-relay.<subdomain>.workers.dev
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const folder = (root) => process.env.NEXUS_PEERS_DIR || join(root, 'secrets');
const ADDRESS = /^(https?:\/\/[^\s#]+?\/box\/[0-9a-f]{64})\/k\/([\w-]{43})$/;
const PATHS = new Set(['/peer/message', '/peer/pair']);
const FRESH_MS = 5 * 60_000;

export const isRelayAddress = (url) => ADDRESS.test(url ?? '');
export const maskAddress = (url) => String(url).replace(/\/k\/[\w-]{43}$/, '/k/hidden');

export async function loadRelay(root) {
  try { return JSON.parse(await readFile(join(folder(root), 'relay.json'), 'utf8')); } catch { return null; }
}

export async function setupRelay(root, url) {
  if (!/^https:\/\/[^\s/]+\/?$/.test(url ?? '')) throw new Error('Relay url must be https://host');
  const existing = await loadRelay(root);
  const config = { url: url.replace(/\/$/, ''), secret: existing?.secret ?? randomBytes(32).toString('base64url'), key: existing?.key ?? randomBytes(32).toString('base64url') };
  await mkdir(folder(root), { recursive: true });
  await writeFile(join(folder(root), 'relay.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
  return config;
}

const boxOf = (config) => `${config.url}/box/${createHash('sha256').update(config.secret).digest('hex')}`;
/** The address other computers use to reach this one, or null when no relay is configured. */
export async function relayAddress(root) {
  const config = await loadRelay(root);
  return config ? `${boxOf(config)}/k/${config.key}` : null;
}

export function seal(key, label, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), iv);
  cipher.setAAD(Buffer.from(label));
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function open(key, label, text) {
  const raw = Buffer.from(text, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(label));
  decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
}

/** fetch() for peer URLs: relay addresses are sealed and sent through the relay; anything else goes straight out. */
export async function peerFetch(url, init, fetcher = fetch) {
  const path = [...PATHS].find(p => url.endsWith(p));
  const match = path && ADDRESS.exec(url.slice(0, -path.length));
  if (!match) return fetcher(url, init);
  const [, box, key] = match;
  const nonce = randomBytes(16).toString('hex');
  const sealed = seal(key, 'request', { path, nonce, at: Date.now(), authorization: init.headers?.Authorization, body: init.body });
  const response = await fetcher(box, { method: 'POST', signal: init.signal, headers: { 'Content-Type': 'text/plain' }, body: sealed });
  if (!response.ok) return response;
  const reply = open(key, 'response:' + nonce, await response.text());
  return new Response(reply.body || null, { status: reply.status });
}

/** Turns one sealed request into a call on this computer's own receiver and seals the answer. */
export async function handleEnvelope(key, sealed, { port, seen = new Map(), fetcher = fetch }) {
  const request = open(key, 'request', sealed);
  const now = Date.now();
  for (const [nonce, at] of seen) if (now - at > 2 * FRESH_MS) seen.delete(nonce);
  if (!PATHS.has(request.path) || Math.abs(now - request.at) > FRESH_MS || seen.has(request.nonce)) throw new Error('refused envelope');
  seen.set(request.nonce, now);
  const response = await fetcher(`http://127.0.0.1:${port}${request.path}`, {
    method: 'POST', signal: AbortSignal.timeout(7000), body: request.body,
    headers: { 'Content-Type': 'application/json', ...(request.authorization ? { Authorization: request.authorization } : {}) },
  });
  return seal(key, 'response:' + request.nonce, { status: response.status, body: await response.text() });
}

/** Keeps this computer's mailbox connected. Re-reads relay.json on every connect, so setup needs no restart. */
export function startRelay(root, { port, log = () => {} }) {
  const seen = new Map();
  let socket, ping, retry, delay = 2000, stopped = false;
  const again = () => { clearInterval(ping); if (!stopped) { retry = setTimeout(connect, delay); delay = Math.min(delay * 2, 60_000); } };
  async function connect() {
    const config = await loadRelay(root);
    if (!config) { delay = 30_000; return again(); }
    socket = new WebSocket(boxOf(config).replace(/^http/, 'ws') + '/connect', ['nexus', config.secret]);
    let answered = Date.now();
    socket.onopen = () => {
      delay = 2000; log('Internet relay connected.');
      ping = setInterval(() => { if (Date.now() - answered > 70_000) socket.close(); else socket.send('ping'); }, 30_000);
    };
    socket.onmessage = async ({ data }) => {
      answered = Date.now();
      if (data === 'pong') return;
      try {
        const { id, sealed } = JSON.parse(data);
        socket.send(JSON.stringify({ id, sealed: await handleEnvelope(config.key, sealed, { port, seen }) }));
      } catch (error) { log('Internet relay: ' + error.message); }
    };
    socket.onclose = again;
    socket.onerror = () => {};
  }
  connect();
  return () => { stopped = true; clearTimeout(retry); clearInterval(ping); socket?.close(); };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, url] = process.argv.slice(2);
  if (command !== 'setup') { console.error('Usage: node relay-client.mjs setup https://host'); process.exit(1); }
  await setupRelay(import.meta.dirname, url);
  console.log('Relay saved. Restart the Nexus monitor if it is older than this setup.');
}
