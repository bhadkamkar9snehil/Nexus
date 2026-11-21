import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PluginCapabilityRegistry } from '../plugin-capabilities.js';

const manifest = {
  schemaVersion: 1,
  id: 'dev.firecrawl',
  name: 'Firecrawl',
  version: '1.0.0',
  protocol: 'firecrawl-v2',
  capabilities: ['web.scrape', 'web.map'],
  permissions: ['network.public'],
};
const provider = { execute: async (capability: string, input: unknown) => ({ capability, input }) };

test('plugins are disabled by default and never override Nexus core', () => {
  const registry = new PluginCapabilityRegistry();
  registry.register(manifest, provider);
  assert.equal(registry.select('web.scrape'), null);
  assert.throws(() => registry.select('web.scrape', 'dev.firecrawl'), /disabled/);
  registry.enable('dev.firecrawl', ['network.public']);
  assert.equal(registry.select('web.scrape', 'dev.firecrawl'), 'dev.firecrawl');
  assert.equal(registry.select('web.scrape'), null);
});

test('manifest validation rejects unsafe IDs, unsupported versions, unknown fields and duplicate capabilities', () => {
  const registry = new PluginCapabilityRegistry();
  assert.throws(() => registry.register({ ...manifest, id: '../unsafe' }, provider));
  assert.throws(() => registry.register({ ...manifest, version: 'invalid' }, provider));
  assert.throws(() => registry.register({ ...manifest, allowExecute: true }, provider));
  assert.throws(() => registry.register({ ...manifest, capabilities: ['web.scrape', 'web.scrape'] }, provider));
  registry.register(manifest, provider);
  assert.throws(() => registry.register(manifest, provider), /Duplicate plugin ID/);
});

test('minimum Nexus version rejects incompatible manifests', () => {
  const registry = new PluginCapabilityRegistry('1.17.1');
  assert.throws(() => registry.register({ ...manifest, minNexusVersion: '2.0.0' }, provider), /newer Nexus version/);
  assert.equal(registry.register({ ...manifest, minNexusVersion: '1.17.0' }, provider).id, 'dev.firecrawl');
});

test('permission scopes require explicit grants', () => {
  const registry = new PluginCapabilityRegistry();
  registry.register({ ...manifest, permissions: ['network.public', 'browser.session.read'] }, provider);
  assert.throws(() => registry.enable('dev.firecrawl', ['network.public']), /browser.session.read/);
  assert.throws(() => registry.enable('dev.firecrawl', ['network.public', 'browser.session.read', 'files.write']), /requested no such permissions/);
  registry.enable('dev.firecrawl', ['network.public', 'browser.session.read']);
  registry.disable('dev.firecrawl');
  assert.equal(registry.list()[0].enabled, false);
});

test('provider execution is opt-in and capability-scoped', async () => {
  const registry = new PluginCapabilityRegistry();
  registry.register(manifest, provider);
  registry.enable('dev.firecrawl', ['network.public']);
  assert.deepEqual(await registry.execute('dev.firecrawl', 'web.scrape', { url: 'https://example.com' }), {
    capability: 'web.scrape', input: { url: 'https://example.com' },
  });
  assert.throws(() => registry.select('web.monitor', 'dev.firecrawl'), /does not provide/);
});

test('provider exceptions are isolated and secrets are absent from monitor state', async () => {
  const registry = new PluginCapabilityRegistry();
  registry.register(manifest, {
    execute: async () => { throw new Error('Sensitive token 123456 provider failure'); },
  });
  registry.register({ ...manifest, id: 'dev.alternate', name: 'Alternate' }, provider);
  registry.enable('dev.firecrawl', ['network.public']);
  registry.enable('dev.alternate', ['network.public']);
  await assert.rejects(registry.execute('dev.firecrawl', 'web.scrape', {}), /Plugin execution failed/);
  assert.equal(registry.list().find(p => p.id === 'dev.firecrawl')?.lastError, 'Error');
  assert.deepEqual(await registry.execute('dev.alternate', 'web.map', { query: 'docs' }), {
    capability: 'web.map', input: { query: 'docs' },
  });
});

test('timeout rejects a non-cooperative provider', async () => {
  const registry = new PluginCapabilityRegistry();
  registry.register(manifest, { execute: async () => new Promise(() => {}) });
  registry.enable('dev.firecrawl', ['network.public']);
  await assert.rejects(registry.execute('dev.firecrawl', 'web.scrape', {}, 100), /Plugin execution failed/);
});
