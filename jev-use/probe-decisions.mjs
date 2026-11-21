import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { join } from 'node:path';
const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, 'start.mjs')], stderr: 'ignore' });
const client = new Client({ name: 'decision-smoke', version: '1' });
const cases = [
  ['jev_select_workflow', { request: 'Find the local folder named invoices by filename on C drive.' }, r => r.selected === 'file_lookup'],
  ['jev_rank_results', { query: 'invoice total', candidates: [{ id: 'photo', text: 'Family holiday photograph' }, { id: 'invoice', text: 'Invoice INV-42 total INR 1250' }] }, r => r.best_id === 'invoice'],
  ['jev_classify_failure', { operation: 'connect to website', evidence: 'HTTP 401 Unauthorized: your sign-in session has expired.' }, r => r.selected === 'authentication'],
  ['jev_verify_result', { request: 'Calculate two plus two.', evidence: 'Calculator accessibility display reads 4.' }, r => r.verdict === 'satisfied'],
  ['jev_verify_result', { request: 'Save a PDF invoice.', evidence: 'The browser still shows the login page. No PDF has been saved.' }, r => r.verdict === 'not_satisfied'],
];
try {
  await client.connect(transport);
  for (const [name, args, check] of cases) {
    const at = performance.now();
    const reply = await client.callTool({ name, arguments: args });
    const result = JSON.parse(reply.content[0].text);
    const passed = !reply.isError && check(result);
    console.log(JSON.stringify({ tool: name, passed, ms: Math.round(performance.now() - at), result }));
    if (!passed) process.exitCode = 1;
  }
} finally { await transport.close(); }
