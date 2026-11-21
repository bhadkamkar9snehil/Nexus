import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { FirecrawlV2Provider, firecrawlManifest } from '../firecrawl-provider.js';
import { PluginCapabilityRegistry } from '../plugin-capabilities.js';

test('Firecrawl Local requires an explicit local endpoint and cloud requires credentials', () => {
  assert.throws(() => new FirecrawlV2Provider({ mode: 'local' }), /FIRECRAWL_CLOUD=off/);
  assert.throws(() => new FirecrawlV2Provider({ mode: 'local', cloudOffConfirmed: true, endpoint: 'https://api.firecrawl.dev' }), /loopback/);
  assert.throws(() => new FirecrawlV2Provider({ mode: 'cloud' }), /credentials/);
  assert.throws(() => new FirecrawlV2Provider({ mode: 'cloud', endpoint: 'https://example.com', apiKey: 'secret' }), /official API/);
  assert.equal(firecrawlManifest('local').permissions[0], 'network.private');
  assert.equal(firecrawlManifest('cloud').permissions[0], 'network.public');
});

test('Firecrawl local adapter uses fixed routes and no authorization header', async () => {
  const calls: Array<{ path: string; method: string; auth: string | undefined; body: any }> = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    calls.push({
      path: req.url || '', method: req.method || '',
      auth: req.headers.authorization,
      body: body ? JSON.parse(body) : null,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { markdown: '# Test' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Unexpected server address');
    const registry = new PluginCapabilityRegistry();
    registry.register(firecrawlManifest('local'), new FirecrawlV2Provider({
      mode: 'local', cloudOffConfirmed: true, endpoint: 'http://127.0.0.1:' + address.port,
    }));
    assert.throws(() => registry.select('web.scrape', 'dev.firecrawl'), /disabled/);
    registry.enable('dev.firecrawl', ['network.private']);
    const result = await registry.execute('dev.firecrawl', 'web.scrape', { url: 'https://example.com/' }) as any;
    assert.equal(result.provider, 'firecrawl');
    assert.equal(result.mode, 'local');
    assert.equal(result.data.data.markdown, '# Test');
    await registry.execute('dev.firecrawl', 'web.crawl', { action: 'status', id: 'job_123' });
    await registry.execute('dev.firecrawl', 'web.crawl', { action: 'cancel', id: 'job_123' });
    assert.deepEqual(calls.map(c => c.path), ['/v2/scrape', '/v2/crawl/job_123', '/v2/crawl/job_123']);
    assert.deepEqual(calls.map(c => c.method), ['POST', 'GET', 'DELETE']);
    assert.ok(calls.every(c => c.auth === undefined));
    assert.equal(calls[0].body.url, 'https://example.com/');
    await assert.rejects(registry.execute('dev.firecrawl', 'web.scrape', { url: 'http://127.0.0.1/private' }), /Plugin execution failed/);
    assert.equal(calls.length, 3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('Firecrawl provider rejects credential-bearing inputs and invalid job IDs before HTTP calls', async () => {
  const provider = new FirecrawlV2Provider({ mode: 'local', cloudOffConfirmed: true });
  const signal = AbortSignal.timeout(1000);
  await assert.rejects(provider.execute('web.scrape', { url: 'https://example.com', headers: { Cookie: 'secret' } }, signal), /Credentials/);
  await assert.rejects(provider.execute('web.crawl', { action: 'status', id: '../private' }, signal), /Invalid job ID/);
  await assert.rejects(provider.execute('web.batch', { urls: ['http://192.168.0.1'] }, signal), /Private network/);
});
