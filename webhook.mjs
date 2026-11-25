// GitLab webhook receiver: lets GitLab push release and pipeline events to this computer.
// Listens on the LAN, accepts only POST /gitlab-webhook with the shared secret, keeps the last events in memory.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { receive, sendMessage } from './peers.mjs';
import { handleHello, handlePair } from './peers-auto.mjs';
import { emit } from './events.mjs';
import { accepts, loadWebhookConfig } from './webhook-config.mjs';
import { notify } from './notify.mjs';

export const webhookPort = Number(process.env.NEXUS_WEBHOOK_PORT || 8770);
export const events = [];
const kinds = new Set(['release', 'pipeline', 'merge_request', 'push', 'tag_push', 'note', 'issue']);

export async function webhookSecret(root) {
  const file = join(root, 'secrets', 'webhook-secret.txt');
  try { return (await readFile(file, 'utf8')).trim(); } catch { /* first run */ }
  const secret = randomBytes(24).toString('hex');
  await mkdir(join(root, 'secrets'), { recursive: true });
  await writeFile(file, secret);
  return secret;
}

export function summarize(kind, body) {
  const project = body.project?.path_with_namespace ?? '';
  if (kind === 'release') return { project, title: `${body.name || body.tag} ${body.action || ''}`.trim(), tag: body.tag };
  if (kind === 'pipeline') {
    const attrs = body.object_attributes ?? {};
    const safe = value => String(value ?? '').replace(/[\r\n\t]/g, ' ').slice(0, 80);
    const id = Number.isSafeInteger(attrs.id) ? ' #' + attrs.id : '';
    const status = safe(attrs.status || 'unknown').slice(0, 24);
    const ref = safe(attrs.ref || 'unknown');
    const rawSha = String(attrs.sha || body.commit?.id || '');
    const sha = /^[0-9a-f]{40}$/i.test(rawSha) ? ' @' + rawSha.slice(0, 10) : '';
    const seconds = value => Number.isFinite(value) && value >= 0 && value <= 86400
      ? Math.round(value) + 's' : '';
    const duration = seconds(attrs.duration);
    const builds = Array.isArray(body.builds) ? body.builds : [];
    const failed = builds.filter(job => job?.status === 'failed').slice(0, 4)
      .map(job => safe(job.name || 'unknown').slice(0, 35));
    const jobs = builds.filter(job => ['success', 'failed'].includes(job?.status) && seconds(job.duration))
      .slice(0, 4).map(job => safe(job.name || 'unknown').slice(0, 24) + '=' + seconds(job.duration));
    const details = [duration ? 'duration ' + duration : '', jobs.length ? jobs.join(', ') : '',
      failed.length ? 'failed jobs: ' + failed.join(', ') : ''].filter(Boolean).join('; ');
    return { project, title: ('Pipeline' + id + ' ' + status + ' on ' + ref + sha +
      (details ? '; ' + details : '')).slice(0, 240) };
  }
  if (kind === 'merge_request') return { project, title: `MR !${body.object_attributes?.iid} ${body.object_attributes?.action}: ${body.object_attributes?.title}` };
  if (kind === 'note') return { project, title: `Comment by ${body.user?.username}` };
  if (kind === 'issue') return { project, title: `Issue #${body.object_attributes?.iid} ${body.object_attributes?.action}: ${body.object_attributes?.title}` };
  return { project, title: `${kind} to ${body.ref ?? ''}` };
}

export async function startWebhook(root, options = {}) {
  const secret = Buffer.from(await webhookSecret(root));
  const server = createServer((req, res) => {
    const done = (status) => { res.writeHead(status).end(); };
    if (req.method === 'POST' && req.url === '/peer/message') {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > 128 * 1024) req.destroy(); else chunks.push(c); });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          done(await receive(root, req.headers.authorization, payload, m => {
            notify(`Message from ${m.peer}`, m.subject || m.body, 'inbox');
            // Minimal payload: the body stays in the mailbox (nexus_mail).
            emit(root, { name: 'peer.message', eventId: m.id, data: { messageId: m.id, from: m.peer, kind: m.kind, subject: m.subject ?? '' } }).catch(() => {});
            options.onMessage?.(m);
          }));
        } catch { done(400); }
      });
      return;
    }
    // Pairing: own devices ("hello", trusted by Tailscale account) and one-time codes ("pair").
    if (req.method === 'POST' && (req.url === '/peer/hello' || req.url === '/peer/pair')) {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > 16 * 1024) req.destroy(); else chunks.push(c); });
      req.on('end', async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const remote = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
          const result = req.url === '/peer/hello' ? await handleHello(root, remote, body) : await handlePair(root, remote, body);
          res.writeHead(result.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(result.json));
        } catch { done(400); }
      });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/gitlab-webhook') return done(404);
    const given = Buffer.from(String(req.headers['x-gitlab-token'] ?? ''));
    if (given.length !== secret.length || !timingSafeEqual(given, secret)) return done(401);
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1024 * 1024) req.destroy(); else chunks.push(c); });
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const kind = String(body.object_kind ?? req.headers['x-gitlab-event'] ?? '').toLowerCase().replace(' hook', '');
        if (!kinds.has(kind)) return done(202);
        const event = { id: randomBytes(4).toString('hex'), at: Date.now(), kind, ...summarize(kind, body) };
        const config = await loadWebhookConfig(root);
        if (!accepts(config, kind, event.project)) return done(202);
        const recorded = await emit(root, { name: 'gitlab.event', eventId: String(req.headers['x-gitlab-event-uuid'] || event.id), data: { kind, project: event.project, title: event.title }, deduplicate: true });
        if (!recorded) return done(200);
        events.unshift(event);
        if (config.notify.includes(kind)) notify(event.project || 'GitLab', event.title);
        // Forward a copy to the chosen peers; a peer that is off or offline must not fail GitLab's delivery.
        if (config.forwardEvents.includes(kind)) {
          for (const to of config.forward) sendMessage(root, { to, kind: 'mail', subject: `GitLab: ${event.title}`.slice(0, 200), body: JSON.stringify(event) }).catch(() => {});
        }
        events.length = Math.min(events.length, 50);
        done(200);
      } catch { done(400); }
    });
  });
  server.on('error', (e) => console.error('Webhook receiver unavailable: ' + e.message));
  server.listen(options.port ?? webhookPort, options.host ?? '0.0.0.0', () => console.log('GitLab webhook receiver on port ' + server.address().port));
  return server;
}
