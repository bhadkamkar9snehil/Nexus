import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addPeer } from '../../peers.mjs';
import { handleApi } from '../../peers-api.mjs';

test('LAN peers report reachable Nexus, unreachable and unknown responses without changing pairing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-status-'));
  for (const name of ['online', 'offline', 'unknown']) await addPeer(root, { name, url: `http://${name}:8770`, outbound: 'x'.repeat(24) });
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, 'POST');
    assert.equal(init?.body, '{}');
    if (String(url).includes('offline')) throw new Error('connection refused');
    if (String(url).includes('unknown')) return new Response('other service', { status: 403 });
    return Response.json({ error: 'Invalid or expired code' }, { status: 403 });
  }) as typeof fetch;
  const result = await handleApi(root, 'GET', new URL('http://localhost/api/peers?view=inbox'), {}, { run: async () => null, fetcher });
  const peers = (result.json as { peers: { name: string; online: boolean | null; paired: boolean }[] }).peers;
  assert.deepEqual(peers.map(p => [p.name, p.online, p.paired]), [['online', true, true], ['offline', false, true], ['unknown', null, true]]);
});

test('Tailscale presence is retained and incomplete pairings are not probed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-status-'));
  await addPeer(root, { name: 'tailnet', url: 'http://100.64.0.2:8770', outbound: 'x'.repeat(24) });
  await addPeer(root, { name: 'pending', url: 'http://10.0.0.3:8770' });
  const run = async () => ({ Self: { HostName: 'self', UserID: 1, TailscaleIPs: ['100.64.0.1'] }, Peer: { a: { HostName: 'tailnet', UserID: 1, TailscaleIPs: ['100.64.0.2'], Online: true } } });
  const fetcher = (async () => { throw new Error('unexpected probe'); }) as typeof fetch;
  const result = await handleApi(root, 'GET', new URL('http://localhost/api/peers?view=inbox'), {}, { run, fetcher });
  const peers = (result.json as { peers: { name: string; online: boolean | null }[] }).peers;
  assert.deepEqual(peers.map(p => [p.name, p.online]), [['tailnet', true], ['pending', null]]);
});
