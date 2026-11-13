import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

test('source setup preserves unverified dependencies and reuses a matching lock', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(resolve('.'), '.install-test-'));
  const modules = join(root, 'jev-use', 'node_modules');
  const path = process.env.PATH;
  try {
    mkdirSync(join(modules, 'tsx', 'dist'), { recursive: true });
    copyFileSync(resolve('../Install.ps1'), join(root, 'Install.ps1'));
    writeFileSync(join(root, 'Test-Package.ps1'), "'package test fixture'\n");
    writeFileSync(join(root, 'cua-driver.cmd'), '@exit /b 0\r\n');
    writeFileSync(join(root, 'jev-use', 'package-lock.json'), '{}');
    writeFileSync(join(modules, 'tsx', 'dist', 'loader.mjs'), '');
    const sentinel = join(modules, 'preserve.txt');
    writeFileSync(sentinel, 'keep');
    const modulesPath = join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
    const run = () => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'Install.ps1')], { env: { ...process.env, PATH: root + ';' + path, PSModulePath: modulesPath }, encoding: 'utf8', stdio: 'pipe' });
    assert.throws(run, /Existing node_modules was preserved/);
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep');
    const hash = createHash('sha256').update('{}').digest('hex').toUpperCase();
    writeFileSync(join(modules, '.harness-lock.sha256'), hash);
    assert.match(run(), /reusing them/);
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
