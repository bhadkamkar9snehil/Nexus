// Webhook delivery for the MCP Events extension (SEP-3415): subscription store, signed POSTs (Standard Webhooks profile),
// TTL, retries and watermark cursors. Deliberately no callback restrictions: any http or https URL is accepted, private and
// LAN addresses included, because Nexus is meant to connect the owner's own computers (see USAGE.md).
// The MCP server process handles events/subscribe and events/unsubscribe (it writes subscriptions.json); the monitor host
// runs the delivery loop (it writes delivery-state.json). Each file has one writer.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import { cursorOf, parseCursor, readEvents } from './events.mjs';

export const CODES = { InvalidParams: -32602, NotFound: -32023, Forbidden: -32024, ResourceExhausted: -32025, Unsupported: -32026, CallbackEndpointError: -32027 };
export class EventError extends Error {
  constructor(name, data) { super(name); this.code = CODES[name]; this.data = data; }
}
const MAX_SUBSCRIPTIONS = 50, DEFAULT_TTL_MS = 3600_000, MIN_TTL_MS = 60_000, MAX_BODY = 256 * 1024;
const dir = (root) => process.env.NEXUS_EVENTS_DIR || join(root, 'secrets');
const subsFile = (root) => join(dir(root), 'event-subscriptions.json');
const stateFile = (root) => join(dir(root), 'event-delivery-state.json');

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}
async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true });
  const temp = path + '.' + randomBytes(4).toString('hex') + '.tmp';
  await writeFile(temp, JSON.stringify(value));
  await rename(temp, path);
}
const loadSubs = async (root) => await readJson(subsFile(root), { subs: {} });

const category = (error) => /CERT|SELF_SIGNED|TLS|SSL|UNABLE_TO_VERIFY|ERR_TLS/i.test(error.code ?? '') ? 'tls_error'
  : ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(error.code) ? 'connection_refused' : 'timeout';

/** One POST to an http or https URL. Redirects are not followed, the reply body is bounded, https certificates are not checked. */
export function post(url, headers, body, { timeoutMs = 5000 } = {}) {
  const target = new URL(url);
  const secure = target.protocol === 'https:';
  return new Promise((resolve) => {
    const request = (secure ? https : http).request(target, {
      method: 'POST', timeout: timeoutMs, headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      ...(secure ? { rejectUnauthorized: false } : {}),
    }, (response) => {
      const chunks = []; let size = 0;
      response.on('data', (c) => { size += c.length; if (size <= 4096) chunks.push(c); });
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    request.on('error', (error) => resolve({ error: category(error) }));
    request.end(body);
  });
}

// ---- Standard Webhooks signing ---------------------------------------------------------------------------------
export const secretBytes = (secret) => Buffer.from(secret.slice(6), 'base64');
export function validSecret(secret) {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) return false;
  const n = secretBytes(secret).length;
  return n >= 24 && n <= 64;
}
export function signHeaders({ secrets, subscriptionId, messageId, body }) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signatures = secrets.map(s => 'v1,' + createHmac('sha256', secretBytes(s)).update(`${messageId}.${timestamp}.${body}`).digest('base64'));
  return { 'Content-Type': 'application/json', 'webhook-id': messageId, 'webhook-timestamp': timestamp, 'webhook-signature': signatures.join(' '), 'X-MCP-Subscription-Id': subscriptionId };
}

// ---- Subscriptions ---------------------------------------------------------------------------------------------
const canonical = (value) => JSON.stringify(value, (_k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export const subscriptionId = (principal, url, name, args) =>
  'sub_' + createHash('sha256').update(canonical([principal, url, name, args ?? {}])).digest('hex').slice(0, 16);

function grant(ttlMs) {
  if (ttlMs === null) return null; // the client asked for no expiry; persisted, never expires
  const wanted = ttlMs === undefined ? DEFAULT_TTL_MS : ttlMs;
  return new Date(Date.now() + Math.max(MIN_TTL_MS, wanted)).toISOString();
}
const alive = (sub) => sub.refreshBefore === null || Date.parse(sub.refreshBefore) > Date.now();

/**
 * events/subscribe for one principal. `head`/`first` describe the event log so a client cursor can be honoured.
 * Idempotent per (principal, url, name, arguments): a repeat refreshes the TTL and rotates the secret.
 */
export async function subscribe(root, { principal, name, args, url, secret, ttlMs, cursor, maxAgeMs, head, first }) {
  if (!validSecret(secret)) throw new EventError('InvalidParams', { reason: 'delivery.secret must be whsec_ followed by base64 of 24 to 64 bytes' });
  let target;
  try { target = new URL(url); } catch { throw new EventError('InvalidParams', { reason: 'delivery.url is not a URL' }); }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new EventError('InvalidParams', { reason: 'delivery.url must be http or https' });

  const store = await loadSubs(root);
  for (const [key, sub] of Object.entries(store.subs)) if (!alive(sub)) delete store.subs[key]; // expired: reclaimed
  const id = subscriptionId(principal, url, name, args);
  const existing = store.subs[id];
  if (!existing && Object.keys(store.subs).length >= MAX_SUBSCRIPTIONS) throw new EventError('ResourceExhausted', { limit: 'subscriptions', max: MAX_SUBSCRIPTIONS });

  // Where delivery starts. A live subscription whose position is already past the client's cursor ignores it.
  const state = (await readJson(stateFile(root), {}))[id];
  let startSeq = head, truncated = false;
  if (cursor) {
    let seq;
    try { seq = parseCursor(cursor); } catch { throw new EventError('InvalidParams', { reason: 'Invalid cursor' }); }
    startSeq = seq;
    truncated = seq + 1 < first;
    if (truncated) startSeq = first - 1;
  }
  const live = existing && alive(existing) && state;
  const refreshBefore = grant(ttlMs);
  const previous = existing && existing.secret !== secret ? { prevSecret: existing.secret, prevUntil: Date.now() + 300_000 } : {};
  store.subs[id] = { id, principal, url, name, arguments: args ?? {}, secret, refreshBefore, maxAgeMs, refreshedAt: Date.now(),
    startSeq: live ? existing.startSeq : startSeq, createdAt: existing?.createdAt ?? new Date().toISOString(), ...previous };
  await writeJson(subsFile(root), store);
  const status = state ? { active: state.active, lastDeliveryAt: state.lastDeliveryAt ?? null, lastError: state.lastError ?? null,
    ...(state.failedSince ? { failedSince: state.failedSince } : {}) } : undefined;
  return { id, refreshBefore, cursor: cursorOf(state?.watermark ?? startSeq), truncated, ...(existing && status ? { deliveryStatus: status } : {}) };
}

export async function unsubscribe(root, { principal, name, args, url }) {
  const store = await loadSubs(root);
  const id = subscriptionId(principal, url, name, args);
  if (!store.subs[id]) throw new EventError('NotFound', { kind: 'subscription' });
  delete store.subs[id];
  await writeJson(subsFile(root), store);
}

// ---- Delivery loop (monitor host) --------------------------------------------------------------------------------
const MAX_ATTEMPTS = 4, RETRY_WINDOW_MS = 10 * 60_000;

/** Delivers matching events to every live subscription. Returns a stop function. */
export function startEventDelivery(root, { intervalMs = 1000, log = () => {} } = {}) {
  const runtime = new Map(); // id -> { position, pending: [{row, messageId, attempts, firstAt, nextAt, busy}], window: [bool], suspendedAt }
  let busyTick = false;

  async function tick() {
    if (busyTick) return;
    busyTick = true;
    try {
      const { subs } = await loadSubs(root);
      const persisted = await readJson(stateFile(root), {});
      const out = {};
      for (const id of [...runtime.keys()]) if (!subs[id] || !alive(subs[id])) runtime.delete(id);
      for (const sub of Object.values(subs)) {
        if (!alive(sub)) continue;
        let run = runtime.get(sub.id);
        if (!run) runtime.set(sub.id, run = { position: persisted[sub.id]?.position ?? sub.startSeq, pending: [], window: [], suspendedAt: persisted[sub.id]?.suspendedAt });
        // A refresh after suspension reactivates delivery.
        if (run.suspendedAt && sub.refreshedAt > run.suspendedAt) run.suspendedAt = undefined;
        const { head, first, rows } = await readEvents(root, { name: sub.name, afterSeq: run.position, match: matcher(sub) });
        if (run.position + 1 < first) { // retention gap: tell the receiver, then carry on from the oldest retained event
          run.position = first - 1;
          await send(sub, JSON.stringify({ type: 'gap', cursor: cursorOf(first - 1) }), 'msg_gap_' + randomBytes(6).toString('hex'));
        }
        const floor = sub.maxAgeMs ? Date.now() - sub.maxAgeMs : 0;
        for (const row of rows) if (Date.parse(row.timestamp) >= floor && !run.pending.some(p => p.row.seq === row.seq)) {
          run.pending.push({ row, messageId: 'msg_' + randomBytes(12).toString('hex'), attempts: 0, firstAt: Date.now(), nextAt: 0 });
        }
        run.position = Math.max(run.position, head);
        if (!run.suspendedAt) await Promise.all(run.pending.filter(p => p.nextAt <= Date.now() && !p.busy).slice(0, 4).map(p => attempt(sub, run, p)));
        // Watermark: nothing at or before it is still pending, so the client may safely persist it.
        const lowest = run.pending.reduce((m, p) => Math.min(m, p.row.seq), Infinity);
        const watermark = Number.isFinite(lowest) ? lowest - 1 : run.position;
        out[sub.id] = { position: run.position, watermark, active: !run.suspendedAt, lastDeliveryAt: run.lastDeliveryAt ?? persisted[sub.id]?.lastDeliveryAt ?? null,
          lastError: run.lastError ?? null, ...(run.failedSince ? { failedSince: run.failedSince } : {}), ...(run.suspendedAt ? { suspendedAt: run.suspendedAt } : {}) };
      }
      await writeJson(stateFile(root), out);
    } catch (error) { log('Event delivery: ' + error.message); } finally { busyTick = false; }
  }
  const matcher = (sub) => (data) => Object.entries(sub.arguments ?? {}).every(([k, v]) => v === undefined || data[k] === v);

  async function send(sub, body, messageId) {
    const secrets = [sub.secret, ...(sub.prevSecret && sub.prevUntil > Date.now() ? [sub.prevSecret] : [])];
    return post(sub.url, signHeaders({ secrets, subscriptionId: sub.id, messageId, body }), body);
  }

  async function attempt(sub, run, item) {
    item.busy = true;
    const body = JSON.stringify({ eventId: item.row.eventId, name: item.row.name, timestamp: item.row.timestamp, data: item.row.data, cursor: cursorOf(item.row.seq) });
    let result;
    if (Buffer.byteLength(body) > MAX_BODY) result = { status: 413 };
    else result = await send(sub, body, item.messageId);
    item.busy = false;
    const ok = result.status >= 200 && result.status <= 299;
    run.window.push(ok); if (run.window.length > 100) run.window.shift();
    if (ok) { run.lastDeliveryAt = new Date().toISOString(); run.lastError = null; run.failedSince = undefined; run.pending.splice(run.pending.indexOf(item), 1); return; }
    run.lastError = result.error ?? (result.status >= 500 ? 'http_5xx' : 'http_4xx');
    run.failedSince ??= new Date().toISOString();
    item.attempts++;
    // 410 and 413 are final; otherwise back off, then abandon (recoverable by cursor replay).
    if (result.status === 410 || result.status === 413 || item.attempts >= MAX_ATTEMPTS || Date.now() - item.firstAt > RETRY_WINDOW_MS) run.pending.splice(run.pending.indexOf(item), 1);
    else item.nextAt = Date.now() + 1000 * 2 ** item.attempts;
    if (run.window.length >= 100 && run.window.filter(x => !x).length / run.window.length > 0.95) run.suspendedAt = Date.now();
  }

  const timer = setInterval(tick, intervalMs);
  tick();
  return () => clearInterval(timer);
}
