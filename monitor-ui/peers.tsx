import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Bot, Check, Copy, KeyRound, MessagesSquare, Monitor, RefreshCw, Search, Send, ShieldCheck, Trash2 } from 'lucide-react';
import { Panel } from './upstream/viz';
import { Button } from './upstream/button';
import { cn } from './utils';

type Kind = 'chat' | 'mail';
type Autonomy = 'safe' | 'full';
type Responder = { enabled: boolean; autonomy: Autonomy };
type Peer = { name: string; url: string; enabled: boolean; paired: boolean; own: boolean; online: boolean | null; allow: Record<Kind, boolean>; responder?: Partial<Responder> };
type Info = { self: { name: string; addresses: string[]; tailscale: boolean }; firewall: { open: boolean; port: number }; peers: Peer[]; responder: Responder };
type Msg = { id: string; box: 'in' | 'out'; at: number; kind: Kind; subject?: string; body: string; read: boolean; hop?: number };
type Summary = { peer: string; unread: number; latest: { at: number; box: Msg['box']; preview: string } };
const field = 'w-full min-w-0 rounded-lg border bg-surface px-3 py-2 text-sm';
const time = (at: number) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const peerStatus = (p: Peer) => !p.enabled ? 'Disabled' : !p.paired ? 'Pairing' : p.online === null ? 'Paired' : p.online ? 'Online' : 'Offline';

async function api(path: string, body?: object) {
  const response = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus': '1' }, body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}

function Chip({ children, active = false }: { children: string; active?: boolean }) {
  return <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium', active ? 'bg-success-soft text-success' : 'bg-surface-3 text-muted-foreground')}>{children}</span>;
}

export function PeersView() {
  const [info, setInfo] = useState<Info | null>(null);
  const [selected, select] = useState('');
  const [mobileThread, showMobileThread] = useState(false);
  const [query, setQuery] = useState('');
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [thread, setThread] = useState<{ peer: string; messages: Msg[] }>();
  const [error, setError] = useState('');
  const [mailError, setMailError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<{ code: string; expiresInMinutes: number } | null>(null);
  const [entered, setEntered] = useState('');
  const [copied, setCopied] = useState(false);
  const history = useRef<HTMLDivElement>(null);
  const last = useRef('');
  const activePeer = info?.peers.find(p => p.name === selected);
  const activeName = activePeer?.paired ? activePeer.name : '';
  const messages = activeName && thread?.peer === activeName ? thread.messages : undefined;
  const newest = messages?.at(-1)?.id;

  const load = useCallback(async () => {
    try {
      const next: Info = await api('/api/peers');
      setInfo(next);
      setError('');
      select(name => next.peers.some(p => p.name === name) ? name : '');
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  const [revision, refreshMail] = useState(0);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        if (activeName) {
          const { messages }: { messages: Msg[] } = await api('/api/mail?peer=' + encodeURIComponent(activeName));
          if (stopped) return;
          setThread({ peer: activeName, messages });
          if (!document.hidden && (window.matchMedia('(min-width: 768px)').matches || mobileThread)) {
            const ids = messages.filter(m => m.box === 'in' && !m.read).map(m => m.id);
            if (ids.length) await api('/api/mail/read', { ids });
          }
        }
        const { threads } = await api('/api/mail?summary');
        if (!stopped) {
          setSummaries(threads);
          setMailError('');
        }
      } catch (e) { if (!stopped) setMailError((e as Error).message); }
      finally { if (!stopped) timer = setTimeout(poll, 2000); }
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [activeName, mobileThread, revision]);

  // An inbox refresh must never move the page or interrupt reading older messages.
  useEffect(() => {
    const key = activeName + ':' + (newest ?? '');
    const box = history.current;
    if (box?.clientHeight && key !== last.current) {
      last.current = key;
      box.scrollTop = box.scrollHeight;
    }
  }, [activeName, newest, mobileThread]);

  async function run(action: () => Promise<unknown>, success = '') {
    setBusy(true);
    setNote('');
    try {
      await action();
      setNote(success);
      await load();
    } catch (e) { setNote((e as Error).message); }
    finally { setBusy(false); }
  }

  if (!info) return <Panel icon={Monitor} title="Devices & agents"><p role="status">{error || 'Loading…'}</p></Panel>;
  const byPeer = new Map(summaries.map(s => [s.peer, s]));
  const search = query.trim().toLowerCase();
  const visible = info.peers.filter(p => p.name.toLowerCase().includes(search) || byPeer.get(p.name)?.latest.preview.toLowerCase().includes(search))
    .sort((a, b) => (byPeer.get(b.name)?.latest.at ?? 0) - (byPeer.get(a.name)?.latest.at ?? 0));

  function open(name: string) {
    select(name);
    showMobileThread(true);
  }

  return <>
    <Panel icon={MessagesSquare} title="Inbox" pad="none" actions={
      <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => api('/api/peers/refresh', {}))}><RefreshCw />Find devices</Button>
    }>
      {(error || note || mailError) && <p role="status" className="border-b px-4 py-2 text-xs text-muted-foreground">{error || note || mailError}</p>}
      <div className="grid min-w-0 md:grid-cols-[minmax(12rem,1fr)_minmax(0,2.4fr)]">
        <section aria-label="Device inbox" className={cn('min-w-0 md:block md:border-r', mobileThread && activePeer && 'hidden')}>
          <div className="relative border-b p-3">
            <Search aria-hidden="true" className="pointer-events-none absolute left-6 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input type="search" aria-label="Search inbox" placeholder="Search inbox" className={cn(field, 'pl-9')} value={query} onChange={e => setQuery(e.target.value)} />
          </div>
          <div className="scrollbar-thin max-h-[32rem] divide-y overflow-y-auto">
            {visible.map(p => {
              const summary = byPeer.get(p.name);
              return <button key={p.name} type="button" aria-current={p.name === selected ? 'true' : undefined}
                className={cn('flex w-full min-w-0 items-start gap-2 px-3 py-3 text-left hover:bg-surface-2', p.name === selected && 'bg-surface-2')}
                onClick={() => open(p.name)}>
                <Monitor className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{p.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{summary ? (summary.latest.box === 'out' ? 'You: ' : '') + summary.latest.preview : 'No messages'}</span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <Chip active={p.enabled && p.paired && p.online === true}>{peerStatus(p)}</Chip>
                  {!!summary?.unread && <span className="rounded-full bg-signal-soft px-2 text-2xs font-semibold text-signal" aria-label={`${summary.unread} unread`}>{summary.unread}</span>}
                </span>
              </button>;
            })}
            {!visible.length && <p className="p-4 text-sm text-muted-foreground">{search ? 'No matching devices' : 'No devices'}</p>}
          </div>
        </section>
        <section aria-label="Conversation" className={cn('min-w-0 md:block', !mobileThread && 'hidden')}>
          {activePeer ? <>
            <header className="flex min-w-0 flex-wrap items-center gap-2 border-b px-4 py-3">
              <Button size="icon-sm" variant="ghost" className="md:hidden" aria-label="Back to inbox" onClick={() => showMobileThread(false)}><ArrowLeft /></Button>
              <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{activePeer.name}</h3>
              <Chip active={activePeer.enabled && activePeer.online === true}>{peerStatus(activePeer)}</Chip>
              {activePeer.own && <Chip>Your device</Chip>}
              <Button size="icon-sm" variant="ghost" aria-label={`Remove ${activePeer.name}`} disabled={busy}
                onClick={() => confirm(`Remove ${activePeer.name}? It can be paired again later.`) && run(() => api('/api/peers/remove', { name: activePeer.name }))}><Trash2 /></Button>
            </header>
            <details key={activePeer.name} className="border-b px-4 py-2 text-sm">
              <summary className="cursor-pointer font-medium">Device settings</summary>
              <div className="mt-3 space-y-3">
                <p className="break-all text-xs text-muted-foreground">{activePeer.url}</p>
                <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
                  <label className="flex items-center gap-2"><input type="checkbox" checked={activePeer.enabled} disabled={busy}
                    onChange={e => run(() => api('/api/peers/set', { name: activePeer.name, enabled: e.target.checked }))} />Device enabled</label>
                  {(['mail', 'chat'] as const).map(kind => <label key={kind} className="flex items-center gap-2">
                    <input type="checkbox" checked={activePeer.allow[kind]} disabled={busy} onChange={e => run(() => api('/api/peers/set', { name: activePeer.name, allow: { [kind]: e.target.checked } }))} />Allow {kind}
                  </label>)}
                  <label className="flex items-center gap-2"><input type="checkbox" role="switch" checked={info.responder.enabled && activePeer.responder?.enabled !== false}
                    disabled={busy || !info.responder.enabled} onChange={e => run(() => api('/api/responder', { peer: activePeer.name, enabled: e.target.checked }))} />Agent auto-reply</label>
                  <label className="flex items-center gap-2">Autonomy
                    <select className="rounded border bg-surface px-2 py-1" value={activePeer.responder?.autonomy ?? ''} disabled={busy}
                      onChange={e => run(() => api('/api/responder', { peer: activePeer.name, autonomy: e.target.value || null }))}>
                      <option value="">Computer default ({info.responder.autonomy})</option><option value="safe">Safe</option><option value="full">Full</option>
                    </select>
                  </label>
                </div>
              </div>
            </details>
            <div ref={history} role="log" aria-label="Messages" tabIndex={0} className="scrollbar-thin flex h-80 flex-col gap-2 overflow-y-auto px-4 py-3 md:h-[26rem]">
              {!messages?.length && <p className="text-sm text-muted-foreground">{!activeName ? 'Pairing pending' : messages ? 'No messages' : mailError ? 'Messages unavailable' : 'Loading messages…'}</p>}
              {messages?.map(m => <article key={m.id} className={cn('max-w-[90%] shrink-0 rounded-lg border px-3 py-2 text-sm', m.box === 'out' ? 'self-end bg-surface-2' : 'self-start bg-surface')}>
                <header className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
                  <span className="font-medium">{m.box === 'out' ? 'You' : activePeer.name}</span>
                  <Chip>{m.kind === 'mail' ? 'Mail' : 'Chat'}</Chip>
                  <time dateTime={new Date(m.at).toISOString()}>{time(m.at)}</time>
                  <span>Hop {m.hop ?? 0}</span>
                  {m.kind === 'chat' && (m.hop ?? 0) > 0 && <span className="inline-flex items-center gap-1"><Bot className="size-3" aria-hidden="true" />Agent replied automatically</span>}
                </header>
                {m.kind === 'mail' && m.subject && <p className="break-words font-medium">{m.subject}</p>}
                <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{m.body}</p>
              </article>)}
            </div>
            {activeName && <Compose key={activeName} peer={activePeer} onSent={() => refreshMail(n => n + 1)} />}
          </> : <p className="p-4 text-sm text-muted-foreground">No conversation selected</p>}
        </section>
      </div>
    </Panel>
    <Panel icon={Monitor} title="This computer" meta={info.self.name}>
      <div className="flex flex-wrap items-center gap-2">
        <Chip active={info.self.tailscale}>{info.self.tailscale ? 'Tailscale connected' : 'Tailscale unavailable'}</Chip>
        <Chip active={info.firewall.open}>{`Port ${info.firewall.port} ${info.firewall.open ? 'open' : 'blocked'}`}</Chip>
        {!info.firewall.open && <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => api('/api/firewall/open', {}))}><ShieldCheck />Open port</Button>}
        <span className="break-all text-xs text-muted-foreground">{info.self.addresses.join(' · ')}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs">
        <label className="flex items-center gap-2"><input type="checkbox" role="switch" checked={info.responder.enabled} disabled={busy}
          onChange={e => run(() => api('/api/responder', { enabled: e.target.checked }))} />Agent auto-reply for this computer</label>
        <label className="flex items-center gap-2">Default autonomy
          <select className="rounded border bg-surface px-2 py-1" value={info.responder.autonomy} disabled={busy}
            onChange={e => run(() => api('/api/responder', { autonomy: e.target.value }))}>
            <option value="safe">Safe</option><option value="full">Full</option>
          </select>
        </label>
      </div>
    </Panel>
    <Panel icon={KeyRound} title="Pair another computer">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => { setCode(await api('/api/peers/code', {})); setCopied(false); })}>Generate code</Button>
          {code && <div className="flex items-center gap-2">
            <code className="min-w-0 break-all rounded bg-surface-2 px-2 py-1 text-xs" aria-label="Pairing code">{code.code}</code>
            <Button size="icon-sm" variant="ghost" aria-label={copied ? 'Code copied' : 'Copy code'}
              onClick={() => run(async () => { await navigator.clipboard.writeText(code.code); setCopied(true); })}>{copied ? <Check /> : <Copy />}</Button>
            <span className="text-xs text-muted-foreground">{code.expiresInMinutes} min</span>
          </div>}
        </div>
        <form className="flex items-start gap-2" onSubmit={e => {
          e.preventDefault();
          void run(async () => {
            const result = await api('/api/peers/pair', { code: entered });
            setEntered('');
            open(result.name);
          }, 'Device paired');
        }}>
          <input aria-label="Pairing code from the other computer" className={field} placeholder="Enter pairing code" autoComplete="off" value={entered} onChange={e => setEntered(e.target.value)} />
          <Button type="submit" size="sm" disabled={busy || !entered.trim()}>Pair</Button>
        </form>
      </div>
    </Panel>
  </>;
}

function Compose({ peer, onSent }: { peer: Peer; onSent: () => void }) {
  const [kind, setKind] = useState<Kind>(peer.allow.chat ? 'chat' : 'mail');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const channel = peer.allow[kind] ? kind : peer.allow.chat ? 'chat' : 'mail';
  const available = peer.enabled && peer.allow[channel];

  async function send() {
    if (!available || sending || !body.trim()) return;
    setSending(true);
    setError('');
    try {
      await api('/api/mail/send', { to: peer.name, kind: channel, subject: channel === 'mail' ? subject.trim() : undefined, body: body.trim() });
      setBody('');
      setSubject('');
      onSent();
    } catch (e) { setError((e as Error).message); }
    finally { setSending(false); }
  }

  return <form className="space-y-2 border-t p-3" onSubmit={e => { e.preventDefault(); void send(); }}>
    {!available && <p className="text-xs text-muted-foreground">{peer.enabled ? 'Chat and mail are disabled' : 'Device disabled'}</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <div className="flex gap-2">
      <select aria-label="Message type" className="rounded-lg border bg-surface px-2 text-sm" value={channel} disabled={!available || sending}
        onChange={e => setKind(e.target.value as Kind)}>
        <option value="chat" disabled={!peer.allow.chat}>Chat</option><option value="mail" disabled={!peer.allow.mail}>Mail</option>
      </select>
      {channel === 'mail' && <input aria-label="Subject" className={field} placeholder="Subject" maxLength={200} disabled={!available || sending} value={subject} onChange={e => setSubject(e.target.value)} />}
    </div>
    <div className="flex items-end gap-2">
      <textarea aria-label="Message" className={field} placeholder="Write a message" rows={2} maxLength={65536} disabled={!available || sending} value={body} onChange={e => setBody(e.target.value)} />
      <Button type="submit" size="sm" disabled={!available || sending || !body.trim()}><Send />{sending ? 'Sending…' : 'Send'}</Button>
    </div>
  </form>;
}
