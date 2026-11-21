import { test, after } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { addPeer, sendMessage, setPeer } from '../../peers.mjs';

process.env.NEXUS_NOTIFY = '0';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Two installations on one machine: laptop A sends, laptop B receives over real HTTP and its agent waits on the mailbox.
const rootA = await mkdtemp(join(tmpdir(), 'nexus-laptop-a-'));
const rootB = await mkdtemp(join(tmpdir(), 'nexus-laptop-b-'));
await mkdir(join(rootB, 'secrets'), { recursive: true });
const { startWebhook } = await import('../../webhook.mjs');
const receiver = await startWebhook(rootB, { host: '127.0.0.1', port: 0 });
await once(receiver, 'listening');
after(() => { receiver.close(); });
const address = receiver.address();
assert.ok(address && typeof address !== 'string');
const url = `http://127.0.0.1:${address.port}`;

const client = new Client({ name: 'laptop-b-agent', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
await client.connect(new StdioClientTransport({
  command: process.execPath, args: [join(import.meta.dirname, '..', 'start.mjs')], stderr: 'ignore',
  env: { ...process.env, NEXUS_PEERS_DIR: join(rootB, 'secrets'), NEXUS_EVENTS_DIR: join(rootB, 'secrets') } as Record<string, string>,
}));
after(() => client.close());
const tool = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);

test('two-step pairing, then a message from laptop A reaches laptop B\'s waiting agent in real time', async () => {
  // Pairing: each side adds the other, hands over the returned token, then sets the token it received.
  const a = await addPeer(rootA, { name: 'laptop-b', url });
  const b = await tool('nexus_peers', { action: 'add', name: 'laptop-a', url: 'http://127.0.0.1:1', outbound_token: a.inbound });
  await assert.rejects(sendMessage(rootA, { to: 'laptop-b', body: 'too early' }), /Pairing is incomplete/);
  await setPeer(rootA, 'laptop-b', { outbound: b.peer.inbound });

  const started = Date.now();
  const waiting = tool('nexus_mail', { action: 'wait', timeout_ms: 20000 });
  await sleep(700);
  await sendMessage(rootA, { to: 'laptop-b', kind: 'chat', subject: 'sync', body: 'ping from laptop A' });
  const got = await waiting;
  assert.equal(got.result, 'message');
  assert.equal(got.messages[0].body, 'ping from laptop A');
  assert.equal(got.messages[0].peer, 'laptop-a');
  assert.ok(Date.now() - started < 5000, 'delivered within seconds, not on a poll interval');

  // The same arrival is an event: agents on laptop B can also follow it through nexus_events / MCP events.
  const events = await tool('nexus_events', { action: 'poll', name: 'peer.message', cursor: 's0' });
  assert.equal(events.events.at(-1).data.from, 'laptop-a');
  assert.equal(events.events.at(-1).data.kind, 'chat');

  // A reply travels the other way once B knows A's token and url.
  await tool('nexus_mail', { action: 'mark_read', ids: [got.messages[0].id] });
  assert.equal((await tool('nexus_mail', { action: 'wait', timeout_ms: 1000 })).result, 'timeout');
});
