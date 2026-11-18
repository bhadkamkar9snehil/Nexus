import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

for (const bundle of ['cli.mjs', 'mcp.mjs']) {
  test(`${bundle} local answer review fails closed on unsupported or uncertain answers`, async () => {
    const source = readFileSync(resolve('../jev-browse/bundled', bundle), 'utf8');
    const start = source.indexOf('async function reviewAnswer(context, client)');
    const end = source.indexOf('// src/agent/answer.ts', start);
    assert.ok(start >= 0 && end > start);
    const review = runInNewContext(source.slice(start, end) + '\nreviewAnswer', {
      process: { env: { TEXT_MODEL_OMIT_REASONING: '1' } },
      isFiniteNumber: (value: unknown) => typeof value === 'number' && Number.isFinite(value),
      trace: () => {},
    });
    const answer = (supported: unknown, complete: unknown) => ({ systemOne: async () => ({ answers: {
      supported: { type: 'noul', noul: supported }, complete: { type: 'noul', noul: complete },
    } }) });
    const context = { user_goal: 'Find the title', proposed_answer: 'Example', current: { text: 'Example' } };
    assert.equal((await review(context, answer(0.9, 0.8))).verdict, 'SUPPORTED');
    assert.equal((await review(context, answer(0.2, 0.9))).verdict, 'REWRITE');
    assert.equal((await review(context, answer(0.9, 0.5))).verdict, 'REWRITE');
    await assert.rejects(review(context, answer('bad', 0.9)), /Invalid answer review response/);
  });
}
