// Which GitLab events this installation accepts, which raise a Windows notification, and which peers receive a copy.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const eventKinds = ['release', 'pipeline', 'merge_request', 'push', 'tag_push', 'note', 'issue'];
const defaults = { events: eventKinds, projects: [], notify: ['release', 'pipeline', 'merge_request'], forward: [] };
const file = (root) => join(root, 'secrets', 'webhooks.json');

export async function loadWebhookConfig(root) {
  try { return { ...defaults, ...JSON.parse(await readFile(file(root), 'utf8')) }; } catch { return { ...defaults }; }
}

const list = (value, what, allowed) => {
  if (!Array.isArray(value) || value.length > 100 || value.some(v => typeof v !== 'string' || !v || v.length > 200)) throw new Error(`${what} must be a list of up to 100 names`);
  if (allowed && value.some(v => !allowed.includes(v))) throw new Error(`${what} may only contain: ${allowed.join(', ')}`);
  return [...new Set(value)];
};

/** Updates only the given fields. `projects` are GitLab paths such as ssm/shared-computer-use; empty means every project. */
export async function configureWebhooks(root, change) {
  const next = await loadWebhookConfig(root);
  if (change.events !== undefined) next.events = list(change.events, 'events', eventKinds);
  if (change.projects !== undefined) next.projects = list(change.projects, 'projects');
  if (change.notify !== undefined) next.notify = list(change.notify, 'notify', eventKinds);
  if (change.forward !== undefined) next.forward = list(change.forward, 'forward');
  await mkdir(join(root, 'secrets'), { recursive: true });
  await writeFile(file(root), JSON.stringify(next, null, 2));
  return next;
}

export const accepts = (config, kind, project) => config.events.includes(kind) && (!config.projects.length || config.projects.includes(project));
