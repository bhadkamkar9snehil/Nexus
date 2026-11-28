import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addPeer, listPeers, readMailbox, receive, sendMessage } from '../../peers.mjs';
import { candidates, cleanAddresses, routeOf } from '../../peer-routes.mjs';

const relay = `https://relay.example/box/${'a'.repeat(64)}/k/${'b'.repeat(43)}`;
async function install(name: string) {
  const root = await mkdtemp(join(tmpdir(), `nexus-route-${name}-`));
  await mkdir(join(root, 'secrets'), { recursive: true });
  await writeFile(join(root, 'secrets', 'peers.json'), JSON.stringify({ self: name, peers: [] }));
  return root;
}

test('addresses are filtered, ordered and named', () => {
  assert.deepEqual(cleanAddresses(['http://10.0.0.5:8770', 'http://127.0.0.1:8770', 'http://169.254.1.1:8770', 'http://evil.example:80', 'file:///x', relay, 7]), ['http://10.0.0.5:8770', relay]);
  assert.deepEqual(candidates({ url: 'http://192.168.1.4:8770', urls: [relay] }), [relay], 'a teammate is reached only through the relay');
  assert.deepEqual(candidates({ own: true, url: 'http://10.0.0.5:8770', urls: [relay, 'http://100.90.0.1:8770', 'http://10.0.0.5:8770'] }), ['http://10.0.0.5:8770', 'http://100.90.0.1:8770', relay]);
  assert.deepEqual(['http://10.0.0.5:8770', 'http://100.90.0.1:8770', relay].map(routeOf), ['lan', 'tailscale', 'relay']);
});

test('a dead address falls through to the next, which is remembered; a retried message is stored once', async () => {
  const a = await install('a'), b = await install('b');
  const inbound = (await addPeer(b, { name: 'a', url: 'http://10.0.0.1:8770' })).inbound;
  await addPeer(a, { name: 'b', url: 'http://10.0.0.2:8770', outbound: inbound });
  await addPeer(a, { name: 'b', url: 'http://100.90.0.2:8770' });
  await addPeer(a, { name: 'b', url: 'http://10.0.0.2:8770' });
  const tried: string[] = [];
  // The first address delivers but loses the answer; the second answers.
  const fetcher = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    tried.push(url);
    const status = await receive(b, init.headers.Authorization, JSON.parse(init.body));
    if (tried.length === 1) throw new Error('connection lost');
    return { ok: status === 200, status };
  }) as never;
  assert.equal((await sendMessage(a, { to: 'b', kind: 'chat', body: 'once' }, fetcher)).delivered, true);
  assert.deepEqual(tried, ['http://10.0.0.2:8770/peer/message', 'http://100.90.0.2:8770/peer/message']);
  assert.equal((await readMailbox(b, { box: 'in' })).length, 1);
  assert.equal((await listPeers(a))[0].route, 'tailscale');
  // The receiver learned the sender's addresses from the message itself.
  const stored = JSON.parse(await readFile(join(b, 'secrets', 'peers.json'), 'utf8')).peers[0];
  assert.ok(stored.urls.length >= 1);
});

test('a paired computer without a relay joins the one a paired peer shares; an unknown caller cannot', async () => {
  const b = await install('b');
  const token = (await addPeer(b, { name: 'a', url: 'http://10.0.0.1:8770' })).inbound;
  const message = { kind: 'chat', body: 'hi', addresses: [relay] };
  assert.equal(await receive(b, 'Bearer ' + 'x'.repeat(48), message), 401);
  await assert.rejects(readFile(join(b, 'secrets', 'relay.json')));
  assert.equal(await receive(b, 'Bearer ' + token, message), 200);
  assert.equal(JSON.parse(await readFile(join(b, 'secrets', 'relay.json'), 'utf8')).url, 'https://relay.example');
});
