import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readTextFile } from '../read-text-file.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('nexus_read_file paginates and tails UTF-8 text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-read-'));
  try {
    const path = join(root, 'note.txt');
    await writeFile(path, 'first\r\nsecond\r\nthird\r\n', 'utf8');
    const page = await readTextFile({ path, offset: 1, length: 1, allowedRoots: [root] });
    assert.equal(page.content, 'second');
    assert.equal(page.total_lines, 3);
    assert.equal(page.next_offset, 2);
    assert.equal(page.truncated, true);
    const tail = await readTextFile({ path, offset: -2, allowedRoots: [root] });
    assert.equal(tail.content, 'second\nthird');
    assert.equal(tail.next_offset, null);
    assert.equal(tail.truncated, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('nexus_read_file rejects protected paths, binary files and outside roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-read-'));
  const other = await mkdtemp(join(tmpdir(), 'nexus-other-'));
  try {
    const outside = join(other, 'outside.txt');
    await writeFile(outside, 'not authorized');
    await assert.rejects(readTextFile({ path: outside, allowedRoots: [root] }), /outside allowed/);
    const key = join(root, '.env');
    await writeFile(key, 'secret');
    await assert.rejects(readTextFile({ path: key, allowedRoots: [root] }), /Protected/);
    const binary = join(root, 'blob.dat');
    await writeFile(binary, Buffer.from([65,0,66]));
    await assert.rejects(readTextFile({ path: binary, allowedRoots: [root] }), /Binary/);
    await mkdir(join(root, 'secrets'));
    await writeFile(join(root, 'secrets', 'token.txt'), 'secret');
    await assert.rejects(readTextFile({ path: join(root, 'secrets', 'token.txt'), allowedRoots: [root] }), /Protected/);
    if (process.platform === 'win32') {
      const link = join(root, 'escaped.txt');
      try {
        await symlink(outside, link, 'file');
        await assert.rejects(readTextFile({ path: link, allowedRoots: [root] }), /outside allowed/);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      }
    }
    await assert.rejects(readTextFile({ path: root, allowedRoots: [root] }), /not a regular file/);
    await assert.rejects(readTextFile({ path: outside, length: 251, allowedRoots: [root] }), /Invalid length/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test('Nexus MCP publishes and executes nexus_read_file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-mcp-read-'));
  const oldRoots = process.env.NEXUS_READ_ROOTS;
  const client = new Client({ name: 'nexus-read-test', version: '1' });
  let transport: StdioClientTransport | undefined;
  try {
    const path = join(root, 'sample.txt');
    await writeFile(path, 'nexus read works\n');
    transport = new StdioClientTransport({
      command: process.execPath, args: [join(import.meta.dirname, '..', 'start.mjs')],
      env: { ...process.env, NEXUS_READ_ROOTS: root }, stderr: 'ignore',
    });
    await client.connect(transport);
    const catalog = await client.listTools();
    assert.ok(catalog.tools.some(item => item.name === 'nexus_read_file'));
    const response = await client.callTool({ name: 'nexus_read_file', arguments: { path } });
    assert.equal(response.isError, undefined);
    assert.equal(JSON.parse((response.content as {text:string}[])[0].text).content, 'nexus read works');
  } finally {
    if (transport) await transport.close();
    if (oldRoots === undefined) delete process.env.NEXUS_READ_ROOTS; else process.env.NEXUS_READ_ROOTS = oldRoots;
    await rm(root, { recursive: true, force: true });
  }
});
