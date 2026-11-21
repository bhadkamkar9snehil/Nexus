import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { emit } from '../../events.mjs';

const Any = z.object({}).passthrough();
const dir = await mkdtemp(join(tmpdir(), 'nexus-channel-'));
process.env.NEXUS_EVENTS_DIR = dir;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (check: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await sleep(50); } };

async function connect(name: string) {
  const client = new Client({ name, version: '1.0.0' }); // Claude Code speaks the initialize handshake
  const seen: any[] = [];
  client.setNotificationHandler('notifications/claude/channel', { params: Any }, (params: any) => { seen.push(params); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, '..', 'start.mjs')], env: process.env as Record<string, string>, stderr: 'ignore' }));
  after(() => client.close());
  return { client, seen };
}

test('Claude Code receives peer messages and GitLab releases as channel events, other kinds stay quiet', async () => {
  const { client, seen } = await connect('claude-code');
  assert.ok((client.getServerCapabilities() as any).experimental?.['claude/channel']);
  assert.match(String(client.getInstructions()), /nexus_mail/);
  await sleep(1500); // the channel starts at the current end of the log
  await emit('', { name: 'peer.message', eventId: 'm1', data: { messageId: 'm1', from: 'pc', kind: 'chat', subject: 'build done' } });
  await emit('', { name: 'gitlab.event', eventId: 'g1', data: { kind: 'push', project: 'ssm/shared-computer-use', title: 'push noise' } });
  await emit('', { name: 'gitlab.event', eventId: 'g2', data: { kind: 'release', project: 'ssm/shared-computer-use', title: 'Nexus Harness 1.15.0' } });
  await until(() => seen.length >= 2);
  await sleep(1500);
  assert.deepEqual(seen.map(s => s.content), ['chat from pc: build done', 'release in ssm/shared-computer-use: Nexus Harness 1.15.0']);
  assert.deepEqual(seen[0].meta, { event: 'peer.message', kind: 'chat', from: 'pc', message_id: 'm1' });
});

test('other clients never receive channel notifications', async () => {
  const { seen } = await connect('some-other-agent');
  await sleep(1500);
  await emit('', { name: 'peer.message', eventId: 'm2', data: { messageId: 'm2', from: 'pc', kind: 'mail', subject: 'ignored' } });
  await sleep(2500);
  assert.equal(seen.length, 0);
});
