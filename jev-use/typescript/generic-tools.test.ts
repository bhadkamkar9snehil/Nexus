import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { searchLocal } from '../local-search.js';
import { probeNetwork, subnetHosts } from '../network.js';

test('subnet discovery requires an explicitly bounded IPv4 subnet', () => {
  assert.deepEqual(subnetHosts('127.0.0.0/30'), ['127.0.0.1', '127.0.0.2']);
  assert.throws(() => subnetHosts('10.0.0.0/16'), /subnet/i);
});

test('local search includes large files and reports bounded results', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-search-'));
  try {
    await writeFile(join(dir, 'large.txt'), 'a'.repeat(5 * 1024 * 1024) + '\nneedle\nneedle\n');
    const r = await searchLocal({ root: dir, pattern: 'needle', limit: 1 });
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].line, 2);
    assert.equal(r.truncated, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('network HTTP probe reports response status without reading a body', async () => {
  const server = createHttpServer((_request, response) => { response.writeHead(204); response.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const r = await probeNetwork({ url: `http://127.0.0.1:${port}/`, timeout_ms: 1000 });
    assert.ok(r.http && 'status_code' in r.http);
    assert.equal(r.http.status_code, 204);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('network TCP probe observes a listening local service', async () => {
  const server = createServer(socket => socket.end());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const r = await probeNetwork({ host: '127.0.0.1', ports: [port], timeout_ms: 1000 });
    assert.equal(r.tcp[0].status, 'open');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('Windows ping discovery finds loopback in the requested subnet', async () => {
  if (process.platform !== 'win32') return;
  const r = await probeNetwork({ host: '127.0.0.1', ping: true, subnet: '127.0.0.0/30', timeout_ms: 500 });
  assert.equal(r.ping?.status, 'done');
  assert.equal(r.discovery?.hosts.find(h => h.host === '127.0.0.1')?.status, 'responded');
});

test('MCP exposes local search and network probe to both agents', async () => {
  const client = new Client({ name: 'generic-tools-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, '..', 'start.mjs')], stderr: 'ignore' });
  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    assert.ok(catalog.tools.some(t => t.name === 'search_local'));
    assert.ok(catalog.tools.some(t => t.name === 'network_probe'));
    const result = await client.callTool({ name: 'network_probe', arguments: {} });
    assert.equal(result.isError, undefined);
    const content = result.content as { type: string; text: string }[];
    assert.equal(JSON.parse(content[0].text).status, 'done');
    const local = await client.callTool({ name: 'search_local', arguments: { root: import.meta.dirname, pattern: 'subnet discovery requires', glob: 'generic-tools.test.ts' } });
    const search = JSON.parse((local.content as { text: string }[])[0].text);
    assert.ok(search.matches.length > 0);
    assert.equal(search.decisions, 0);
  } finally { await transport.close(); }
});
