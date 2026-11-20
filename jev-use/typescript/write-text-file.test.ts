import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readTextFile } from '../read-text-file.js';
import { editTextFile, writeTextFile } from '../write-text-file.js';

async function sandbox(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-write-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('nexus_write_file creates a file, refuses silent overwrite, and honours the content guard', async () => {
  await sandbox(async root => {
    const path = join(root, 'a.txt');
    const made = await writeTextFile({ path, content: 'one\n', allowedRoots: [root] });
    assert.equal(made.created, true);
    await assert.rejects(writeTextFile({ path, content: 'two\n', allowedRoots: [root] }), /overwrite=true/);
    const read = await readTextFile({ path, allowedRoots: [root] });
    assert.equal(read.sha256, made.sha256);
    await writeFile(path, 'changed elsewhere\n');
    await assert.rejects(writeTextFile({ path, content: 'two\n', overwrite: true, expected_sha256: read.sha256, allowedRoots: [root] }), /changed since it was read/);
    const fresh = await readTextFile({ path, allowedRoots: [root] });
    await writeTextFile({ path, content: 'two\n', overwrite: true, expected_sha256: fresh.sha256, allowedRoots: [root] });
    assert.equal(await readFile(path, 'utf8'), 'two\n');
    assert.deepEqual(await readdir(root), ['a.txt']);
  });
});

test('nexus_edit_file replaces exact text only when the match count is right', async () => {
  await sandbox(async root => {
    const path = join(root, 'b.txt');
    await writeFile(path, 'alpha beta alpha\n');
    await assert.rejects(editTextFile({ path, old_text: 'alpha', new_text: 'x', allowedRoots: [root] }), /found 2 times, expected 1/);
    assert.equal(await readFile(path, 'utf8'), 'alpha beta alpha\n');
    const done = await editTextFile({ path, old_text: 'alpha', new_text: 'x', expected_replacements: 2, allowedRoots: [root] });
    assert.equal(done.replacements, 2);
    assert.equal(await readFile(path, 'utf8'), 'x beta x\n');
    await assert.rejects(editTextFile({ path: join(root, 'missing.txt'), old_text: 'a', new_text: 'b', allowedRoots: [root] }), /ENOENT|does not exist/);
  });
});

test('write and edit refuse protected paths, binary files and paths outside the roots', async () => {
  await sandbox(async root => {
    await assert.rejects(writeTextFile({ path: join(root, 'secrets', 'k.txt'), content: 'x', allowedRoots: [root] }), /ENOENT|Protected/);
    await assert.rejects(writeTextFile({ path: join(root, '.env'), content: 'x', allowedRoots: [root] }), /Protected/);
    await assert.rejects(writeTextFile({ path: join(tmpdir(), 'nexus-outside.txt'), content: 'x', allowedRoots: [root] }), /outside allowed roots/);
    const bin = join(root, 'c.bin');
    await writeFile(bin, Buffer.from([1, 0, 2]));
    await assert.rejects(editTextFile({ path: bin, old_text: 'a', new_text: 'b', allowedRoots: [root] }), /Binary/);
  });
});
