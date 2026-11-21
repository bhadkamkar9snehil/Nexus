import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { tools } from '../tool-catalog.js';
import { ToolRegistry, type ToolDefinition } from '../tool-registry.js';

const sample: ToolDefinition = {
  name: 'example_tool',
  description: 'Example tool for registry tests.',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
};

test('core catalog has stable unique names and valid tool schemas', () => {
  const registry = new ToolRegistry<object>(tools);
  assert.equal(registry.list().length, 0);
  assert.equal(new Set(tools.map(tool => tool.name)).size, tools.length);
  assert.equal(tools.length, 31);
  // Preserve the installed catalog in its original order. New tools must not change old contracts.
  const originalCatalog = tools.filter(tool => !['browser_read_page','web_scrape'].includes(tool.name));
  assert.equal(createHash('sha256').update(JSON.stringify(originalCatalog)).digest('hex'), '4ce2b99ba890db910b797b21013ddde5bdc707814eb4c977d04744ad38125ffe');
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  for (const tool of tools) registry.bind(tool.name, async () => '{}');
  registry.assertReady();
  assert.deepEqual(registry.list(), tools);
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
