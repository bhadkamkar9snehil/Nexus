import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { emit } from '../../events.mjs';

const start = join(import.meta.dirname, '..', 'start.mjs');
const Any = z.object({}).passthrough();
process.env.NEXUS_EVENTS_DIR = await mkdtemp(join(tmpdir(), 'nexus-events-'));

const connect = async (options?: ConstructorParameters<typeof Client>[1]) => {
  const client = new Client({ name: 'nexus-modern-test', version: '1.0.0' }, options);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [start], env: process.env as Record<string, string>, stderr: 'ignore' }));
  return client;
};
const modern = () => connect({ versionNegotiation: { mode: { pin: '2026-07-28' } } });
const poll = (client: Client, params: Record<string, unknown>) => client.request({ method: 'events/poll', params }, Any) as Promise<any>;

test('Nexus serves the 2026-07-28 revision and the 2025-era handshake from one server', async () => {
  const client = await modern();
  try {
    assert.equal(client.getProtocolEra(), 'modern');
    assert.ok((await client.listTools()).tools.some(t => t.name === 'search_status'));
    assert.ok(client.getServerCapabilities()?.extensions?.['io.modelcontextprotocol/events'], 'events extension advertised');
  } finally { await client.close(); }
  const legacy = await connect();
  try {
    assert.equal(legacy.getProtocolEra(), 'legacy');
    assert.ok((await legacy.listTools()).tools.length > 10);
  } finally { await legacy.close(); }
});

test('events/list describes each event type with schemas and its delivery modes', async () => {
  const client = await modern();
  try {
    const list = await client.request({ method: 'events/list', params: {} }, Any) as any;
    const names = list.events.map((e: any) => e.name).sort();
    assert.deepEqual(names, ['gitlab.event', 'peer.message']);
    for (const e of list.events) {
      assert.deepEqual(e.delivery, ['poll', 'push', 'webhook']);
      assert.equal(e.inputSchema.type, 'object');
      assert.equal(e.payloadSchema.type, 'object');
    }
  } finally { await client.close(); }
});

test('events/poll follows the cursor, filters, pages, bounds by age and reports spec error codes', async () => {
  const client = await modern();
  try {
    const start = await poll(client, { name: 'gitlab.event', cursor: null });
    assert.deepEqual(start.events, []);
    assert.match(start.cursor, /^s\d+$/);
    assert.equal(start.truncated, false);
    assert.ok(start.nextPollMs >= 1000);

    await emit('', { name: 'gitlab.event', eventId: 'uuid-1', data: { kind: 'pipeline', project: 'ssm/a', title: 'Pipeline passed' } });
    await emit('', { name: 'gitlab.event', eventId: 'uuid-2', data: { kind: 'issue', project: 'ssm/b', title: 'Issue opened' } });
    await emit('', { name: 'peer.message', eventId: 'm-1', data: { messageId: 'm-1', from: 'mahesh', kind: 'mail', subject: 'Hi' } });

    const all = await poll(client, { name: 'gitlab.event', cursor: start.cursor });
    assert.deepEqual(all.events.map((e: any) => e.eventId), ['uuid-1', 'uuid-2']);
    assert.equal(all.events[0].data.title, 'Pipeline passed');
    assert.ok(Date.parse(all.events[0].timestamp) > 0);
    assert.equal(all.hasMore, false);

    // Nothing new on the next poll with the returned cursor.
    assert.deepEqual((await poll(client, { name: 'gitlab.event', cursor: all.cursor })).events, []);

    // Subscription arguments filter the stream.
    const issues = await poll(client, { name: 'gitlab.event', arguments: { kind: 'issue' }, cursor: start.cursor });
    assert.deepEqual(issues.events.map((e: any) => e.eventId), ['uuid-2']);
    const mine = await poll(client, { name: 'peer.message', arguments: { from: 'mahesh' }, cursor: start.cursor });
    assert.equal(mine.events.length, 1);

    // maxEvents pages with hasMore and an intermediate cursor that loses nothing.
    const first = await poll(client, { name: 'gitlab.event', cursor: start.cursor, maxEvents: 1 });
    assert.equal(first.hasMore, true);
    assert.deepEqual(first.events.map((e: any) => e.eventId), ['uuid-1']);
    const second = await poll(client, { name: 'gitlab.event', cursor: first.cursor, maxEvents: 1 });
    assert.deepEqual(second.events.map((e: any) => e.eventId), ['uuid-2']);
    assert.equal(second.hasMore, false);

    // maxAgeMs drops older events and says so.
    await new Promise(r => setTimeout(r, 50));
    const bounded = await poll(client, { name: 'gitlab.event', cursor: start.cursor, maxAgeMs: 1 });
    assert.deepEqual(bounded.events, []);
    assert.equal(bounded.truncated, true);

    // Errors use the spec codes.
    await assert.rejects(poll(client, { name: 'nope', cursor: null }), (e: any) => e.code === -32023);
    await assert.rejects(poll(client, { name: 'gitlab.event', arguments: { kind: 'bogus' }, cursor: null }), (e: any) => e.code === -32602);
    await assert.rejects(poll(client, { name: 'gitlab.event', cursor: 'garbage' }), (e: any) => e.code === -32602);
  } finally { await client.close(); }
});

test('2025-era clients can call the extension methods and the nexus_events tool', async () => {
  const client = await connect();
  try {
    const list = await client.request({ method: 'events/list', params: {} }, Any) as any;
    assert.equal(list.events.length, 2);
    const call = async (args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name: 'nexus_events', arguments: args })).content as { text: string }[])[0].text);
    const begin = await call({ action: 'poll', name: 'peer.message', cursor: null });
    await emit('', { name: 'peer.message', eventId: 'm-tool', data: { messageId: 'm-tool', from: 'mahesh', kind: 'chat', subject: '' } });
    const next = await call({ action: 'poll', name: 'peer.message', cursor: begin.cursor });
    assert.deepEqual(next.events.map((e: any) => e.eventId), ['m-tool']);
    assert.equal((await call({ action: 'list' })).events.length, 2);
  } finally { await client.close(); }
});
