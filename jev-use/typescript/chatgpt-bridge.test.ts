import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { join } from 'node:path';

const script = join(import.meta.dirname, '..', 'chatgpt-bridge.mjs');

async function connectBridge(allowFiles: boolean) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [script],
    env: { ...process.env, NEXUS_CHATGPT_ALLOW_FILES: allowFiles ? '1' : '0' },
    stderr: 'pipe',
  });
  const errors: string[] = [];
  transport.stderr?.on('data', chunk => errors.push(String(chunk)));
  const client = new Client({ name: 'chatgpt-bridge-acceptance', version: '0.1.0' });
  await client.connect(transport);
  return { client, transport, errors };
}

test('ChatGPT bridge defaults to metadata-only and rejects command execution', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const { client, transport } = await connectBridge(false);
  try {
    const tools = await client.listTools();
    const names = tools.tools.map(item => item.name).sort();
    assert.deepEqual(names, ['list_processes', 'list_sessions', 'search_status']);
    assert.equal(names.includes('start_process'), false);
    assert.equal(names.includes('nexus_read_file'), false);
    const reply = await client.callTool({ name: 'list_sessions', arguments: {} });
    assert.equal(reply.isError, false);
    assert.equal(reply.content?.[0]?.type, 'text');
    const denied = await client.callTool({ name: 'start_process', arguments: { command: 'whoami' } });
    assert.equal(denied.isError, true);
    assert.match(String(denied.content?.[0]?.type==='text'?denied.content[0].text:''), /disabled by local Nexus ChatGPT policy/);
  } finally {
    await transport.close();
  }
});

test('ChatGPT bridge exposes file-read tools only after explicit local opt-in', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const { client, transport } = await connectBridge(true);
  try {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of ['find_files', 'search_local', 'nexus_read_file', 'nexus_read_document']) {
      assert.ok(names.includes(name), name + ' not exposed');
    }
    assert.equal(names.includes('nexus_write_file'), false);
    assert.equal(names.includes('kill_process'), false);
    assert.equal(names.includes('start_process'), false);
  } finally {
    await transport.close();
  }
});
