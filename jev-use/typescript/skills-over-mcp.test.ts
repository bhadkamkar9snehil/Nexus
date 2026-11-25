import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Skills over MCP (io.modelcontextprotocol/skills, SEP-2640): the packaged skills/ folder served by the shared_jev server.
const start = join(import.meta.dirname, '..', 'start.mjs');
const skillsRoot = join(import.meta.dirname, '..', '..', 'skills');
const Any = z.object({}).passthrough();
const ID = 'io.modelcontextprotocol/skills';
const URI = 'skill://shared-harness/SKILL.md';

const modern = async () => {
  const client = new Client({ name: 'nexus-skills-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [start], env: process.env as Record<string, string>, stderr: 'ignore' }));
  return client;
};
const call = (client: Client, method: string, params: Record<string, unknown> = {}) => client.request({ method, params }, Any) as Promise<any>;
const digest = (bytes: Uint8Array) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

test('declares the skills extension, resources and directoryRead, and points to the skill from its instructions', async () => {
  const client = await modern();
  try {
    const capabilities = client.getServerCapabilities();
    assert.ok(capabilities?.resources, 'resources capability');
    assert.equal(capabilities?.extensions?.[ID]?.directoryRead, true);
    assert.match(client.getInstructions() ?? '', /skill:\/\/shared-harness\/SKILL\.md/);
  } finally { await client.close(); }
});

test('skills/list and skills/get return complete manifests whose digests match the packaged files', async () => {
  const client = await modern();
  try {
    const list = await call(client, 'skills/list');
    assert.ok(Number.isInteger(list.ttlMs) && ['public', 'private'].includes(list.cacheScope));
    const entry = list.skills.find((s: any) => s.uri === URI);
    assert.ok(entry, 'shared-harness is listed');
    assert.equal(entry.frontmatter.name, 'shared-harness');
    assert.ok(entry.frontmatter.description);
    const uris = entry.resources.map((r: any) => r.uri).sort();
    assert.deepEqual(uris, ['skill://shared-harness/SKILL.md', 'skill://shared-harness/references/tools.md']);
    for (const resource of entry.resources) {
      const file = await readFile(join(skillsRoot, resource.uri.slice('skill://'.length)));
      assert.equal(resource.size, file.byteLength);
      assert.equal(resource.digest, digest(file));
    }
    const got = await call(client, 'skills/get', { uri: URI });
    assert.deepEqual(got.skill, entry);
    assert.ok(Number.isInteger(got.ttlMs) && got.cacheScope);
  } finally { await client.close(); }
});

test('resources/read serves every skill file with the published size and digest', async () => {
  const client = await modern();
  try {
    const { skill } = await call(client, 'skills/get', { uri: URI });
    for (const resource of skill.resources) {
      const read = await call(client, 'resources/read', { uri: resource.uri });
      const bytes = Buffer.from(read.contents[0].text, 'utf8');
      assert.equal(bytes.byteLength, resource.size);
      assert.equal(digest(bytes), resource.digest);
      assert.equal(read.contents[0].mimeType, 'text/markdown');
    }
    const text = (await call(client, 'resources/read', { uri: URI })).contents[0].text as string;
    assert.match(text, /^---\r?\nname: shared-harness\r?\n/);
  } finally { await client.close(); }
});

test('resources/directory/read lists direct children and rejects files and unknown URIs with -32602', async () => {
  const client = await modern();
  try {
    const root = await call(client, 'resources/directory/read', { uri: 'skill://shared-harness' });
    const byName = Object.fromEntries(root.resources.map((r: any) => [r.name, r]));
    assert.equal(byName['SKILL.md'].mimeType, 'text/markdown');
    assert.equal(byName.references.mimeType, 'inode/directory');
    const refs = await call(client, 'resources/directory/read', { uri: 'skill://shared-harness/references' });
    assert.deepEqual(refs.resources.map((r: any) => r.uri), ['skill://shared-harness/references/tools.md']);
    for (const uri of [URI, 'skill://shared-harness/nothing']) {
      await assert.rejects(call(client, 'resources/directory/read', { uri }), (e: any) => e.code === -32602);
    }
  } finally { await client.close(); }
});

test('an unknown skill is -32602 for skills/get and for resources/read', async () => {
  const client = await modern();
  try {
    await assert.rejects(call(client, 'skills/get', { uri: 'skill://no-such-skill/SKILL.md' }), (e: any) => e.code === -32602);
    await assert.rejects(call(client, 'resources/read', { uri: 'skill://shared-harness/missing.md' }), (e: any) => e.code === -32602);
  } finally { await client.close(); }
});

test('on the wire every skills result carries resultType complete, ttlMs and cacheScope', async () => {
  const child = spawn(process.execPath, [start], { stdio: ['pipe', 'pipe', 'ignore'], env: process.env });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'wire', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
  const ask = async (id: number, method: string, params: Record<string, unknown>) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: { _meta: meta, ...params } }) + '\n');
    for (;;) {
      const next = await lines.next();
      const message = JSON.parse(next.value as string);
      if (message.id === id) return message.result;
    }
  };
  try {
    const list = await ask(1, 'skills/list', {});
    const got = await ask(2, 'skills/get', { uri: URI });
    const read = await ask(3, 'resources/read', { uri: URI });
    const dir = await ask(4, 'resources/directory/read', { uri: 'skill://shared-harness' });
    for (const result of [list, got, read, dir]) {
      assert.equal(result.resultType, 'complete');
      assert.ok(Number.isInteger(result.ttlMs) && result.ttlMs >= 0);
      assert.ok(['public', 'private'].includes(result.cacheScope));
    }
  } finally { child.kill(); }
});
