import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentVersion, isNewer, resetVersionCache, versionInfo } from '../../version.mjs';

const noFile = async () => { throw new Error('ENOENT'); };

test('versions compare by number, not by text', () => {
  assert.equal(isNewer('1.13.0', '1.12.0'), true);
  assert.equal(isNewer('1.12.0', '1.12.0'), false);
  assert.equal(isNewer('1.9.1', '1.10.0'), false);
  assert.equal(isNewer('2.0.0', '1.99.99'), true);
  assert.equal(isNewer('garbage', '1.0.0'), false);
});

test('an installed bundle reports its VERSION file; a source checkout reports its git tag and commits ahead', async () => {
  assert.deepEqual(await currentVersion('r', { readText: async () => '1.12.0\r\n' }), { version: '1.12.0', source: 'installed', ahead: 0 });
  assert.deepEqual(await currentVersion('r', { readText: async () => 'v1.12.0' }), { version: '1.12.0', source: 'installed', ahead: 0 });
  assert.deepEqual(await currentVersion('r', { readText: noFile, run: async () => 'v1.12.0-3-gabc1234' }), { version: '1.12.0', source: 'source', ahead: 3 });
  assert.deepEqual(await currentVersion('r', { readText: async () => 'dev', run: async () => 'v1.11.0-0-gdeadbee' }), { version: '1.11.0', source: 'source', ahead: 0 });
  assert.deepEqual(await currentVersion('r', { readText: noFile, run: async () => null }), { version: 'dev', source: 'source', ahead: 0 });
});

test('the update indicator needs a newer release, tolerates being offline, and caches the feed', async () => {
  resetVersionCache();
  let calls = 0;
  const feed = (tag: string) => (async () => { calls++; return { ok: true, json: async () => ({ tag_name: tag, html_url: 'https://github.com/x/releases/' + tag }) }; }) as never;
  const deps = { readText: async () => '1.12.0' };
  const newer = await versionInfo('r', { ...deps, fetcher: feed('v1.13.0') });
  assert.deepEqual([newer.version, newer.latest, newer.newer], ['1.12.0', '1.13.0', true]);
  await versionInfo('r', { ...deps, fetcher: feed('v9.9.9') });
  assert.equal(calls, 1, 'second call within 30 minutes uses the cache');
  resetVersionCache();
  assert.equal((await versionInfo('r', { ...deps, fetcher: feed('v1.12.0') })).newer, false);
  resetVersionCache();
  const offline = await versionInfo('r', { ...deps, fetcher: (async () => { throw new Error('offline'); }) as never });
  assert.deepEqual([offline.latest, offline.newer], [null, false]);
  resetVersionCache();
});
