import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { driveCoverage, uffsExecutable } from '../find-files.js';

test('finds WinGet UFFS without an alias or refreshed PATH', () => {
  const original = process.env.LOCALAPPDATA;
  const local = mkdtempSync(join(tmpdir(), 'harness-uffs-'));
  const executable = join(local, 'Microsoft', 'WinGet', 'Packages', 'SkyLLC.UFFS_Microsoft.Winget.Source_8wekyb3d8bbwe', 'uffs-windows-x64', 'uffs.exe');
  try {
    process.env.LOCALAPPDATA = local;
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(executable, '');
    assert.equal(uffsExecutable(), executable);
  } finally {
    if (original === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = original;
    rmSync(local, { recursive: true, force: true });
  }
});

test('reports whether an empty search is backed by an index on the requested drive', () => {
  const drives = [{ letter: 'C', source: 'live', tier: 'warm', records: 42 },
    { letter: 'E', loading: true }];
  assert.deepEqual(driveCoverage('c', drives),
    { drive: 'C', state: 'indexed', source: 'live', tier: 'warm', records: 42 });
  assert.deepEqual(driveCoverage('D', drives), { drive: 'D', state: 'uncovered' });
  assert.deepEqual(driveCoverage('D', undefined), { drive: 'D', state: 'unknown' });
  assert.equal(driveCoverage('E', drives).state, 'loading');
});
