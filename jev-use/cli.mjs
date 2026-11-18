import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const [name = 'tools', value = '{}', extra] = process.argv.slice(2);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(import.meta.dirname, 'start.mjs')],
  env: process.env,
  stderr: 'pipe',
});
// Keep the server's own stderr so a startup failure is reported instead of a bare "Connection closed".
let serverLog = '';
transport.stderr?.on('data', chunk => { serverLog = (serverLog + chunk).slice(-4000); });
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
  const message = error instanceof Error ? error.message : 'Harness CLI failed';
  const closed = /Connection closed|-32000/.test(message);
  process.stderr.write(message + '\n');
  if (serverLog.trim()) process.stderr.write('Harness server output:\n' + serverLog.trim() + '\n');
  else if (closed) process.stderr.write('The harness server exited at startup without output. Run Diagnose.ps1 and check Node, jev-use\\node_modules and the install folder path.\n');
  process.exitCode = 1;
} finally {
  await transport.close();
}
