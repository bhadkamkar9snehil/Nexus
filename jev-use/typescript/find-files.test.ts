import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { uffsExecutable } from '../find-files.js';

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
