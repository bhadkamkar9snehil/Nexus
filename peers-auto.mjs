// Zero-touch pairing between the owner's own computers, plus one-time pairing codes for everyone else.
// Own devices: Tailscale already authenticates every packet on the tailnet and knows which account owns each device, so a
// computer that contacts /peer/hello from a tailnet address owned by the same account is trusted and paired in one exchange.
// Others (teammates, non-Tailscale LAN): one device shows a short-lived one-time code, the other enters it (AnyDesk style).
import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { addPeer, listPeers, removePeer, selfName, setPeer } from './peers.mjs';

export const PEER_PORT = Number(process.env.NEXUS_WEBHOOK_PORT || 8770);
const folder = (root) => process.env.NEXUS_PEERS_DIR || join(root, 'secrets');
const codesFile = (root) => join(folder(root), 'pairing-codes.json');
const CODE_TTL_MS = 10 * 60_000;

// ---- Tailscale ---------------------------------------------------------------------------------------------------
const tailscaleExe = () => process.env.NEXUS_TAILSCALE || 'C:\\Program Files\\Tailscale\\tailscale.exe';
/** Runs `tailscale status --json`; resolves null when Tailscale is missing or stopped. */
export function runTailscale(args = ['status', '--json']) {
  return new Promise((resolve) => {
    execFile(tailscaleExe(), args, { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

/** Online devices of this tailnet, flagged with whether the same account owns them. */
export async function tailnet(run = runTailscale) {
  const status = await run();
  if (!status?.Self) return null;
  const devices = (nodes) => nodes.map(n => ({ name: String(n.HostName).toLowerCase(), ip: (n.TailscaleIPs ?? []).find(i => i.includes('.')), online: Boolean(n.Online), os: n.OS, mine: n.UserID === status.Self.UserID }));
  return { self: devices([status.Self])[0], devices: devices(Object.values(status.Peer ?? {})).filter(d => d.ip) };
}

// ---- Addresses of this computer ------------------------------------------------------------------------------------
export async function localAddresses(run = runTailscale) {
  const lan = Object.values(networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  const ts = (await tailnet(run))?.self.ip;
  return [...new Set([...(ts ? [ts] : []), ...lan])].map(ip => `http://${ip}:${PEER_PORT}`);
}

// ---- Own-device pairing -------------------------------------------------------------------------------------------------
/** Handles POST /peer/hello from `remoteIp`. Trusts it only when the tailnet says the same account owns that address. */
export async function handleHello(root, remoteIp, body, run = runTailscale) {
  const net = await tailnet(run);
  if (!net) return { status: 403, json: { error: 'Tailscale is not running here' } };
  const caller = net.devices.find(d => d.ip === remoteIp);
  if (!caller?.mine) return { status: 403, json: { error: 'Not a device of this Tailscale account; use a pairing code' } };
  if (typeof body?.token !== 'string' || body.token.length < 16 || !/^[\w.-]{1,40}$/.test(body?.name ?? '')) return { status: 400, json: { error: 'name and token required' } };
  const mine = await addPeer(root, { name: caller.name, url: `http://${remoteIp}:${PEER_PORT}`, outbound: body.token, own: true });
  return { status: 200, json: { name: await selfName(root), token: mine.inbound } };
}

/** Pairs with every online device of the same Tailscale account that runs Nexus and is not paired yet. */
export async function discoverAndPair(root, { run = runTailscale, fetcher = fetch, log = () => {} } = {}) {
  const net = await tailnet(run);
  if (!net) return [];
  const paired = [];
  const known = await listPeers(root);
  // Nexus runs on Windows only; phones, Linux boxes and sleeping computers are skipped.
  for (const device of net.devices.filter(d => d.mine && d.online && d.ip && d.os === 'windows')) {
    const url = `http://${device.ip}:${PEER_PORT}`;
    const existing = known.find(p => p.url === url && p.paired);
    if (existing) {
      // Paired by hand earlier: Tailscale now vouches that it is the owner's own computer.
      if (!existing.own) await addPeer(root, { name: existing.name, url, own: true });
      continue;
    }
    // Our side first (pending), so the token we hand over is the one the peer must present.
    const pending = await addPeer(root, { name: device.name, url, own: true });
    try {
      const reply = await fetcher(url + '/peer/hello', { method: 'POST', signal: AbortSignal.timeout(3000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: await selfName(root), token: pending.inbound }) });
      if (!reply.ok) throw new Error('HTTP ' + reply.status);
      const answer = await reply.json();
      await setPeer(root, device.name, { outbound: answer.token });
      paired.push(device.name); log(`Paired with ${device.name} automatically.`);
    } catch (error) {
      // Not running Nexus (or unreachable): forget the half-made entry so the list stays clean.
      if (!known.some(p => p.name === device.name)) await removePeer(root, device.name);
    }
  }
  return paired;
}

/** Background loop for the monitor host. */
export function startPeerDiscovery(root, { intervalMs = 30_000, log = () => {} } = {}) {
  const tick = () => discoverAndPair(root, { log }).catch(e => log('Peer discovery: ' + e.message));
  const first = setTimeout(tick, 4000);
  const timer = setInterval(tick, intervalMs);
  return () => { clearTimeout(first); clearInterval(timer); };
}

// ---- One-time pairing codes (teammates, devices outside the tailnet) --------------------------------------------------
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Creates a single-use code valid for ten minutes. It carries this computer's name and addresses, so entering it is enough. */
export async function createPairingCode(root, run = runTailscale, autoReply) {
  const secret = randomBytes(9).toString('base64url');
  const codes = (await readCodes(root)).filter(c => c.expires > Date.now());
  codes.push({ secret, expires: Date.now() + CODE_TTL_MS, autoReply });
  await mkdir(folder(root), { recursive: true });
  await writeFile(codesFile(root), JSON.stringify(codes));
  return { code: 'nexus-' + b64({ n: await selfName(root), a: await localAddresses(run), s: secret }), expiresInMinutes: CODE_TTL_MS / 60000 };
}
async function readCodes(root) { try { return JSON.parse(await readFile(codesFile(root), 'utf8')); } catch { return []; } }

/** Handles POST /peer/pair: redeems a code once, then pairs. */
export async function handlePair(root, remoteIp, body) {
  const codes = await readCodes(root);
  const given = Buffer.from(String(body?.secret ?? ''));
  const hit = codes.find(c => c.expires > Date.now() && Buffer.from(c.secret).length === given.length && timingSafeEqual(Buffer.from(c.secret), given));
  if (!hit) return { status: 403, json: { error: 'Invalid or expired code' } };
  if (typeof body.token !== 'string' || body.token.length < 16 || !/^[\w.-]{1,40}$/.test(body?.name ?? '')) return { status: 400, json: { error: 'name and token required' } };
  await writeFile(codesFile(root), JSON.stringify(codes.filter(c => c !== hit))); // single use
  const mine = await addPeer(root, { name: body.name, url: `http://${remoteIp}:${PEER_PORT}`, outbound: body.token, autoReply: hit.autoReply });
  return { status: 200, json: { name: await selfName(root), token: mine.inbound } };
}

/** Enters a code shown on the other computer: tries each address it listed until one answers. */
export async function pairWithCode(root, code, { fetcher = fetch, autoReply } = {}) {
  let info;
  try { info = JSON.parse(Buffer.from(String(code).trim().replace(/^nexus-/, ''), 'base64url').toString('utf8')); } catch { throw new Error('That is not a Nexus pairing code'); }
  if (!/^[\w.-]{1,40}$/.test(info?.n ?? '') || !Array.isArray(info.a) || typeof info.s !== 'string') throw new Error('That is not a Nexus pairing code');
  const pending = await addPeer(root, { name: info.n, url: String(info.a[0]) });
  let lastError = 'No address answered';
  for (const url of info.a.map(String)) {
    try {
      const reply = await fetcher(url + '/peer/pair', { method: 'POST', signal: AbortSignal.timeout(4000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: await selfName(root), secret: info.s, token: pending.inbound }) });
      if (reply.status === 403) { lastError = 'The code was refused (expired or already used)'; break; }
      if (!reply.ok) { lastError = 'HTTP ' + reply.status; continue; }
      const answer = await reply.json();
      await addPeer(root, { name: info.n, url, outbound: answer.token, autoReply });
      return { name: info.n, url };
    } catch (error) { lastError = `${url}: ${error.message}`; }
  }
  await removePeer(root, info.n);
  throw new Error(lastError);
}
