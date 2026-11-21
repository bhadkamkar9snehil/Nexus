import {useCallback,useEffect,useRef,useState} from 'react';
import {Bot,Check,Copy,KeyRound,MessagesSquare,Monitor,RefreshCw,Send,ShieldCheck,Trash2} from 'lucide-react';
import {Panel} from './upstream/viz';
import {Button} from './upstream/button';
import {cn} from './utils';

type Peer={name:string;url:string;enabled:boolean;paired:boolean;own:boolean;online:boolean|null;os:string|null;allow:{mail:boolean;chat:boolean}};
type Info={self:{name:string;addresses:string[];tailscale:boolean};firewall:{admin:boolean;open:boolean;created:boolean;port:number};peers:Peer[];responder:{enabled:boolean;autonomy:'safe'|'full'}};
type Msg={id:string;box:'in'|'out';at:number;peer:string;kind:string;subject?:string;body:string;read?:boolean};
const field='w-full rounded-lg border bg-surface px-3 py-2 text-sm';
// Same-origin JSON calls; the X-Nexus header is what the monitor requires for anything that changes state.
async function api(path:string,body?:object){
 const r=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Nexus':'1'},body:JSON.stringify(body)});
 const j=await r.json().catch(()=>({}));
 if(!r.ok)throw new Error(j.error||'Request failed');
 return j;
}
const Chip=({tone,children}:{tone:'ok'|'warn'|'idle';children:string})=><span className={cn('rounded-full px-2 py-0.5 text-2xs font-medium',tone==='ok'&&'bg-success-soft text-success',tone==='warn'&&'bg-warning-soft text-warning',tone==='idle'&&'bg-surface-3 text-muted-foreground')}>{children}</span>;
const time=(t:number)=>new Date(t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});

export function PeersView(){
 const [info,Info]=useState<Info|null>(null),[error,Error_]=useState(''),[note,Note]=useState(''),[busy,Busy]=useState(''),[sel,Sel]=useState(''),[msgs,Msgs]=useState<Msg[]>([]),[draft,Draft]=useState(''),[code,Code]=useState<{code:string;expiresInMinutes:number}|null>(null),[entered,Entered]=useState(''),[copied,Copied]=useState(false);
 const end=useRef<HTMLDivElement>(null);
 const load=useCallback(async()=>{try{const i=await api('/api/peers');Info(i);Error_('');Sel(s=>s&&i.peers.some((p:Peer)=>p.name===s)?s:i.peers.find((p:Peer)=>p.paired)?.name??'');}catch(e){Error_((e as Error).message);}},[]);
 const loadMsgs=useCallback(async()=>{if(!sel)return Msgs([]);try{Msgs((await api('/api/mail?peer='+encodeURIComponent(sel))).messages);}catch{/* next refresh */}},[sel]);
 useEffect(()=>{load();const t=setInterval(load,5000);return()=>clearInterval(t);},[load]);
 useEffect(()=>{loadMsgs();const t=setInterval(loadMsgs,2000);return()=>clearInterval(t);},[loadMsgs]);
 useEffect(()=>{end.current?.scrollIntoView({block:'end'});const unread=msgs.filter(m=>m.box==='in'&&!m.read).map(m=>m.id);if(unread.length)api('/api/mail/read',{ids:unread}).catch(()=>{});},[msgs]);
 const run=async(label:string,fn:()=>Promise<unknown>,ok='')=>{Busy(label);Note('');try{await fn();if(ok)Note(ok);await load();}catch(e){Note((e as Error).message);}Busy('');};
 const send=async()=>{const body=draft.trim();if(!body||!sel)return;Draft('');try{await api('/api/mail/send',{to:sel,body,kind:'chat'});loadMsgs();}catch(e){Note((e as Error).message);Draft(body);}};
 if(!info)return <Panel icon={Monitor} title="Devices" meta={error||'Loading'}><p className="text-sm text-muted-foreground">{error?'The Nexus monitor is not answering. Start it and reopen this page.':'Loading…'}</p></Panel>;
 const paired=info.peers.filter(p=>p.paired),waiting=info.peers.filter(p=>!p.paired);
 return <>
  <Panel icon={Monitor} title="This computer" meta={info.self.name}><div className="flex flex-wrap items-center gap-2 text-sm">
   <Chip tone={info.self.tailscale?'ok':'idle'}>{info.self.tailscale?'Tailscale connected':'Tailscale not found'}</Chip>
   <Chip tone={info.firewall.open?'ok':'warn'}>{info.firewall.open?`Port ${info.firewall.port} open`:`Port ${info.firewall.port} blocked`}</Chip>
   {!info.firewall.open&&<Button size="sm" variant="outline" disabled={!!busy} onClick={()=>run('fw',()=>api('/api/firewall/open',{}),'')}><ShieldCheck/>Open port</Button>}
   <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">{info.self.addresses.join('  ·  ')}</span></div>
   {!info.firewall.open&&<p className="mt-2 text-xs text-muted-foreground">Windows Firewall blocks other computers from reaching Nexus. {info.firewall.admin?'Press Open port.':'Nexus opens the port by itself when it runs as administrator; start it once as administrator.'}</p>}
   {note&&<p role="status" className="mt-2 text-xs text-muted-foreground">{note}</p>}</Panel>
  <Panel icon={Monitor} title="Devices" meta={paired.length?`${paired.length} paired`:'None paired yet'} pad="none"><div className="divide-y">
   {info.peers.map(p=><div key={p.name} className={cn('flex flex-wrap items-center gap-3 px-4 py-3',sel===p.name&&'bg-surface-2')}>
    <button className="min-w-0 flex-1 text-left" disabled={!p.paired} onClick={()=>Sel(p.name)} aria-label={`Open conversation with ${p.name}`}><span className="block truncate text-sm font-medium">{p.name}</span><span className="block truncate text-xs text-subtle-foreground">{p.url}</span></button>
    {p.own&&<Chip tone="ok">Your device</Chip>}
    <Chip tone={!p.paired?'warn':p.online===false?'idle':'ok'}>{!p.paired?'Pairing':p.online===false?'Offline':p.online?'Online':'Paired'}</Chip>
    <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={p.enabled} disabled={!!busy} onChange={e=>run('set',()=>api('/api/peers/set',{name:p.name,enabled:e.target.checked}))}/>Allowed</label>
    <Button size="icon-sm" variant="ghost" aria-label={`Remove ${p.name}`} disabled={!!busy} onClick={()=>confirm(`Remove ${p.name}? It can be paired again later.`)&&run('rm',()=>api('/api/peers/remove',{name:p.name}))}><Trash2/></Button></div>)}
   {!info.peers.length&&<p className="p-4 text-sm text-muted-foreground">{info.self.tailscale?'Your other computers on this Tailscale account pair by themselves within a minute when Nexus is running on them.':'Install Tailscale to pair your own computers automatically, or pair with a code below.'}</p>}
   {!!waiting.length&&<p className="px-4 py-2 text-xs text-muted-foreground">{waiting.length} device(s) waiting for the other side to finish pairing.</p>}</div>
   <div className="border-t px-4 py-3"><Button size="sm" variant="outline" disabled={!!busy} onClick={()=>run('find',()=>api('/api/peers/refresh',{}),'Looked for new devices on your Tailscale account.')}><RefreshCw/>Find my devices now</Button></div></Panel>
  <Panel icon={KeyRound} title="Pair another computer" meta="Teammates and computers outside your Tailscale account"><div className="grid gap-6 md:grid-cols-2">
   <section className="space-y-2"><h3 className="text-sm font-medium">Show a code</h3><p className="text-xs text-muted-foreground">Give this code to the other person. It works once, for {code?.expiresInMinutes??10} minutes.</p>
    {code?<div className="flex items-center gap-2"><code className="min-w-0 flex-1 break-all rounded bg-surface-2 px-2 py-1 text-xs" aria-label="Pairing code">{code.code}</code><Button size="icon-sm" variant="ghost" aria-label="Copy code" onClick={()=>{navigator.clipboard.writeText(code.code);Copied(true);setTimeout(()=>Copied(false),1500);}}>{copied?<Check/>:<Copy/>}</Button></div>
     :<Button size="sm" variant="outline" disabled={!!busy} onClick={()=>run('code',async()=>Code(await api('/api/peers/code',{})))}>Generate code</Button>}</section>
   <section className="space-y-2"><h3 className="text-sm font-medium">Enter a code</h3><p className="text-xs text-muted-foreground">Paste the code shown on the other computer.</p>
    <input aria-label="Pairing code from the other computer" className={field} placeholder="nexus-…" autoComplete="off" value={entered} onChange={e=>Entered(e.target.value)}/>
    <Button size="sm" disabled={!!busy||!entered.trim()} onClick={()=>run('pair',async()=>{const r=await api('/api/peers/pair',{code:entered});Entered('');Sel(r.name);},'Paired.')}>Pair</Button></section></div></Panel>
  <Panel icon={MessagesSquare} title="Conversation" meta={sel||'Select a paired device'} pad="none">
   <div className="scrollbar-thin flex max-h-[26rem] min-h-40 flex-col gap-2 overflow-y-auto px-4 py-3" aria-live="polite">
    {!msgs.length&&<p className="text-sm text-muted-foreground">{sel?'No messages yet. Write below; the agent on that computer answers when it is set to.':'Pair a device to start.'}</p>}
    {msgs.map(m=><div key={m.id} className={cn('max-w-[85%] rounded-lg px-3 py-2 text-sm',m.box==='out'?'self-end bg-surface-3':'self-start border bg-surface')}>
     {m.subject&&m.kind==='mail'&&<p className="text-xs font-medium">{m.subject}</p>}<p className="whitespace-pre-wrap break-words">{m.body}</p><p className="mt-1 text-2xs text-subtle-foreground">{m.box==='out'?'You':m.peer} · {time(m.at)}</p></div>)}
    <div ref={end}/></div>
   <form className="flex gap-2 border-t px-4 py-3" onSubmit={e=>{e.preventDefault();send();}}><input aria-label="Message" className={field} placeholder={sel?`Message ${sel}`:'Select a device'} disabled={!sel} value={draft} onChange={e=>Draft(e.target.value)}/><Button type="submit" size="sm" disabled={!sel||!draft.trim()}><Send/>Send</Button></form></Panel>
  <Panel icon={Bot} title="Agent replies" meta="Let my agent answer my other computers"><div className="max-w-xl space-y-3">
   <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={info.responder.enabled} disabled={!!busy} onChange={e=>run('resp',()=>api('/api/responder',{enabled:e.target.checked}))}/>When one of my own computers sends a chat message, run my agent and send its answer back</label>
   <label className="block text-sm"><span className="mb-1 block text-xs text-muted-foreground">What the agent may do</span><select className={field} value={info.responder.autonomy} disabled={!!busy||!info.responder.enabled} onChange={e=>run('resp',()=>api('/api/responder',{autonomy:e.target.value}))}>
    <option value="safe">Nexus tools only (files, search, messages)</option><option value="full">Everything, without asking (commands, edits, any tool)</option></select></label>
   <p className="text-xs text-muted-foreground">Only computers of your own Tailscale account trigger the agent, never devices paired with a code. A conversation stops after six steps or when the agent answers NO_REPLY.</p></div></Panel>
 </>;
}
