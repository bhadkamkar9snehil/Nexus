import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { quicProbe, probeNetwork } from '../network.js';

test('quicProbe reports a Version Negotiation reply and silence', async () => {
  const server = createSocket('udp4');
  let answer = true;
  server.on('message', (packet, from) => {
    if (!answer) return;
    // Version Negotiation: version 0, destination ID = the client's source ID.
    server.send(Buffer.concat([Buffer.from([0x80, 0, 0, 0, 0, 8]), packet.subarray(15, 23), Buffer.from([8]), packet.subarray(6, 14), Buffer.from([0, 0, 0, 1])]), from.port, from.address);
  });
  await new Promise<void>(ok => server.bind(0, '127.0.0.1', ok));
  const port = server.address().port;
  assert.equal((await quicProbe('127.0.0.1', port, 1000)).status, 'quic_reply');
  answer = false;
  assert.equal((await quicProbe('127.0.0.1', port, 300)).status, 'no_reply');
  server.close();
});

test('network probe validates quic_ports and dns_servers', async () => {
  await assert.rejects(probeNetwork({ quic_ports: [443] }), /host required/);
  await assert.rejects(probeNetwork({ host: 'example.com', dns_servers: ['not-an-ip'] }), /dns_servers/);
});
