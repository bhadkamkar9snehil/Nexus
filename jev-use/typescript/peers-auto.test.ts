import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPairingCode, discoverAndPair, handleHello, handlePair, pairWithCode } from '../../peers-auto.mjs';
import { addPeer, getPeer, listPeers, readMailbox, selfName, sendMessage, setPeer } from '../../peers.mjs';
import { respondTo } from '../../agent-responder.mjs';

const OWNER = 1, OTHER = 2;
// A fake tailnet as seen from one device: Self plus peers with owners, online state and OS.
const tailnetFor = (self: { name: string; ip: string }, others: { name: string; ip: string; user: number; online?: boolean; os?: string }[]) => async () => ({
  Self: { HostName: self.name, UserID: OWNER, TailscaleIPs: [self.ip, 'fd7a::1'], Online: true, OS: 'windows' },
  Peer: Object.fromEntries(others.map(o => [o.name, { HostName: o.name, UserID: o.user, TailscaleIPs: [o.ip], Online: o.online ?? true, OS: o.os ?? 'windows' }])),
});
async function install(name: string) {
  const root = await mkdtemp(join(tmpdir(), `nexus-${name}-`));
  await mkdir(join(root, 'secrets'), { recursive: true });
  await writeFile(join(root, 'secrets', 'peers.json'), JSON.stringify({ self: name, peers: [] }));
  return root;
}

test('own devices pair automatically from Tailscale identity, with no code or token typed', async () => {
  const laptop = await install('laptop'), pc = await install('b19cl3pc');
  const roots: Record<string, { root: string; run: () => Promise<unknown>; ip: string }> = {
    'http://100.0.0.2:8770': { root: pc, ip: '100.0.0.2', run: tailnetFor({ name: 'b19cl3pc', ip: '100.0.0.2' }, [{ name: 'laptop', ip: '100.0.0.1', user: OWNER }]) },
  };
  // The laptop's HTTP call to the PC's /peer/hello, arriving from the laptop's tailnet address.
  const fetcher = async (url: string, init: { body: string }) => {
    const target = roots[url.replace('/peer/hello', '')];
    const reply = await handleHello(target.root, '100.0.0.1', JSON.parse(init.body), target.run as never);
    return { ok: reply.status === 200, status: reply.status, json: async () => reply.json };
  };
  const run = tailnetFor({ name: 'laptop', ip: '100.0.0.1' }, [
    { name: 'b19cl3pc', ip: '100.0.0.2', user: OWNER },
    { name: 'colleague-pc', ip: '100.0.0.3', user: OTHER },   // someone else's device: never auto-paired
    { name: 'iphone', ip: '100.0.0.4', user: OWNER, os: 'iOS' }, { name: 'pi', ip: '100.0.0.6', user: OWNER, os: 'linux' }, // phones and Linux boxes do not run Nexus
    { name: 'sleeping-pc', ip: '100.0.0.5', user: OWNER, online: false },
  ]);
  const paired = await discoverAndPair(laptop, { run: run as never, fetcher: fetcher as never });
  assert.deepEqual(paired, ['b19cl3pc']);
  assert.deepEqual((await listPeers(laptop)).map(p => [p.name, p.paired, p.own]), [['b19cl3pc', true, true]]);
  assert.deepEqual((await listPeers(pc)).map(p => [p.name, p.paired, p.own]), [['laptop', true, true]]);

  // Both directions work immediately.
  const post = async (from: string, to: string, fromRoot: string, toRoot: string) => sendMessage(fromRoot, { to, kind: 'chat', body: 'hi from ' + from }, (async (_u: string, init: { headers: Record<string, string>; body: string }) => {
    const { receive } = await import('../../peers.mjs');
    const status = await receive(toRoot, init.headers.Authorization, JSON.parse(init.body), undefined);
    return { ok: status === 200, status };
  }) as never);
  assert.equal((await post('laptop', 'b19cl3pc', laptop, pc)).delivered, true);
  assert.equal((await post('b19cl3pc', 'laptop', pc, laptop)).delivered, true);
  assert.equal((await readMailbox(pc, { box: 'in' }))[0].body, 'hi from laptop');

  // A second pass changes nothing and does not contact paired devices again.
  assert.deepEqual(await discoverAndPair(laptop, { run: run as never, fetcher: (async () => { throw new Error('must not be called'); }) as never }), []);
});

test('hello is refused for devices of another account, without Tailscale, and for unreachable devices it leaves no half-pair', async () => {
  const pc = await install('b19cl3pc');
  const run = tailnetFor({ name: 'b19cl3pc', ip: '100.0.0.2' }, [{ name: 'colleague-pc', ip: '100.0.0.3', user: OTHER }, { name: 'laptop', ip: '100.0.0.1', user: OWNER }]);
  const body = { name: 'colleague-pc', token: 'x'.repeat(32) };
  assert.equal((await handleHello(pc, '100.0.0.3', body, run as never)).status, 403);
  assert.equal((await handleHello(pc, '203.0.113.9', body, run as never)).status, 403, 'an address not on the tailnet');
  assert.equal((await handleHello(pc, '100.0.0.1', body, (async () => null) as never)).status, 403, 'Tailscale stopped');
  assert.equal((await handleHello(pc, '100.0.0.1', { name: 'laptop', token: 'short' }, run as never)).status, 400);
  assert.deepEqual(await listPeers(pc), []);

  const laptop = await install('laptop');
  const refused = (async () => { throw new Error('connect ECONNREFUSED'); }) as never;
  const lrun = tailnetFor({ name: 'laptop', ip: '100.0.0.1' }, [{ name: 'b19cl3pc', ip: '100.0.0.2', user: OWNER }]);
  assert.deepEqual(await discoverAndPair(laptop, { run: lrun as never, fetcher: refused }), []);
  assert.deepEqual(await listPeers(laptop), [], 'a device without Nexus leaves nothing behind');
});

test('a pairing code pairs two computers once and carries the addresses', async () => {
  const teammate = await install('dhaval-pc'), mine = await install('laptop');
  const run = (async () => null) as never; // no Tailscale: LAN addresses only
  const { code } = await createPairingCode(mine, run, false);
  assert.match(code, /^nexus-[\w-]+$/);
  const decoded = JSON.parse(Buffer.from(code.slice(6), 'base64url').toString());
  assert.equal(decoded.n, 'laptop');
  assert.ok(decoded.a.every((u: string) => /^http:\/\/\d+\.\d+\.\d+\.\d+:8770$/.test(u)));

  const fetcher = (async (_url: string, init: { body: string }) => {
    const reply = await handlePair(mine, '10.2.6.50', JSON.parse(init.body));
    return { ok: reply.status === 200, status: reply.status, json: async () => reply.json };
  }) as never;
  const pairedWith = await pairWithCode(teammate, code, { fetcher, autoReply: true });
  assert.equal((await listPeers(mine))[0].responder?.enabled, false);
  assert.equal((await listPeers(teammate))[0].responder?.enabled, true);
  assert.equal(pairedWith.name, 'laptop');
  assert.deepEqual((await listPeers(mine)).map(p => [p.name, p.paired, p.own]), [['dhaval-pc', true, false]], 'a code-paired device is not an own device');
  assert.deepEqual((await listPeers(teammate)).map(p => [p.name, p.paired]), [['laptop', true]]);
  await assert.rejects(pairWithCode(await install('mahesh-pc'), code, { fetcher }), /refused|expired|already used/, 'single use');
  await assert.rejects(pairWithCode(await install('x'), 'nexus-bm90LWEtY29kZQ', { fetcher }), /not a Nexus pairing code/);
  assert.deepEqual(await listPeers(await install('y')), []);
});

test('the agent responder answers chat from own devices, stops at NO_REPLY and the hop limit, and ignores everyone else', async () => {
  const root = await install('pc');
  await addPeer(root, { name: 'laptop', url: 'http://100.0.0.1:8770', outbound: 'o'.repeat(24), own: true });
  await addPeer(root, { name: 'stranger', url: 'http://10.0.0.9:8770', outbound: 'p'.repeat(24) });
  const agent = join(root, 'agent.cjs');
  // The "agent": echoes the incoming text, or says NO_REPLY when the message is a thanks.
  await writeFile(agent, "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const b=(s.match(/\\n\\n([\\s\\S]*?)\\n\\nDo what/)||[])[1]||'';process.stdout.write(/thanks/i.test(b)?'NO_REPLY':'Done: '+b)})");
  await writeFile(join(root, 'secrets', 'agent-responder.json'), JSON.stringify({ command: process.execPath, args: [agent], maxHops: 3 }));
  const sent: { to: string; body: string; hop?: number; kind: string }[] = [];
  const send = (async (_r: string, m: { to: string; body: string; hop?: number; kind: string }) => { sent.push(m); return {}; }) as never;
  const msg = (over: object) => ({ id: Math.random().toString(16).slice(2), peer: 'laptop', kind: 'chat', subject: 's', body: 'build the release', ...over });

  assert.equal(await respondTo(root, msg({}), { send }), 'replied');
  assert.deepEqual(sent.map(m => [m.to, m.kind, m.hop]), [['laptop', 'chat', 1]]);
  assert.equal(sent[0].body, 'Done: build the release');
  assert.equal(await respondTo(root, msg({ body: 'ok thanks!' }), { send }), 'finished');
  assert.equal(await respondTo(root, msg({ hop: 3 }), { send }), 'hop limit reached');
  assert.equal(await respondTo(root, msg({ peer: 'stranger' }), { send }), 'replied'); // every connected peer is answered, not only own devices
  assert.equal(await respondTo(root, msg({ peer: 'nobody' }), { send }), 'peer is not an enabled chat peer');
  assert.equal(await respondTo(root, msg({ kind: 'mail' }), { send }), 'not a chat message');
  await writeFile(join(root, 'secrets', 'agent-responder.json'), JSON.stringify({ enabled: false }));
  assert.equal(await respondTo(root, msg({}), { send }), 'disabled');
  assert.equal(sent.length, 2);
});

test('setPeer, getPeer and selfName behave', async () => {
  const root = await install('Some Laptop!');
  assert.equal(await selfName(root), 'some-laptop-');
  await addPeer(root, { name: 'a', url: 'http://1.2.3.4:8770' });
  assert.equal((await getPeer(root, 'a'))?.paired, false);
  await setPeer(root, 'a', { outbound: 'z'.repeat(20) });
  assert.equal((await getPeer(root, 'a'))?.paired, true);
  assert.equal(await getPeer(root, 'missing'), null);
});
