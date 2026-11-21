import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { emit } from '../../events.mjs';
import { startEventDelivery } from '../../events-webhooks.mjs';

const Any = z.object({}).passthrough();
const dir = await mkdtemp(join(tmpdir(), 'nexus-delivery-'));
process.env.NEXUS_EVENTS_DIR = dir;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (check: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await sleep(50); } };

// A real https receiver with a self-signed certificate that this test (and the server it spawns) trusts.
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
const cert = await readFile(join(dir, 'cert.pem'), 'utf8');
https.globalAgent.options.ca = cert;
process.env.NODE_EXTRA_CA_CERTS = join(dir, 'cert.pem');

type Hit = { headers: Record<string, string | string[] | undefined>; body: string; valid: boolean; json: any };
const hits: Hit[] = [];
let secret = 'whsec_' + randomBytes(32).toString('base64');
let secrets = [secret];
let respond: (json: any) => { status: number; body?: string } = () => ({ status: 200 });
const receiver = https.createServer({ key: await readFile(join(dir, 'key.pem')), cert }, (req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const id = String(req.headers['webhook-id']), ts = String(req.headers['webhook-timestamp']);
    const signatures = String(req.headers['webhook-signature']).split(' ');
    const valid = secrets.some(s => signatures.includes('v1,' + createHmac('sha256', Buffer.from(s.slice(6), 'base64')).update(`${id}.${ts}.${body}`).digest('base64')))
      && Math.abs(Date.now() / 1000 - Number(ts)) < 300;
    const json = JSON.parse(body);
    hits.push({ headers: req.headers, body, valid, json });
    const reply = respond(json);
    res.writeHead(reply.status).end(reply.body ?? '');
  });
});
await new Promise<void>(r => receiver.listen(0, '127.0.0.1', r));
const url = `https://127.0.0.1:${(receiver.address() as { port: number }).port}/hooks/nexus`;
const stop = startEventDelivery('', { intervalMs: 150, log: m => console.error(m) });
after(() => { stop(); receiver.close(); });
respond = () => ({ status: 200 });

const client = new Client({ name: 'nexus-delivery-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, '..', 'start.mjs')], env: process.env as Record<string, string>, stderr: 'ignore' }));
after(() => client.close());
const call = (method: string, params: Record<string, unknown>) => client.request({ method, params }, Any) as Promise<any>;
const subscribe = (extra: Record<string, unknown> = {}, args: Record<string, unknown> = {}) =>
  call('events/subscribe', { name: 'gitlab.event', arguments: args, delivery: { mode: 'webhook', url, secret }, ...extra });
const deliveries = () => hits.filter(h => !h.json.type);

test('push: events/stream sends active, events and heartbeats until cancelled', async () => {
  const seen: { method: string; params: any }[] = [];
  for (const m of ['active', 'event', 'heartbeat']) client.setNotificationHandler(`notifications/events/${m}`, { params: Any }, (params: any) => { seen.push({ method: m, params }); });
  const abort = new AbortController();
  const stream = call('events/stream', { name: 'gitlab.event', cursor: null, heartbeatMs: 1000 });
  void stream.catch(() => {});
  const controlled = client.request({ method: 'events/stream', params: { name: 'gitlab.event', cursor: null, heartbeatMs: 1000 } }, Any, { signal: abort.signal });
  void controlled.catch(() => {});
  await until(() => seen.filter(s => s.method === 'active').length >= 2);
  const active = seen.find(s => s.method === 'active')!.params;
  assert.match(active.cursor, /^s\d+$/);
  assert.equal(active.truncated, false);
  assert.equal(active.heartbeatMs, 1000);
  assert.ok(active._meta['io.modelcontextprotocol/subscriptionId'] !== undefined);
  await emit('', { name: 'gitlab.event', eventId: 'push-1', data: { kind: 'pipeline', project: 'ssm/a', title: 'Passed' } });
  await until(() => seen.some(s => s.method === 'event'));
  const event = seen.find(s => s.method === 'event')!.params;
  assert.equal(event.eventId, 'push-1');
  assert.equal(event.data.title, 'Passed');
  assert.match(event.cursor, /^s\d+$/);
  await until(() => seen.some(s => s.method === 'heartbeat'), 5000);
  abort.abort();
  await assert.rejects(controlled);
  // The other stream is unaffected by cancelling one.
  const before = seen.length;
  await emit('', { name: 'gitlab.event', eventId: 'push-2', data: { kind: 'issue', project: 'ssm/a', title: 'Opened' } });
  await until(() => seen.length > before);
});

test('webhook: subscribe then delivers signed events with a safe cursor', async () => {
  hits.length = 0;
  const grant = await subscribe({ ttlMs: 600_000 });
  assert.match(grant.id, /^sub_[0-9a-f]{16}$/);
  assert.ok(Date.parse(grant.refreshBefore) > Date.now());
  assert.match(grant.cursor, /^s\d+$/);
  assert.equal(grant.truncated, false);

  await emit('', { name: 'gitlab.event', eventId: 'hook-1', data: { kind: 'release', project: 'ssm/a', title: 'v1' } });
  await until(() => deliveries().length === 1);
  const hit = deliveries()[0];
  assert.ok(hit.valid, 'HMAC over the raw body verifies');
  assert.equal(hit.headers['x-mcp-subscription-id'], grant.id);
  assert.match(String(hit.headers['webhook-id']), /^msg_[A-Za-z0-9_-]+$/);
  assert.equal(hit.headers['content-type'], 'application/json');
  assert.equal(hit.json.eventId, 'hook-1');
  assert.equal(hit.json.name, 'gitlab.event');
  assert.equal(hit.json.data.title, 'v1');
  assert.match(hit.json.cursor, /^s\d+$/);

  // Refresh is idempotent: same id, fresh TTL, delivery status reported.
  await sleep(400);
  const again = await subscribe({ ttlMs: 600_000, cursor: grant.cursor });
  assert.equal(again.id, grant.id);
  assert.equal(again.deliveryStatus.active, true);
  assert.ok(again.deliveryStatus.lastDeliveryAt);
  assert.equal(deliveries().length, 1, 'a refresh with a stale cursor does not replay a live subscription');
});

test('webhook: arguments filter, failures retry under the same webhook-id, 410 is final, rotation dual-signs', async () => {
  // Drop the unfiltered subscription from the previous test so only the filtered one is live.
  await call('events/unsubscribe', { name: 'gitlab.event', arguments: {}, delivery: { url } });
  hits.length = 0;
  await subscribe({}, { kind: 'issue' });
  await emit('', { name: 'gitlab.event', eventId: 'f-skip', data: { kind: 'pipeline', project: 'p', title: 'skip' } });
  await emit('', { name: 'gitlab.event', eventId: 'f-issue', data: { kind: 'issue', project: 'p', title: 'issue' } });
  await until(() => deliveries().some(h => h.json.eventId === 'f-issue'));
  assert.ok(!deliveries().some(h => h.json.eventId === 'f-skip'), 'a non-matching event is not delivered');

  // A failing endpoint is retried with the same webhook-id and a regenerated timestamp/signature.
  hits.length = 0;
  let failures = 1;
  respond = () => failures-- > 0 ? { status: 503 } : { status: 200 };
  await emit('', { name: 'gitlab.event', eventId: 'retry-1', data: { kind: 'issue', project: 'p', title: 'retry' } });
  await until(() => deliveries().filter(h => h.json.eventId === 'retry-1').length >= 2, 10_000);
  const tries = deliveries().filter(h => h.json.eventId === 'retry-1');
  assert.equal(tries[0].headers['webhook-id'], tries[1].headers['webhook-id']);
  assert.ok(tries.every(t => t.valid));

  // 410 Gone: the delivery is abandoned, not retried.
  hits.length = 0;
  respond = () => ({ status: 410 });
  await emit('', { name: 'gitlab.event', eventId: 'gone-1', data: { kind: 'issue', project: 'p', title: 'gone' } });
  await until(() => deliveries().some(h => h.json.eventId === 'gone-1'));
  await sleep(2600);
  assert.equal(deliveries().filter(h => h.json.eventId === 'gone-1').length, 1);

  // Secret rotation: the refresh supplies a new secret; deliveries verify under it (and the old one for a grace window).
  const old = secret;
  secret = 'whsec_' + randomBytes(32).toString('base64');
  secrets = [secret, old];
  respond = () => ({ status: 200 });
  await subscribe({}, { kind: 'issue' });
  hits.length = 0;
  await emit('', { name: 'gitlab.event', eventId: 'rot-1', data: { kind: 'issue', project: 'p', title: 'rotated' } });
  await until(() => deliveries().some(h => h.json.eventId === 'rot-1'));
  const rotated = deliveries().find(h => h.json.eventId === 'rot-1')!;
  assert.ok(rotated.valid);
  assert.equal(String(rotated.headers['webhook-signature']).split(' ').length, 2, 'dual-signed during the grace window');
  secrets = [secret];
});

test('webhook: unsubscribe stops delivery; errors use the spec codes', async () => {
  const gone = await call('events/unsubscribe', { name: 'gitlab.event', arguments: { kind: 'issue' }, delivery: { url } });
  assert.ok(gone, 'unsubscribe returns an empty result');
  hits.length = 0;
  await emit('', { name: 'gitlab.event', eventId: 'after-unsub', data: { kind: 'issue', project: 'p', title: 'x' } });
  await sleep(1200);
  assert.equal(deliveries().filter(h => h.json.eventId === 'after-unsub').length, 0, 'no delivery after unsubscribe');
  await assert.rejects(call('events/unsubscribe', { name: 'gitlab.event', arguments: { kind: 'issue' }, delivery: { url } }), (e: any) => e.code === -32023 && e.data?.kind === 'subscription');
  await assert.rejects(subscribe({ delivery: { mode: 'webhook', url, secret: 'whsec_c2hvcnQ=' } }), (e: any) => e.code === -32602);
  await assert.rejects(call('events/subscribe', { name: 'nope', delivery: { mode: 'webhook', url, secret } }), (e: any) => e.code === -32023);
});

test('any http or https callback works: plain http, loopback and private addresses are not restricted', async () => {
  const got: { headers: Record<string, string | string[] | undefined>; json: any }[] = [];
  const plain = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { got.push({ headers: req.headers, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); res.writeHead(200).end(); });
  });
  await new Promise<void>(r => plain.listen(0, '0.0.0.0', r));
  const port = (plain.address() as { port: number }).port;
  try {
    const grant = await call('events/subscribe', { name: 'peer.message', delivery: { mode: 'webhook', url: `http://127.0.0.1:${port}/agent`, secret } });
    assert.match(grant.id, /^sub_/);
    await emit('', { name: 'peer.message', eventId: 'plain-1', data: { messageId: 'plain-1', from: 'mahesh', kind: 'chat', subject: 'hello' } });
    await until(() => got.length === 1);
    assert.equal(got[0].json.eventId, 'plain-1');
    assert.equal(got[0].headers['x-mcp-subscription-id'], grant.id);
    assert.ok(String(got[0].headers['webhook-signature']).startsWith('v1,'));
    // Unreachable callbacks are accepted at subscribe time (nothing is verified up front); delivery just fails and retries.
    assert.match((await call('events/subscribe', { name: 'peer.message', delivery: { mode: 'webhook', url: 'http://10.255.255.1:9/x', secret } })).id, /^sub_/);
  } finally { plain.close(); }
});
