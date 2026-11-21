import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { evaluate, verify, lexicalComments } from '../tools/comment-ratchet/check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checker = path.join(root, 'tools/comment-ratchet/check.mjs');
const fixture = path.join(root, 'tests/__comment-ratchet-fixture.mjs');
const invoke = (...args) => spawnSync(process.execPath, [checker, ...args], {
  cwd: root, encoding: 'utf8', windowsHide: true
});

test('strings, URLs and regular expressions do not count as new comments', () => {
  assert.equal(fs.existsSync(fixture), false);
  try {
    fs.writeFileSync(fixture, 'const a = "https://example.test/path";\nconst b = /https?:\\/\\/example\\.test/;\n');
    const result = invoke('check');
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(fixture, { force: true });
  }
});

test('new source comments fail with an exact file and line', () => {
  assert.equal(fs.existsSync(fixture), false);
  try {
    fs.writeFileSync(fixture, 'const value = 1;\n// unauthorized comment\n');
    const result = invoke('check');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tests\/__comment-ratchet-fixture\.mjs:2:/);
  } finally {
    fs.rmSync(fixture, { force: true });
  }
});

test('the committed baseline cannot be reinitialized', () => {
  const result = invoke('init');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Baseline exists/);
});

test('a replacement or movement cannot reuse the old baseline allowance', () => {
  const originalText = 'const left = 1;\n// decision\nconst right = 2;\n';
  const replacementText = 'const left = 1;\n// replacement\nconst right = 2;\n';
  const movedText = 'const left = 1;\nconst right = 2;\n// decision\n';
  const scan = text => {
    const start = text.indexOf('// ');
    const end = text.indexOf('\n', start);
    return evaluate(text, [{ start, end }], 'sample.ts');
  };
  const original = scan(originalText);
  const baseline = { files: { 'sample.ts': { comments: original.comments } } };
  assert.equal(verify({ 'sample.ts': original }, baseline).violations.length, 0);
  assert.equal(verify({ 'sample.ts': scan(replacementText) }, baseline).violations.length, 1);
  assert.equal(verify({ 'sample.ts': scan(movedText) }, baseline).violations.length, 1);
});

test('UTF-16 offsets preserve comment-only and inline line counts', () => {
  const source = 'const city = "Surat 😀";\n// note\nconst value = 4;\n';
  const start = source.indexOf('// note');
  const data = evaluate(source, [{ start, end: start + '// note'.length }], 'sample.ts');
  assert.equal(data.lines, 3);
  assert.equal(data.commentOnlyLines, 1);
  assert.equal(data.inlineCommentLines, 0);
});

test('C# lexer distinguishes URL strings from source comments', () => {
  const code = 'var url = "https://example.test/"; // real comment\n';
  const ranges = lexicalComments(code, 'sample.cs');
  assert.equal(ranges.length, 1);
  assert.equal(code.slice(ranges[0].start, ranges[0].end), '// real comment');
});
