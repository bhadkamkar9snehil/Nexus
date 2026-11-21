// JSON API behind the Peers page of the monitor UI (loopback only, same-origin requests with an X-Nexus header).
import { createPairingCode, discoverAndPair, localAddresses, pairWithCode, runTailscale, tailnet } from './peers-auto.mjs';
import { listPeers, mailboxSummary, markRead, readMailbox, removePeer, selfName, sendMessage, setPeer } from './peers.mjs';
import { loadResponderConfig, saveResponderConfig } from './agent-responder.mjs';
import { firewall } from './firewall.mjs';

const fail = (status, message) => ({ status, json: { error: message } });
const responderState = ({ enabled, autonomy }) => ({ enabled, autonomy });

/** Handles one /api/ request. `body` is the parsed JSON body (or {}). */
export async function handleApi(root, method, url, body, { run = runTailscale } = {}) {
  const path = url.pathname;
  try {
    if (method === 'GET' && path === '/api/peers') {
      const net = await tailnet(run);
      const peers = (await listPeers(root)).map(p => {
        const ip = new URL(p.url).hostname;
        const device = net?.devices.find(d => d.ip === ip);
        return { ...p, online: device ? device.online : null, os: device?.os ?? null };
      });
      return { status: 200, json: { self: { name: await selfName(root), addresses: await localAddresses(run), tailscale: Boolean(net) }, firewall: await firewall(), peers, responder: responderState(await loadResponderConfig(root)) } };
    }
    if (method === 'GET' && path === '/api/mail') {
      if (url.searchParams.has('summary')) return { status: 200, json: { threads: await mailboxSummary(root) } };
      const peer = url.searchParams.get('peer');
      const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 200);
      const all = [...await readMailbox(root, { box: 'in', peer, limit }), ...await readMailbox(root, { box: 'out', peer, limit })]
        .sort((a, b) => a.at - b.at).slice(-limit);
      return { status: 200, json: { messages: all } };
    }
    if (method === 'GET' && path === '/api/responder') return { status: 200, json: responderState(await loadResponderConfig(root)) };
    if (method !== 'POST') return fail(404, 'Not found');

    if (path === '/api/peers/code') return { status: 200, json: await createPairingCode(root, run) };
    if (path === '/api/peers/pair') return { status: 200, json: await pairWithCode(root, String(body.code ?? '')) };
    if (path === '/api/peers/refresh') return { status: 200, json: { paired: await discoverAndPair(root, { run }) } };
    if (path === '/api/peers/set') return { status: 200, json: await setPeer(root, String(body.name), { enabled: body.enabled, allow: body.allow }) };
    if (path === '/api/peers/remove') { await removePeer(root, String(body.name)); return { status: 200, json: {} }; }
    if (path === '/api/firewall/open') return { status: 200, json: await firewall({ create: true }) };
    if (path === '/api/mail/send') return { status: 200, json: await sendMessage(root, { to: String(body.to), kind: body.kind === 'mail' ? 'mail' : 'chat', subject: body.subject, body: String(body.body ?? '') }) };
    if (path === '/api/mail/read') { await markRead(root, Array.isArray(body.ids) ? body.ids.map(String) : []); return { status: 200, json: {} }; }
    if (path === '/api/responder') {
      const responder = { enabled: body.enabled, autonomy: body.autonomy };
      return { status: 200, json: body.peer === undefined
        ? responderState(await saveResponderConfig(root, responder))
        : await setPeer(root, String(body.peer), { responder }) };
    }
    return fail(404, 'Not found');
  } catch (error) {
    return fail(400, error instanceof Error ? error.message : 'Request failed');
  }
}
