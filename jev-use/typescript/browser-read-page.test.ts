import { strict as assert } from 'node:assert';
import { mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { browserReadPage, paginateBrowserContent } from '../browser-read-page.js';

test('browser read rejects unsafe sessions and invalid limits before browser access', async () => {
  await assert.rejects(browserReadPage({ session: '../unsafe' }), /Invalid session/);
  await assert.rejects(browserReadPage({ session: 'valid', max_chars: 49 }), /Invalid max_chars/);
  await assert.rejects(browserReadPage({ session: 'valid', format: 'script' as any }), /Invalid output format/);
  await assert.rejects(browserReadPage({ session: 'valid', browser: 'firefox' as any }), /Invalid browser/);
  await assert.rejects(browserReadPage({ session: 'valid', offset_chars: -1 }), /Invalid offset_chars/);
  await assert.rejects(browserReadPage({ session: 'valid', expected_sha256: 'not-a-hash' }), /Invalid expected_sha256/);
});

test('browser read has stable hash-guarded pagination without unbounded output', () => {
  const content = 'a'.repeat(150) + 'b'.repeat(150);
  const first = paginateBrowserContent(content, 0, 100);
  assert.equal(first.status, 'done');
  assert.equal(first.content?.length, 100);
  assert.equal(first.total_chars, 300);
  assert.equal(first.next_offset_chars, 100);
  const second = paginateBrowserContent(content, 100, 100, first.sha256);
  assert.equal(second.status, 'done');
  assert.equal(second.content?.length, 100);
  assert.equal(second.next_offset_chars, 200);
  const last = paginateBrowserContent(content, 200, 100, first.sha256);
  assert.equal(last.status, 'done');
  assert.equal(last.next_offset_chars, null);
  assert.equal(last.truncated, false);
  assert.equal(paginateBrowserContent('changed', 100, 100, first.sha256).reason, 'content_changed');
  assert.equal(paginateBrowserContent(content, 301, 100).reason, 'offset_out_of_range');
});

test('browser read respects cross-agent lock ownership', async () => {
  const directory = join(import.meta.dirname, '..', '..', '.sessions');
  const lock = join(directory, 'jev-chrome-busyfixture_lock.lock');
  await mkdir(directory, { recursive: true });
  await mkdir(lock);
  try {
    const result = JSON.parse(await browserReadPage({ session: 'busyfixture_lock' }));
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'session_busy');
  } finally { await rmdir(lock); }
});

test('browser read does not create or navigate to a missing session', async () => {
  const result = JSON.parse(await browserReadPage({ session: 'missing_fixture_session_00991' }));
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'session_not_open');
  assert.equal(result.session, 'jev-chrome-missing_fixture_session_00991');
});
