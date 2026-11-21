import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { extractStaticHtml, isPublicIp, validatePublicUrl, webScrape } from '../web-http.js';

test('public URL validation blocks local, reserved and embedded credentials', () => {
  for (const url of [
    'file:///etc/passwd',
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://10.1.2.3/',
    'http://192.168.1.1/',
    'http://169.254.169.254/',
    'http://localhost/',
    'http://example.local/',
    'http://name:pass@example.com/',
  ]) assert.throws(() => validatePublicUrl(url));
  assert.equal(validatePublicUrl('https://example.com/docs').hostname, 'example.com');
});

test('IP guard blocks private and non-routable destinations', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.31.1.1', '192.168.99.5',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1', 'ff02::1']) {
    assert.equal(isPublicIp(ip), false, ip);
  }
  assert.equal(isPublicIp('1.1.1.1'), true);
  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.equal(isPublicIp('2606:4700:4700::1111'), true);
});

test('static extraction preserves headings and links and strips unsafe elements', () => {
  const parsed = extractStaticHtml(`<html><head><title>Fixture</title>
    <meta name="description" content="Test description"></head>
    <body><nav>Not content</nav><main>
    <h1>Title</h1><p>Useful <strong>content</strong>.</p>
    <a href="/docs?token=abc">Documentation</a>
    <script>ignore()</script><form><input value="secret"></form>
    <a href="javascript:alert(1)">Bad link</a>
    </main></body></html>`, 'https://example.com/');
  assert.equal(parsed.title, 'Fixture');
  assert.ok(parsed.markdown.includes('Title'), parsed.markdown);
  assert.ok(parsed.markdown.includes('content'), parsed.markdown);
  assert.equal(parsed.links.length, 1);
  assert.ok(parsed.links[0].url.includes('redacted'));
  for (const unsafe of ['Not content', 'ignore()', 'secret', '<script', '<form', 'javascript:']) {
    assert.ok(!parsed.html.includes(unsafe), unsafe);
  }
});

test('web_scrape rejects private targets before any network request', async () => {
  await assert.rejects(webScrape({ url: 'http://127.0.0.1/' }), /Private network/);
  await assert.rejects(webScrape({ url: 'http://169.254.169.254/latest/meta-data/' }), /Private network/);
  await assert.rejects(webScrape({ url: 'https://example.com/', max_chars: 20 }), /Invalid max_chars/);
});
