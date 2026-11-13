import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../decisions.js';

const fake = (selected = 'file_lookup', fit = 0.9, probabilities = { [selected]: 1 }) => ({
  systemOne: async () => ({ answers: { selected: { type: 'choice', choice: selected, probabilities }, fits: { type: 'noul', noul: fit }, satisfied: { type: 'noul', noul: fit } }, usage: { input_tokens: 10, output_tokens: 2 } }),
}) as any;
test('workflow is a recommendation and usage is collected', async () => {
  let usage: any;
  const r = JSON.parse(await decide('jev_select_workflow', { request: 'find my PDF' }, u => usage = u, fake()));
  assert.equal(r.selected, 'file_lookup'); assert.equal(r.executed, false); assert.equal(usage.input_tokens, 10);
});
test('uncertain and unsupported workflows abstain', async () => {
  const r = JSON.parse(await decide('jev_select_workflow', { request: 'something' }, () => {}, fake('file_lookup', 0.5)));
  assert.equal(r.selected, null);
});
test('ranking preserves caller IDs and rejects duplicates', async () => {
  const args = { query: 'invoice', candidates: [{ id: 'a', text: 'photo' }, { id: 'b', text: 'invoice' }] };
  const r = JSON.parse(await decide('jev_rank_results', args, () => {}, fake('result_1', 0.9, { result_0: 0.1, result_1: 0.9 })));
  assert.equal(r.best_id, 'b'); assert.equal(r.ranking[0].id, 'b');
  await assert.rejects(() => decide('jev_rank_results', { ...args, candidates: [args.candidates[0], args.candidates[0]] }, () => {}, fake()), /Duplicate/);
});
test('invalid selected IDs and probabilities fail visibly', async () => {
  await assert.rejects(() => decide('jev_select_workflow', { request: 'find' }, () => {}, fake('invented')), /selection/);
  await assert.rejects(() => decide('jev_select_workflow', { request: 'find' }, () => {}, fake('file_lookup', NaN)), /probability/);
});
test('verification has explicit yes, no and unsettled outcomes', async () => {
  for (const [p, verdict] of [[0.9, 'satisfied'], [0.1, 'not_satisfied'], [0.5, 'uncertain']] as const) {
    const r = JSON.parse(await decide('jev_verify_result', { request: 'calculate 2+2', evidence: 'display 4' }, () => {}, fake('file_lookup', p)));
    assert.equal(r.verdict, verdict);
  }
});
test('failure recommendation never retries', async () => {
  const r = JSON.parse(await decide('jev_classify_failure', { operation: 'login', evidence: '401' }, () => {}, fake('authentication')));
  assert.equal(r.selected, 'authentication'); assert.equal(r.retry_executed, false);
});
test('API failures are errors rather than negative judgments', async () => {
  await assert.rejects(() => decide('jev_verify_result', { request: 'test', evidence: 'test' }, () => {}, { systemOne: async () => { throw new Error('network failed'); } } as any), /network failed/);
});
test('parallel fit questions receive the candidate definitions in shared state', async () => {
  const client = { systemOne: async (payload: any) => {
    assert.match(payload.state.offered_categories, /find_files/);
    return await fake().systemOne();
  } } as any;
  await decide('jev_select_workflow', { request: 'find a PDF' }, () => {}, client);
  const ranking = { systemOne: async (payload: any) => {
    assert.match(payload.state.candidates, /invoice total/);
    return await fake('result_0').systemOne();
  } } as any;
  await decide('jev_rank_results', { query: 'invoice', candidates: [{ id: 'x', text: 'invoice total' }] }, () => {}, ranking);
});
