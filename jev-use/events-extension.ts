import { userInfo } from 'node:os';
import { ProtocolError, type Server } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { cursorOf, parseCursor, readEvents } from '../events.mjs';
import { EventError, subscribe, unsubscribe } from '../events-webhooks.mjs';

// MCP Events extension (io.modelcontextprotocol/events, beta, SEP-3415): all three delivery modes.
//   poll    events/poll        stateless, cursor in every response
//   push    events/stream      a long-lived request on the stdio connection; notifications/events/* until cancelled
//   webhook events/subscribe   https callback, Standard Webhooks signatures; delivered by the monitor host
// The principal for webhook subscriptions is the Windows user that owns this server process (a stdio server is launched
// by that user's agent host); the subscription key (principal, url, name, arguments) isolates principals as the spec requires.
export const EVENTS_EXTENSION_ID = 'io.modelcontextprotocol/events';
const NOT_FOUND = -32023;
const POLL_MS = 5000, DEFAULT_MAX = 50, MAX_EVENTS = 200, DEFAULT_HEARTBEAT = 30_000;
const SUB = 'io.modelcontextprotocol/subscriptionId';

const gitlabKinds = ['release', 'pipeline', 'merge_request', 'push', 'tag_push', 'note', 'issue'] as const;
const eventTypes = {
  'gitlab.event': {
    description: 'A GitLab webhook event accepted by this Nexus installation (configure with nexus_webhooks). The payload is a short summary only.',
    input: z.object({ kind: z.enum(gitlabKinds).optional(), project: z.string().max(200).optional() }).strict(),
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: [...gitlabKinds], description: 'Only this GitLab event kind' }, project: { type: 'string', description: 'Only this project path, for example ssm/shared-computer-use' } }, additionalProperties: false },
    payloadSchema: { type: 'object', properties: { kind: { type: 'string' }, project: { type: 'string' }, title: { type: 'string' } }, required: ['kind', 'title'] },
    match: (a: { kind?: string; project?: string }) => (d: Record<string, unknown>) => (!a.kind || d.kind === a.kind) && (!a.project || d.project === a.project),
  },
  'peer.message': {
    description: 'Mail or chat arrived from a connected peer Nexus. The payload names the sender and subject; read the body with nexus_mail.',
    input: z.object({ kind: z.enum(['mail', 'chat']).optional(), from: z.string().max(40).optional() }).strict(),
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['mail', 'chat'] }, from: { type: 'string', description: 'Only this peer name' } }, additionalProperties: false },
    payloadSchema: { type: 'object', properties: { messageId: { type: 'string' }, from: { type: 'string' }, kind: { type: 'string' }, subject: { type: 'string' } }, required: ['messageId', 'from', 'kind'] },
    match: (a: { kind?: string; from?: string }) => (d: Record<string, unknown>) => (!a.kind || d.kind === a.kind) && (!a.from || d.from === a.from),
  },
  'visual.watch': {
    description: 'A durable visual watch observed changed evidence. Payload is a non-content summary, not execution authorization.',
    input: z.object({ watch_id:z.string().max(80).optional(), project:z.string().max(64).optional(), kind:z.enum(['condition_matched','state_changed']).optional() }).strict(),
    inputSchema:{type:'object',properties:{watch_id:{type:'string'},project:{type:'string'},kind:{type:'string',enum:['condition_matched','state_changed']}},additionalProperties:false},
    payloadSchema:{type:'object',properties:{watch_id:{type:'string'},project:{type:'string'},kind:{type:'string'},verdict:{type:'string'},asset_hash:{type:'string'}},required:['watch_id','project','kind','verdict','asset_hash']},
    match:(a:{watch_id?:string;project?:string;kind?:string})=>(d:Record<string,unknown>)=>(!a.watch_id||a.watch_id===d.watch_id)&&(!a.project||a.project===d.project)&&(!a.kind||a.kind===d.kind),
  },
} as const;
type EventName = keyof typeof eventTypes;
const known = (name: string): name is EventName => Object.hasOwn(eventTypes, name);

const Args = z.record(z.string(), z.unknown()).optional();
const ListParams = z.object({ cursor: z.string().optional() }).optional();
const PollParams = z.object({ name: z.string(), arguments: Args, cursor: z.string().nullable().optional(), maxAgeMs: z.number().int().positive().optional(), maxEvents: z.number().int().positive().optional() });
const StreamParams = z.object({ name: z.string(), arguments: Args, cursor: z.string().nullable().optional(), maxAgeMs: z.number().int().positive().optional(), heartbeatMs: z.number().int().positive().optional() });
const SubscribeParams = z.object({
  name: z.string(), arguments: Args, cursor: z.string().nullable().optional(), maxAgeMs: z.number().int().positive().optional(), ttlMs: z.number().int().positive().nullable().optional(),
  delivery: z.object({ mode: z.literal('webhook'), url: z.string(), secret: z.string() }),
});
const UnsubscribeParams = z.object({ name: z.string(), arguments: Args, delivery: z.object({ url: z.string() }) });
const anyResult = z.object({}).passthrough();

const invalid = (reason: string) => new ProtocolError(-32602, 'InvalidParams', { reason });
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const t = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
  function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
});

/** Validates the event name, its arguments and the cursor. */
function prepare(params: { name: string; arguments?: Record<string, unknown>; cursor?: string | null }) {
  if (!known(params.name)) throw new ProtocolError(NOT_FOUND, 'NotFound', { kind: 'event' });
  const type = eventTypes[params.name];
  const parsed = type.input.safeParse(params.arguments ?? {});
  if (!parsed.success) throw invalid(parsed.error.issues.map(i => i.message).join('; ').slice(0, 300));
  let afterSeq: number | undefined;
  if (params.cursor) { try { afterSeq = parseCursor(params.cursor); } catch { throw invalid('Invalid cursor'); } }
  const match = (type.match as (a: unknown) => (d: Record<string, unknown>) => boolean)(parsed.data);
  return { args: parsed.data as Record<string, unknown>, afterSeq, match };
}

export const listEvents = () => ({
  events: Object.entries(eventTypes).map(([name, e]) => ({ name, description: e.description, delivery: ['poll', 'push', 'webhook'], inputSchema: e.inputSchema, payloadSchema: e.payloadSchema })),
});

/** One events/poll exchange (also behind the nexus_events tool, for agents whose host does not speak the extension yet). */
export async function pollEvents(root: string, params: z.infer<typeof PollParams>) {
  const { afterSeq, match } = prepare(params);
  const { head, first, rows } = await readEvents(root, { name: params.name, afterSeq: afterSeq ?? Number.MAX_SAFE_INTEGER, match });
  // cursor null = start from now: no events, a fresh cursor.
  if (afterSeq === undefined) return { events: [], cursor: cursorOf(head), truncated: false, hasMore: false, nextPollMs: POLL_MS };
  // The log keeps only recent rows; a cursor older than the oldest retained row may have missed events.
  let truncated = afterSeq + 1 < first;
  const floor = params.maxAgeMs === undefined ? 0 : Date.now() - params.maxAgeMs;
  const recent = rows.filter(r => Date.parse(r.timestamp) >= floor);
  if (recent.length < rows.length) truncated = true;
  const limit = Math.min(params.maxEvents ?? DEFAULT_MAX, MAX_EVENTS);
  const page = recent.slice(0, limit);
  const hasMore = recent.length > limit;
  return {
    events: page.map(r => ({ eventId: r.eventId, name: r.name, timestamp: r.timestamp, data: r.data })),
    // Only a full-page cut leaves unread rows behind, so only then must the cursor stop at the last returned row.
    cursor: cursorOf(hasMore ? page[page.length - 1].seq : Math.max(head, afterSeq)),
    truncated, hasMore, nextPollMs: POLL_MS,
  };
}

const asProtocolError = (error: unknown) => error instanceof EventError ? new ProtocolError(error.code, error.message, error.data) : error;

/** Advertises the Events extension and serves events/list, events/poll, events/stream, events/subscribe and events/unsubscribe. Call before the server connects. */
export function attachEvents(server: Server, root: string) {
  server.registerCapabilities({ extensions: { [EVENTS_EXTENSION_ID]: {} } });
  server.setRequestHandler('events/list', { params: ListParams, result: anyResult }, async () => listEvents());
  server.setRequestHandler('events/poll', { params: PollParams, result: anyResult }, (params) => pollEvents(root, params));

  // Push: the request stays open; every message carries the request id as the subscription id. Cancellation ends it.
  server.setRequestHandler('events/stream', { params: StreamParams, result: anyResult }, async (params, ctx) => {
    const { afterSeq, match } = prepare(params);
    const signal = ctx.mcpReq.signal;
    const meta = { [SUB]: ctx.mcpReq.id };
    const heartbeatMs = Math.min(Math.max(params.heartbeatMs ?? DEFAULT_HEARTBEAT, 1000), 60_000);
    const send = (method: string, body: Record<string, unknown>) => ctx.mcpReq.notify({ method, params: { ...body, _meta: meta } });
    const start = await readEvents(root, { name: params.name, afterSeq: Number.MAX_SAFE_INTEGER, match });
    let position = afterSeq ?? start.head;
    await send('notifications/events/active', { cursor: cursorOf(afterSeq === undefined ? start.head : Math.max(position, start.first - 1)), truncated: afterSeq !== undefined && afterSeq + 1 < start.first, heartbeatMs });
    if (afterSeq !== undefined && afterSeq + 1 < start.first) position = start.first - 1;
    const floor = params.maxAgeMs === undefined || afterSeq === undefined ? 0 : Date.now() - params.maxAgeMs;
    let lastSent = Date.now();
    while (!signal.aborted) {
      const { head, first, rows } = await readEvents(root, { name: params.name, afterSeq: position, match });
      if (position + 1 < first) { // retention gap mid-stream: a fresh active with truncated, then carry on
        position = first - 1;
        await send('notifications/events/active', { cursor: cursorOf(position), truncated: true, heartbeatMs });
      }
      for (const r of rows) {
        if (Date.parse(r.timestamp) < floor) continue;
        await send('notifications/events/event', { eventId: r.eventId, name: r.name, timestamp: r.timestamp, data: r.data, cursor: cursorOf(r.seq) });
        lastSent = Date.now();
      }
      position = Math.max(position, head);
      if (Date.now() - lastSent >= heartbeatMs) { await send('notifications/events/heartbeat', { cursor: cursorOf(position) }); lastSent = Date.now(); }
      await sleep(300, signal);
    }
    return {};
  });

  // Webhook: stored here, delivered by the monitor host.
  server.setRequestHandler('events/subscribe', { params: SubscribeParams, result: anyResult }, async (params) => {
    const { args } = prepare(params);
    const { head, first } = await readEvents(root, { name: params.name, afterSeq: Number.MAX_SAFE_INTEGER });
    try {
      return await subscribe(root, { principal: 'windows:' + userInfo().username.toLowerCase(), name: params.name, args, url: params.delivery.url, secret: params.delivery.secret,
        ttlMs: params.ttlMs, cursor: params.cursor, maxAgeMs: params.maxAgeMs, head, first });
    } catch (error) { throw asProtocolError(error); }
  });
  server.setRequestHandler('events/unsubscribe', { params: UnsubscribeParams, result: anyResult }, async (params) => {
    const { args } = prepare(params);
    try { await unsubscribe(root, { principal: 'windows:' + userInfo().username.toLowerCase(), name: params.name, args, url: params.delivery.url }); } catch (error) { throw asProtocolError(error); }
    return {};
  });
}
