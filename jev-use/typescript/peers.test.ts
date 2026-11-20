import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addPeer, listPeers, markRead, readMailbox, receive, sendMessage, setPeer } from '../../peers.mjs';

async function pair() {
  const a = await mkdtemp(join(tmpdir(), 'nexus-a-'));
  const b = await mkdtemp(join(tmpdir(), 'nexus-b-'));
  // Each side gets the other's inbound token as its outbound token.
  const bOnA = await addPeer(a, { name: 'mahesh', url: 'http://b:8770', outbound: 'x'.repeat(24) });
  const aOnB = await addPeer(b, { name: 'snehil', url: 'http://a:8770', outbound: bOnA.inbound });
  await addPeer(a, { name: 'mahesh', url: 'http://b:8770', outbound: aOnB.inbound });
  // The "network": a fetch that hands the request to the other install's receiver.
  const fetcher = async (_url: string, init: { headers: Record<string, string>; body: string }) => {
    const status = await receive(b, init.headers.Authorization, JSON.parse(init.body), undefined);
    return { ok: status === 200, status };
  };
  return { a, b, fetcher: fetcher as unknown as typeof fetch };
}

test('mail travels peer to peer and lands in the other mailbox', async () => {
  const { a, b, fetcher } = await pair();
  const sent = await sendMessage(a, { to: 'mahesh', subject: 'Heat plan', body: 'Please review' }, fetcher);
  assert.equal(sent.delivered, true);
  const inbox = await readMailbox(b, { box: 'in' });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].peer, 'snehil');
  assert.equal(inbox[0].body, 'Please review');
  assert.equal((await readMailbox(a, { box: 'out' })).length, 1);
  await markRead(b, [inbox[0].id]);
  assert.equal((await readMailbox(b, { box: 'in', unread: true })).length, 0);
});

test('a switched-off peer or denied kind blocks sending and receiving', async () => {
  const { a, b, fetcher } = await pair();
  await setPeer(a, 'mahesh', { allow: { chat: false } });
  await assert.rejects(sendMessage(a, { to: 'mahesh', kind: 'chat', body: 'hi' }, fetcher), /not permitted/);
  await setPeer(a, 'mahesh', { enabled: false });
  await assert.rejects(sendMessage(a, { to: 'mahesh', body: 'hi' }, fetcher), /switched off/);
  await setPeer(a, 'mahesh', { enabled: true });
  await setPeer(b, 'snehil', { allow: { mail: false } });
  await assert.rejects(sendMessage(a, { to: 'mahesh', body: 'hi' }, fetcher), /refused the message \(403\)/);
  assert.deepEqual((await listPeers(a)).map(p => p.name), ['mahesh']);
});

test('unknown tokens are rejected and tokens are never listed', async () => {
  const { b } = await pair();
  assert.equal(await receive(b, 'Bearer nope', { kind: 'mail', body: 'x' }, undefined), 401);
  assert.ok(!JSON.stringify(await listPeers(b)).includes('inbound'));
});
