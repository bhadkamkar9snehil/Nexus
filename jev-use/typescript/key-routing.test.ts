import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveToolKey } from '../key-routing.js';

test('tool mappings share aliases, fall back to default, and reject invalid configuration', () => {
  const keys: Record<string, string> = { team: 'team-key', other: 'other-key' };
  const load = (alias: string) => keys[alias];
  const mapping = { jev_browse: 'team', jev_desktop: 'team', jev_verify_result: 'other' };
  assert.equal(resolveToolKey('jev_browse', mapping, 'default-key', load), 'team-key');
  assert.equal(resolveToolKey('jev_desktop', mapping, 'default-key', load), 'team-key');
  assert.equal(resolveToolKey('jev_verify_result', mapping, 'default-key', load), 'other-key');
  assert.equal(resolveToolKey('jev_rank_results', mapping, 'default-key', load), 'default-key');
  assert.throws(() => resolveToolKey('jev_browse', { jev_browse: '../bad' }, 'default-key', load));
  assert.throws(() => resolveToolKey('jev_browse', { jev_browse: 'missing' }, 'default-key', load));
});
