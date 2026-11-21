import { test, after } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureWebhooks, loadWebhookConfig } from '../../webhook-config.mjs';

process.env.NEXUS_NOTIFY = '0';

test('webhook filters accept only chosen events and projects and validate input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-hook-'));
  assert.deepEqual((await loadWebhookConfig(root)).projects, []);
  await configureWebhooks(root, { events: ['issue', 'pipeline'], projects: ['ssm/shared-computer-use'], forward: ['mahesh'] });
  const config = await loadWebhookConfig(root);
  assert.deepEqual(config.events, ['issue', 'pipeline']);
  assert.deepEqual(config.forward, ['mahesh']);
  await assert.rejects(configureWebhooks(root, { events: ['everything'] }), /may only contain/);
  await assert.rejects(configureWebhooks(root, { projects: [''] }), /list of up to 100/);
  // Partial updates keep the rest.
  assert.deepEqual((await configureWebhooks(root, { notify: [] })).events, ['issue', 'pipeline']);

  const { startWebhook, events } = await import('../../webhook.mjs');
  const server = await startWebhook(root, { host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  after(() => { server.close(); });
  const secret = (await readFile(join(root, 'secrets', 'webhook-secret.txt'), 'utf8')).trim();
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const post = (body: object, token = secret, eventId = 'test-delivery') => fetch(`http://127.0.0.1:${address.port}/gitlab-webhook`, {
    method: 'POST', headers: { 'X-Gitlab-Token': token, 'X-GitLab-Event-UUID': eventId, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const issue = { object_kind: 'issue', project: { path_with_namespace: 'ssm/shared-computer-use' }, object_attributes: { iid: 9, action: 'open', title: 'T' } };
  assert.equal((await post(issue)).status, 200);
  assert.equal((await post(issue)).status, 200, 'retry acknowledged without adding another event');
  assert.equal((await post({ ...issue, project: { path_with_namespace: 'ssm/other' } })).status, 202, 'other project filtered');
  assert.equal((await post({ object_kind: 'release', project: { path_with_namespace: 'ssm/shared-computer-use' }, tag: 'v1' })).status, 202, 'release not accepted');
  assert.equal((await post(issue, 'wrong')).status, 401);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'issue');
});
