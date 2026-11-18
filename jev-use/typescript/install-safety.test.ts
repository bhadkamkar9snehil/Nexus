import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

test('local text setup refuses to replace existing browser model settings', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(resolve('.'), '.local-text-test-'));
  try {
    mkdirSync(join(root, 'jev-browse'));
    copyFileSync(resolve('../Setup-LocalText.ps1'), join(root, 'Setup-LocalText.ps1'));
    const config = join(root, 'jev-browse', '.env');
    writeFileSync(config, 'EXISTING_SETTING=preserve\n');
    assert.throws(() => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'Setup-LocalText.ps1')], { encoding: 'utf8', stdio: 'pipe', timeout: 10000 }), /already exists/);
    assert.equal(readFileSync(config, 'utf8'), 'EXISTING_SETTING=preserve\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test('GUI key enrollment accepts standard input and stores an account-protected key', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(resolve('.'), '.key-test-'));
  try {
    const script = join(root, 'Set-ComputerUseKey.ps1');
    copyFileSync(resolve('../Set-ComputerUseKey.ps1'), script);
    const modulesPath = join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
    const output = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-FromStandardInput'], { input: 'test-key-for-fixture\n', encoding: 'utf8', stdio: 'pipe', timeout: 5000, env: { ...process.env, PSModulePath: modulesPath } });
    assert.match(output, /Saved computeruse_1/);
    const content = readFileSync(join(root, 'secrets', 'computeruse_1.xml'), 'utf16le');
    assert.ok(!content.includes('test-key-for-fixture'));
    assert.match(content, /<SS>/);
    mkdirSync(join(root, 'jev-use'));
    const reader = join(root, 'jev-use', 'Read-ComputerUseKey.ps1');
    copyFileSync(resolve('Read-ComputerUseKey.ps1'), reader);
    const decoded = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', reader], { encoding: 'utf8', stdio: 'pipe', timeout: 5000, env: { ...process.env, PSModulePath: modulesPath } });
    assert.equal(decoded, 'test-key-for-fixture');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing agent registrations reported on stderr do not abort setup', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(resolve('.'), '.registration-test-'));
  try {
    const modules = join(root, 'jev-use', 'node_modules');
    mkdirSync(join(modules, 'tsx', 'dist'), { recursive: true });
    copyFileSync(resolve('../Install.ps1'), join(root, 'Install.ps1'));
    writeFileSync(join(root, 'Test-Package.ps1'), "'package test fixture'\n");
    writeFileSync(join(root, 'cua-driver.cmd'), '@exit /b 0\r\n');
    writeFileSync(join(root, 'codex.cmd'), '@if "%2"=="get" (echo registration absent 1>&2 & exit /b 1)\r\n@echo %*>>"%~dp0registered.txt"\r\n@exit /b 0\r\n');
    writeFileSync(join(root, 'claude.cmd'), '@exit /b 0\r\n');
    writeFileSync(join(root, 'jev-use', 'package-lock.json'), '{}');
    writeFileSync(join(modules, 'tsx', 'dist', 'loader.mjs'), '');
    writeFileSync(join(root, '.bundled-lock.sha256'), createHash('sha256').update('{}').digest('hex').toUpperCase());
    const modulesPath = join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
    const output = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'Install.ps1'), '-RegisterAgents', '-UseBundledDependencies'], { env: { ...process.env, PATH: root + ';' + process.env.PATH, PSModulePath: modulesPath }, encoding: 'utf8', stdio: 'pipe', timeout: 15000 });
    assert.match(output, /Installed\./);
    assert.match(readFileSync(join(root, 'registered.txt'), 'utf8'), /mcp add shared_jev -- /);
    assert.match(readFileSync(join(root, 'registered.txt'), 'utf8'), /mcp add shared_cua -- /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
