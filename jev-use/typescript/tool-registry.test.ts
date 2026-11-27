import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { tools } from '../tool-catalog.js';
import { ToolRegistry, type ToolDefinition } from '../tool-registry.js';
import { registerTerminalTools } from '../tool-handlers/terminal.js';
import type { ToolInvocation } from '../tool-context.js';

const sample: ToolDefinition = {
  name: 'example_tool',
  description: 'Example tool for registry tests.',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
};

test('core catalog has stable unique names and valid tool schemas', () => {
  const registry = new ToolRegistry<object>(tools);
  assert.equal(registry.list().length, 0);
  assert.equal(new Set(tools.map(tool => tool.name)).size, tools.length);
  assert.equal(tools.length, 59);
  // Preserve the installed catalog in its original order. New tools must not change old contracts.
  const originalCatalog = tools.filter(tool => !tool.name.startsWith('visual_') && !['jev_semantic_judge','browser_read_page','web_scrape','nexus_transfer_file','nexus_upload_file','nexus_start_task'].includes(tool.name));
  assert.equal(createHash('sha256').update(JSON.stringify(originalCatalog)).digest('hex'), '9891aa270b9a39f66c15ccd2b882a4cf0579b9212b90fb2d7b2482efdc0cc735');
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  for (const tool of tools) registry.bind(tool.name, async () => '{}');
  registry.assertReady();
  assert.deepEqual(registry.list(), tools);
});

test('restart shortcut option reaches the terminal handler', async () => {
  const registry = new ToolRegistry<ToolInvocation>(tools);
  registerTerminalTools(registry);
  const tool = tools.find(item => item.name === 'restart_application')!;
  assert.deepEqual(tool.inputSchema.properties.quit_via_ctrl_q, { type: 'boolean' });
  const args = { pid: 1, expected_name: 'x', expected_start_time: '1', confirm: true, quit_via_ctrl_q: 'invalid' };
  await assert.rejects(registry.execute('restart_application', { args, required: (name: string) => String(args[name as keyof typeof args]) } as unknown as ToolInvocation), /quit_via_ctrl_q/);
});

test('dispatches to the handler for the exact registered name', async () => {
  const registry = new ToolRegistry<{ label: string }>([sample]);
  registry.bind('example_tool', async context => JSON.stringify(context));
  assert.deepEqual(JSON.parse(await registry.execute('example_tool', { label: 'yes' })), { label: 'yes' });
  assert.equal(registry.has('example_tool'), true);
});

test('rejects duplicate definitions and duplicate handler binding', () => {
  assert.throws(() => new ToolRegistry([sample, sample]), /Duplicate tool definition/);
  const registry = new ToolRegistry([sample]);
  registry.bind('example_tool', async () => 'ok');
  assert.throws(() => registry.bind('example_tool', async () => 'duplicate'), /Duplicate tool handler/);
});

test('rejects unknown, invalid and incomplete tool registrations', async () => {
  const registry = new ToolRegistry([sample]);
  assert.equal(registry.has('example_tool'), false);
  assert.throws(() => registry.assertReady(), /Unbound tool handlers/);
  assert.throws(() => registry.bind('unregistered', async () => ''), /No tool definition/);
  await assert.rejects(registry.execute('unregistered', {}), /Unknown tool/);
  assert.throws(() => new ToolRegistry([{ ...sample, name: '../bad' }]), /Invalid tool name/);
  assert.throws(() => new ToolRegistry([{ ...sample, description: '' }]), /Invalid tool schema/);
});

test('handler errors remain visible to the shared execution wrapper', async () => {
  const registry = new ToolRegistry([sample]);
  registry.bind('example_tool', async () => { throw new Error('handler failure'); });
  await assert.rejects(registry.execute('example_tool', {}), /handler failure/);
});
