import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { summarize } from '../../webhook.mjs';

test('GitLab pipeline summaries include ID, state, branch and failed job names', () => {
  const summary = summarize('pipeline', {
    project: { path_with_namespace: 'ssm/shared-computer-use' },
    object_attributes: { id: 843, status: 'failed', ref: 'feat/nexus-tool-registry-49' },
    builds: [
      { name: 'validate-branch', status: 'success' },
      { name: 'preview-build', status: 'failed' },
    ],
  });
  assert.equal(summary.project, 'ssm/shared-computer-use');
  assert.match(summary.title, /Pipeline #843 failed/);
  assert.match(summary.title, /failed jobs: preview-build/);
  assert.ok(!summary.title.includes('validate-branch'));
});

test('GitLab pipeline summary provides commit and bounded job timings', () => {
  const summary = summarize('pipeline', {
    project: { path_with_namespace: 'ssm/shared-computer-use' },
    object_attributes: { id: 901, status: 'success', ref: 'feat/nexus-tool-registry-49',
      duration: 297, sha: 'a'.repeat(40) },
    builds: [
      { name: 'validate-branch', status: 'success', duration: 77 },
      { name: 'preview-build', status: 'success', duration: 220 },
    ],
  });
  assert.match(summary.title, /Pipeline #901 success/);
  assert.match(summary.title, /@aaaaaaaaaa/);
  assert.match(summary.title, /duration 297s/);
  assert.match(summary.title, /validate-branch=77s/);
  assert.match(summary.title, /preview-build=220s/);
});

test('GitLab pipeline summary remains bounded without raw job output', () => {
  const summary = summarize('pipeline', {
    project: { path_with_namespace: 'ssm/shared-computer-use' },
    object_attributes: { status: 'failed', ref: 'x'.repeat(500) },
    builds: Array.from({ length: 100 }, (_, i) => ({ name: 'job-' + i, status: 'failed', trace: 'private log contents' })),
  });
  assert.ok(summary.title.length <= 240);
  assert.ok(!summary.title.includes('private log contents'));
});
