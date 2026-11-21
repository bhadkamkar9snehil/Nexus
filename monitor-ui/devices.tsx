import { useState } from 'react';
import { Check, Copy, KeyRound, MessagesSquare, Monitor, Network, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { Panel } from './upstream/viz';
import { Button } from './upstream/button';
import { Chip, Peer, api, field, peerStatus, usePeerInfo } from './mail';

const cell = 'px-3 py-2.5 align-middle';

export function DevicesView() {
  const { info, error, reload } = usePeerInfo();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [code, setCode] = useState<{ code: string; expiresInMinutes: number } | null>(null);
  const [entered, setEntered] = useState('');
  const [pairAutoReply, setPairAutoReply] = useState(false);
  const [copied, setCopied] = useState(false);

  async function run(action: () => Promise<unknown>, success = '') {
    setBusy(true);
    setNote('');
    try { await action(); setNote(success); await reload(); } catch (e) { setNote((e as Error).message); } finally { setBusy(false); }
  }

  if (!info) return <p role="status" className="text-sm text-muted-foreground">{error || 'Loading…'}</p>;
  const set = (p: Peer, change: object) => run(() => api('/api/peers/set', { name: p.name, ...change }));
  const reply = (p: Peer, change: object) => run(() => api('/api/responder', { peer: p.name, ...change }));

  return <>
    {(error || note) && <p role="status" className="rounded-lg bg-surface-2 px-4 py-2 text-xs text-muted-foreground">{error || note}</p>}
    <Panel icon={Monitor} title="This computer" meta={info.self.name}>
      <div className="flex flex-wrap items-center gap-2">
        <Chip active={info.self.tailscale}>{info.self.tailscale ? 'Tailscale connected' : 'Tailscale unavailable'}</Chip>
        <Chip active={info.firewall.open}>{`Port ${info.firewall.port} ${info.firewall.open ? 'open' : 'blocked'}`}</Chip>
        {!info.firewall.open && <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => api('/api/firewall/open', {}))}><ShieldCheck />Open port</Button>}
        <span className="min-w-0 break-all text-xs text-muted-foreground">{info.self.addresses.join(' · ')}</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
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

    <Panel icon={Network} title="Paired computers" pad="none" actions={<>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => api('/api/peers/refresh', {}))}><RefreshCw />Find devices</Button>
      <Button size="sm" variant={pairing ? 'soft' : 'outline'} aria-expanded={pairing} onClick={() => setPairing(!pairing)}><KeyRound />Pair a computer</Button>
    </>}>
      {pairing && <div className="grid gap-4 border-b p-4 sm:grid-cols-2">
        <div className="space-y-2">
          <p className="text-sm font-medium">Show a code on this computer</p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => { setCode(await api('/api/peers/code', { autoReply: pairAutoReply })); setCopied(false); setPairAutoReply(false); })}>Generate code</Button>
          {code && <div className="flex items-center gap-2">
            <code className="min-w-0 break-all rounded bg-surface-2 px-2 py-1 text-xs" aria-label="Pairing code">{code.code}</code>
            <Button size="icon-sm" variant="ghost" aria-label={copied ? 'Code copied' : 'Copy code'}
              onClick={() => run(async () => { await navigator.clipboard.writeText(code.code); setCopied(true); })}>{copied ? <Check /> : <Copy />}</Button>
            <span className="text-xs text-muted-foreground">{code.expiresInMinutes} min</span>
          </div>}
        </div>
        <form className="space-y-2" onSubmit={e => {
          e.preventDefault();
          void run(async () => { await api('/api/peers/pair', { code: entered, autoReply: pairAutoReply }); setEntered(''); setPairAutoReply(false); }, 'Computer paired');
        }}>
          <p className="text-sm font-medium">Enter a code from the other computer</p>
          <div className="flex items-start gap-2">
            <input aria-label="Pairing code from the other computer" className={field} placeholder="Pairing code" autoComplete="off" value={entered} onChange={e => setEntered(e.target.value)} />
            <Button type="submit" size="sm" disabled={busy || !entered.trim()}>Pair</Button>
          </div>
        </form>
        <label className="flex items-center gap-2 text-xs sm:col-span-2"><input type="checkbox" checked={pairAutoReply} onChange={e => setPairAutoReply(e.target.checked)} />Turn on agent auto-reply for the computer being paired</label>
      </div>}
      {info.peers.length ? <div className="scrollbar-thin relative overflow-x-auto">
        <table className="w-full min-w-[46rem] text-left text-xs">
          <thead className="text-muted-foreground"><tr>
            {['Computer', 'Status', 'Enabled', 'Mail', 'Chat', 'Auto-reply', 'Autonomy', ''].map(h => <th key={h || 'actions'} scope="col" className="border-b px-3 py-2 font-medium">{h || <span className="sr-only">Actions</span>}</th>)}
          </tr></thead>
          <tbody>
            {info.peers.map(p => <tr key={p.name} className="border-b last:border-0">
              <th scope="row" className={cell + ' font-normal'}>
                <span className="flex items-center gap-2"><span className="text-sm font-medium">{p.name}</span>{p.own && <Chip>Your device</Chip>}</span>
                <span className="block break-all text-muted-foreground">{p.url}</span>
              </th>
              <td className={cell}><Chip active={p.enabled && p.paired && p.online === true}>{peerStatus(p)}</Chip></td>
              <td className={cell}><input type="checkbox" role="switch" aria-label={`${p.name} enabled`} checked={p.enabled} disabled={busy} onChange={e => set(p, { enabled: e.target.checked })} /></td>
              {(['mail', 'chat'] as const).map(kind => <td key={kind} className={cell}>
                <input type="checkbox" aria-label={`${p.name} allow ${kind}`} checked={p.allow[kind]} disabled={busy} onChange={e => set(p, { allow: { [kind]: e.target.checked } })} />
              </td>)}
              <td className={cell}><input type="checkbox" role="switch" aria-label={`${p.name} agent auto-reply`} checked={info.responder.enabled && p.responder?.enabled !== false}
                disabled={busy || !info.responder.enabled} onChange={e => reply(p, { enabled: e.target.checked })} /></td>
              <td className={cell}>
                <select aria-label={`${p.name} autonomy`} className="rounded border bg-surface px-2 py-1" value={p.responder?.autonomy ?? ''} disabled={busy} onChange={e => reply(p, { autonomy: e.target.value || null })}>
                  <option value="">Default ({info.responder.autonomy})</option><option value="safe">Safe</option><option value="full">Full</option>
                </select>
              </td>
              <td className={cell + ' whitespace-nowrap text-right'}>
                <a href={'#/inbox/' + encodeURIComponent(p.name)} aria-label={`Open inbox for ${p.name}`} title="Open inbox" className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-2 hover:text-foreground"><MessagesSquare className="size-4" aria-hidden="true" /></a>
                <Button size="icon-sm" variant="ghost" aria-label={`Remove ${p.name}`} title="Remove" disabled={busy}
                  onClick={() => confirm(`Remove ${p.name}? It can be paired again later.`) && run(() => api('/api/peers/remove', { name: p.name }))}><Trash2 /></Button>
              </td>
            </tr>)}
          </tbody>
        </table>
      </div> : <p className="p-4 text-sm text-muted-foreground">No computers paired yet. Use Pair a computer to add one.</p>}
    </Panel>
  </>;
}
