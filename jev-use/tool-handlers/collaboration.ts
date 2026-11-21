import { networkInterfaces } from 'node:os';
import { listPeers, addPeer, setPeer, removePeer, sendMessage, readMailbox, markRead } from '../../peers.mjs';
import { loadWebhookConfig, configureWebhooks } from '../../webhook-config.mjs';
import { listEvents, pollEvents } from '../events-extension.js';
import type { ToolRegistry } from '../tool-registry.js';
import type { ToolInvocation } from '../tool-context.js';

export function registerCollaborationTools(registry: ToolRegistry<ToolInvocation>) {
  registry.bind('nexus_peers', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    const action = (args.action as string | undefined) ?? 'list';
          if (action === 'list') output = JSON.stringify({ status: 'done', peers: await listPeers(root) });
          else if (action === 'add') output = JSON.stringify({ status: 'done', peer: await addPeer(root, { name: required('name'), url: required('url'), outbound: args.outbound_token === undefined ? undefined : required('outbound_token'), allow: args.allow_mail === undefined && args.allow_chat === undefined ? undefined : { mail: args.allow_mail as boolean, chat: args.allow_chat as boolean } }) });
          else if (action === 'set') output = JSON.stringify({ status: 'done', peer: await setPeer(root, required('name'), { enabled: args.enabled as boolean | undefined, outbound: args.outbound_token === undefined ? undefined : required('outbound_token'), allow: { mail: args.allow_mail as boolean, chat: args.allow_chat as boolean } }) });
          else if (action === 'remove') { await removePeer(root, required('name')); output = JSON.stringify({ status: 'done' }); }
          else throw new Error('Invalid action');
    return output;
  });
  registry.bind('nexus_webhooks', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    const action = (args.action as string | undefined) ?? 'status';
          if (action === 'configure') {
            const pick = (key: string) => args[key] as string[] | undefined;
            output = JSON.stringify({ status: 'done', config: await configureWebhooks(root, { events: pick('events'), projects: pick('projects'), notify: pick('notify'), forward: pick('forward'), forwardEvents: pick('forwardEvents') }) });
          } else if (action === 'status') {
            const address = Object.values(networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address;
            const port = Number(process.env.NEXUS_WEBHOOK_PORT || 8770);
            const recent = await fetch(`http://127.0.0.1:${process.env.NEXUS_MONITOR_PORT || 8769}/webhook-events`, { signal: AbortSignal.timeout(2000) }).then(r => r.json()).then(j => j.events).catch(() => null);
            output = JSON.stringify({ status: 'done', receiver_url: address ? `http://${address}:${port}/gitlab-webhook` : null, secret_file: 'secrets\\webhook-secret.txt', config: await loadWebhookConfig(root), recent_events: recent, recent_events_note: recent ? undefined : 'Monitor not reachable; start it to see recent events.' });
          } else throw new Error('Invalid action');
    return output;
  });
  registry.bind('nexus_events', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    const action = (args.action as string | undefined) ?? 'list';
          if (action === 'list') output = JSON.stringify({ status: 'done', ...listEvents() });
          else if (action === 'poll') output = JSON.stringify({ status: 'done', ...await pollEvents(root, { name: required('name'), arguments: args.arguments as Record<string, unknown> | undefined, cursor: args.cursor as string | null | undefined, maxAgeMs: args.max_age_ms as number | undefined, maxEvents: args.max_events as number | undefined }) });
          else throw new Error('Invalid action');
    return output;
  });
  registry.bind('nexus_mail', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    const action = (args.action as string | undefined) ?? 'inbox';
          if (action === 'send') output = JSON.stringify({ status: 'done', ...await sendMessage(root, { to: required('to'), kind: args.kind as string | undefined, subject: args.subject as string | undefined, body: required('body', 64 * 1024) }) });
          else if (action === 'wait') {
            // Realtime without protocol support: hold the call until a peer message is unread, then return it.
            const end = Date.now() + Math.min(Math.max((args.timeout_ms as number | undefined) ?? 30000, 1000), 55000);
            let messages = await readMailbox(root, { box: 'in', unread: true });
            while (!messages.length && Date.now() < end) { await new Promise(r => setTimeout(r, 250)); messages = await readMailbox(root, { box: 'in', unread: true }); }
            output = JSON.stringify({ status: 'done', result: messages.length ? 'message' : 'timeout', messages });
          }
          else if (action === 'inbox' || action === 'outbox') output = JSON.stringify({ status: 'done', messages: await readMailbox(root, { box: action === 'inbox' ? 'in' : 'out', unread: args.unread_only === true, limit: args.limit as number | undefined }) });
          else if (action === 'mark_read') { if (!Array.isArray(args.ids) || !args.ids.every(i => typeof i === 'string')) throw new Error('ids required'); await markRead(root, args.ids as string[]); output = JSON.stringify({ status: 'done' }); }
          else throw new Error('Invalid action');
    return output;
  });
}
