import { useCallback, useEffect, useState } from 'react';
import { apiUrl } from './data';
import { cn } from './utils';

export type Kind = 'chat' | 'mail';
export type Autonomy = 'safe' | 'full';
export type Responder = { enabled: boolean; autonomy: Autonomy };
export type Peer = { name: string; url: string; enabled: boolean; paired: boolean; own: boolean; route?: 'lan' | 'tailscale' | 'relay'; online: boolean | null; allow: Record<Kind, boolean>; responder?: Partial<Responder> };
export type Info = { self: { name: string; addresses: string[]; tailscale: boolean }; peers: Peer[]; responder: Responder };
type InboxPeerInfo = Pick<Info, 'peers' | 'responder'>;
export type Msg = { id: string; box: 'in' | 'out'; at: number; kind: Kind; subject?: string; body: string; read: boolean; hop?: number };
export type Summary = { peer: string; unread: number; latest: { at: number; box: Msg['box']; preview: string } };

export const field = 'w-full min-w-0 rounded-lg border bg-surface px-3 py-2 text-sm';
export const time = (at: number) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export const peerStatus = (p: Peer) => !p.enabled ? 'Disabled' : !p.paired ? 'Pairing' : p.online === null ? 'Paired' : p.online ? 'Online' : 'Offline';

export async function api(path: string, body?: object) {
  const response = await fetch(apiUrl(path), body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus': '1' }, body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}

export function Chip({ children, active = false }: { children: string; active?: boolean }) {
  return <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium', active ? 'bg-success-soft text-success' : 'bg-surface-3 text-muted-foreground')}>{children}</span>;
}

/** Computers known to this Nexus, refreshed every five seconds. */
export function usePeerInfo<View extends 'devices' | 'inbox' = 'devices'>(view?: View) {
  const [info, setInfo] = useState<(View extends 'inbox' ? InboxPeerInfo : Info) | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    try { setInfo(await api(view === 'inbox' ? '/api/peers?view=inbox' : '/api/peers')); setError(''); } catch (e) { setError((e as Error).message); }
  }, [view]);
  useEffect(() => {
    void reload();
    const timer = setInterval(reload, 5000);
    return () => clearInterval(timer);
  }, [reload]);
  return { info, error, reload };
}

/** Forwarded GitLab events arrive as mail whose body is a small JSON record; show them as one line, not as JSON. */
export function describe(m: Msg): { event: boolean; title?: string; detail: string } {
  const text = m.body.trim();
  if (m.kind === 'mail' && text.startsWith('{')) {
    try {
      const e = JSON.parse(text) as Record<string, unknown>;
      if (typeof e.kind === 'string' && typeof e.project === 'string') return { event: true, title: m.subject || String(e.title ?? 'Event'), detail: `${e.kind.replaceAll('_', ' ')} · ${e.project}` };
    } catch { /* not an event record: show the text */ }
  }
  return { event: false, title: m.kind === 'mail' ? m.subject : undefined, detail: m.body };
}
