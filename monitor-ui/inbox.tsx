import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Bell, Bot, Monitor, Search, Send, Settings2 } from 'lucide-react';
import { Button } from './upstream/button';
import { cn } from './utils';
import { Chip, Kind, Msg, Peer, Summary, api, describe, field, peerStatus, time, usePeerInfo } from './mail';

// A messaging page: the list and the thread fill the window, the thread scrolls inside, the composer stays put.
export function InboxView({ peer, open }: { peer: string; open: (name: string) => void }) {
  const { info, error } = usePeerInfo();
  const [query, setQuery] = useState('');
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [thread, setThread] = useState<{ peer: string; messages: Msg[] }>();
  const [mailError, setMailError] = useState('');
  const [mobileThread, showMobileThread] = useState(false);
  const [revision, refreshMail] = useState(0);
  const history = useRef<HTMLDivElement>(null);
  const last = useRef('');

  const peers = info?.peers ?? [];
  const byPeer = new Map(summaries.map(s => [s.peer, s]));
  const recent = (p: Peer) => byPeer.get(p.name)?.latest.at ?? 0;
  const ordered = [...peers].sort((a, b) => recent(b) - recent(a));
  const active = peers.find(p => p.name === peer) ?? (info && window.matchMedia('(min-width: 768px)').matches ? ordered[0] : undefined);
  const activeName = active?.paired ? active.name : '';
  const messages = activeName && thread?.peer === activeName ? thread.messages : undefined;
  const newest = messages?.at(-1)?.id;

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
        if (!stopped) { setSummaries(threads); setMailError(''); }
      } catch (e) { if (!stopped) setMailError((e as Error).message); }
      finally { if (!stopped) timer = setTimeout(poll, 2000); }
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [activeName, mobileThread, revision]);

  // A refresh must never move the page or interrupt reading older messages: only a new newest message scrolls to the bottom.
  useEffect(() => {
    const key = activeName + ':' + (newest ?? '');
    const box = history.current;
    if (box?.clientHeight && key !== last.current) { last.current = key; box.scrollTop = box.scrollHeight; }
  }, [activeName, newest, mobileThread]);

  if (!info) return <p role="status" className="text-sm text-muted-foreground">{error || 'Loading…'}</p>;
  if (!peers.length) return <div className="rounded-2xl border bg-canvas p-8 text-center">
    <p className="text-sm font-medium">No computers paired yet</p>
    <p className="mt-1 text-xs text-muted-foreground">Messages from paired computers appear here.</p>
    <a href="#/peers" className="mt-4 inline-flex h-8 items-center rounded-lg border px-3 text-xs font-medium hover:bg-surface-2">Pair a computer</a>
  </div>;

  const search = query.trim().toLowerCase();
  const visible = ordered.filter(p => p.name.toLowerCase().includes(search) || byPeer.get(p.name)?.latest.preview.toLowerCase().includes(search));

  return <div className="flex h-[calc(100dvh-11.5rem)] min-h-[24rem] min-w-0 overflow-hidden rounded-2xl border bg-canvas md:h-[calc(100dvh-7.5rem)]">
    <aside aria-label="Conversations" className={cn('flex w-full min-w-0 flex-col md:w-72 md:shrink-0 md:border-r', mobileThread && active && 'hidden md:flex')}>
      <div className="relative border-b p-3">
        <Search aria-hidden="true" className="pointer-events-none absolute left-6 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input type="search" aria-label="Search inbox" placeholder="Search inbox" className={cn(field, 'pl-9')} value={query} onChange={e => setQuery(e.target.value)} />
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 divide-y overflow-y-auto">
        {visible.map(p => {
          const summary = byPeer.get(p.name);
          return <button key={p.name} type="button" aria-current={p.name === active?.name ? 'true' : undefined}
            className={cn('flex w-full min-w-0 items-start gap-2.5 px-3 py-3 text-left hover:bg-surface-2', p.name === active?.name && 'bg-surface-2')}
            onClick={() => { open(p.name); showMobileThread(true); }}>
            <Monitor className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2"><span className="truncate text-sm font-medium">{p.name}</span><span className={cn('size-1.5 shrink-0 rounded-full', p.enabled && p.online ? 'bg-success' : 'bg-border-strong')} role="img" aria-label={peerStatus(p)} /></span>
              <span className="block truncate text-xs text-muted-foreground">{summary ? (summary.latest.box === 'out' ? 'You: ' : '') + summary.latest.preview : 'No messages'}</span>
            </span>
            {!!summary?.unread && <span className="rounded-full bg-signal-soft px-2 text-2xs font-semibold text-signal" aria-label={`${summary.unread} unread`}>{summary.unread}</span>}
          </button>;
        })}
        {!visible.length && <p className="p-4 text-sm text-muted-foreground">No matching devices</p>}
      </div>
    </aside>
    <section aria-label="Conversation" className={cn('flex min-w-0 flex-1 flex-col', !(mobileThread && active) && 'hidden md:flex')}>
      {active ? <>
        <header className="flex min-w-0 shrink-0 items-center gap-2 border-b px-4 py-2.5">
          <Button size="icon-sm" variant="ghost" className="md:hidden" aria-label="Back to inbox" onClick={() => showMobileThread(false)}><ArrowLeft /></Button>
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{active.name}</h2>
          <Chip active={active.enabled && active.online === true}>{peerStatus(active)}</Chip>
          <a href="#/peers" aria-label={`Settings for ${active.name}`} title="Device settings" className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-2 hover:text-foreground"><Settings2 className="size-4" aria-hidden="true" /></a>
        </header>
        {mailError && <p role="status" className="shrink-0 border-b px-4 py-2 text-xs text-muted-foreground">{mailError}</p>}
        <div ref={history} role="log" aria-label="Messages" tabIndex={0} className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
          {!messages?.length && <p className="text-sm text-muted-foreground">{!activeName ? 'Pairing pending' : messages ? 'No messages yet' : mailError ? 'Messages unavailable' : 'Loading messages…'}</p>}
          {messages?.map(m => <Message key={m.id} m={m} name={active.name} />)}
        </div>
        {activeName && <Compose key={activeName} peer={active} onSent={() => refreshMail(n => n + 1)} />}
      </> : <p className="p-4 text-sm text-muted-foreground">Select a computer to read its messages.</p>}
    </section>
  </div>;
}

function Message({ m, name }: { m: Msg; name: string }) {
  const d = describe(m);
  if (d.event) return <p className="mx-auto flex max-w-full shrink-0 items-center gap-2 rounded-full bg-surface-2 px-3 py-1 text-xs text-muted-foreground">
    <Bell className="size-3 shrink-0" aria-hidden="true" /><span className="truncate"><span className="font-medium text-foreground">{d.title}</span> · {d.detail}</span>
    <time className="shrink-0" dateTime={new Date(m.at).toISOString()}>{time(m.at)}</time>
  </p>;
  const auto = m.kind === 'chat' && (m.hop ?? 0) > 0;
  return <article className={cn('max-w-[85%] shrink-0 rounded-xl border px-3 py-2 text-sm', m.box === 'out' ? 'self-end bg-surface-2' : 'self-start bg-surface')}>
    <header className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
      <span className="font-medium">{m.box === 'out' ? 'You' : name}</span>
      {m.kind === 'mail' && <Chip>Mail</Chip>}
      <time dateTime={new Date(m.at).toISOString()}>{time(m.at)}</time>
      {auto && <span className="inline-flex items-center gap-1"><Bot className="size-3" aria-hidden="true" />Agent replied automatically</span>}
    </header>
    {d.title && <p className="break-words font-medium">{d.title}</p>}
    <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{d.detail}</p>
  </article>;
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

  return <form className="shrink-0 space-y-2 border-t p-3" onSubmit={e => { e.preventDefault(); void send(); }}>
    {!available && <p className="text-xs text-muted-foreground">{peer.enabled ? 'Chat and mail are turned off for this computer in Devices.' : 'This computer is turned off in Devices.'}</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <div className="flex gap-2">
      <select aria-label="Message type" className="rounded-lg border bg-surface px-2 text-sm" value={channel} disabled={!available || sending}
        onChange={e => setKind(e.target.value as Kind)}>
        <option value="chat" disabled={!peer.allow.chat}>Chat</option><option value="mail" disabled={!peer.allow.mail}>Mail</option>
      </select>
      {channel === 'mail' && <input aria-label="Subject" className={field} placeholder="Subject" maxLength={200} disabled={!available || sending} value={subject} onChange={e => setSubject(e.target.value)} />}
    </div>
    <div className="flex items-end gap-2">
      <textarea aria-label="Message" className={field} placeholder="Write a message" rows={2} maxLength={65536} disabled={!available || sending} value={body} onChange={e => setBody(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }} />
      <Button type="submit" size="sm" disabled={!available || sending || !body.trim()}><Send />{sending ? 'Sending…' : 'Send'}</Button>
    </div>
  </form>;
}
