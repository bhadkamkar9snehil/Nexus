import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const [name = 'tools', value = '{}', extra] = process.argv.slice(2);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(import.meta.dirname, 'start.mjs')],
  env: process.env,
  stderr: 'ignore',
});
const client = new Client({ name: 'shared-harness-cli', version: '1.0.0' });
try {
  if (extra) throw new Error('Usage: node cli.mjs <tool|tools> [JSON or @arguments.json]');
  const args = name === 'tools' ? {} : JSON.parse(value.startsWith('@') ? await readFile(value.slice(1), 'utf8') : value);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be a JSON object');
  await client.connect(transport);
  const result = name === 'tools' ? await client.listTools()
    : await client.callTool({ name, arguments: args }, undefined, { timeout: 150_000 });
  let output = result;
  if (name !== 'tools' && result.content?.[0]?.type === 'text') {
    try { output = JSON.parse(result.content[0].text); } catch { output = result; }
  }
  process.stdout.write(JSON.stringify(output) + '\n');
  if (result.isError || output.status === 'error') process.exitCode = 1;
  else if (output.status === 'blocked') process.exitCode = 2;
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : 'Harness CLI failed') + '\n');
  process.exitCode = 1;
} finally {
  await transport.close();
}
