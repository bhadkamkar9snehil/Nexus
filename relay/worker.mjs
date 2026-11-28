// Nexus internet relay (Cloudflare Worker + one Durable Object per mailbox). It only moves sealed envelopes between a
// sender's HTTPS request and the receiver's outbound WebSocket; it holds no keys and stores nothing.
import { DurableObject } from 'cloudflare:workers';

const MAX_BYTES = 200 * 1024;
const WAIT_MS = 8000;

export default {
  async fetch(request, env) {
    const match = /^\/box\/([0-9a-f]{64})(\/connect)?$/.exec(new URL(request.url).pathname);
    if (!match) return new Response('Not found', { status: 404 });
    const [, id, connect] = match;
    if (connect) {
      // The mailbox id is the hash of its owner's secret, so only the owner can listen and nothing needs registering.
      const [protocol, secret] = (request.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(s => s.trim());
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret ?? ''));
      const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
      if (protocol !== 'nexus' || hex !== id || request.headers.get('Upgrade') !== 'websocket') return new Response('Forbidden', { status: 403 });
    } else if (request.method !== 'POST' || Number(request.headers.get('Content-Length') ?? MAX_BYTES + 1) > MAX_BYTES) {
      return new Response('Refused', { status: 400 });
    }
    return env.MAILBOX.get(env.MAILBOX.idFromName(id)).fetch(request);
  },
};

export class Mailbox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.waiting = new Map();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') === 'websocket') {
      for (const old of this.ctx.getWebSockets()) old.close(4000, 'replaced');
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'nexus' } });
    }
    const socket = this.ctx.getWebSockets().at(-1);
    if (!socket) return new Response('Peer offline', { status: 503 });
    const id = crypto.randomUUID();
    const sealed = await request.text();
    const reply = new Promise((resolve) => {
      this.waiting.set(id, resolve);
      setTimeout(() => resolve(null), WAIT_MS);
    });
    socket.send(JSON.stringify({ id, sealed }));
    const answer = await reply;
    this.waiting.delete(id);
    return answer === null ? new Response('Peer did not answer', { status: 504 }) : new Response(answer);
  }

  webSocketMessage(_socket, data) {
    try { const { id, sealed } = JSON.parse(data); this.waiting.get(id)?.(String(sealed)); } catch { /* ignore */ }
  }
}
