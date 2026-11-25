import {useCallback,useEffect,useState} from 'react';
import {BookOpen,Check,ExternalLink,KeyRound,Moon,Palette,Settings,Sun,Wrench} from 'lucide-react';
import {Panel} from './upstream/viz';
import {Button} from './upstream/button';
import {cn} from './utils';

const swatches=['#4ceea8','#4cd9ee','#6aa8ff','#a78bfa','#f472b6','#fbbf24','#fb923c'];
const steps=[{title:'Install once',body:'Extract the deployment outside AppData. Run Setup.ps1 and enroll your TypeSafe key at the masked prompt. Setup registers missing agent connections and managed monitor startup.'},{title:'Connect Codex and Claude',body:'Reconnect the agents to discover shared_jev. Both use the same tool contracts, desktop service and search backend. Read AGENTS.md or load the bundled shared-harness skill before the first task.'},{title:'Choose the right capability',body:'Find names with UFFS, content with ripgrep, websites with the browser tool and Windows controls with the desktop tool. Use Jev for uncertain choices, result ranking, failure classification and evidence checks.'},{title:'Verify the outcome',body:'Use an explicit end condition. Read the final application state; a successful tool call or configured credential is not proof of the requested outcome.'}];

type Host={postMessage:(m:unknown)=>void;addEventListener:(t:'message',f:(e:{data:any})=>void)=>void;removeEventListener:(t:'message',f:(e:{data:any})=>void)=>void};
export const host=():Host|undefined=>(window as any).chrome?.webview;
type Info={root:string;keySaved:boolean;tools:string[];keys:string[];mapping:Record<string,string>};
export type Reply={ok:boolean;message?:string;info?:Info;[k:string]:any};
let seq=0;
export const call=(msg:Record<string,unknown>,timeout=300000):Promise<Reply>=>new Promise(resolve=>{
 const h=host();if(!h){resolve({ok:false,message:'Key and setup actions need the Nexus desktop app.'});return;}
 const id=++seq;const done=(e:{data:any})=>{if(e.data?.id!==id)return;h.removeEventListener('message',done);clearTimeout(t);resolve(e.data);};
 const t=setTimeout(()=>{h.removeEventListener('message',done);resolve({ok:false,message:'The desktop app did not respond.'});},timeout);
 h.addEventListener('message',done);h.postMessage({...msg,id});
});

const field='w-full rounded-lg border bg-surface px-3 py-2 text-sm';
const Note=({text}:{text:string})=>text?<p role="status" className="text-xs text-muted-foreground">{text}</p>:null;

function Keys(){
 const [info,Info]=useState<Info|null>(null),[note,Note1]=useState(''),[busy,Busy]=useState(false);
 const [key,Key]=useState(''),[alias,Alias]=useState(''),[named,Named]=useState(''),[tool,Tool]=useState(''),[assigned,Assigned]=useState('');
 const apply=(r:Reply)=>{if(r.info){Info(r.info);Tool(t=>t||r.info!.tools[0]||'');}if(r.message)Note1(r.message);};
 const load=useCallback(async()=>apply(await call({type:'status'})),[]);
 useEffect(()=>{load();},[load]);
 useEffect(()=>{if(info&&tool)Assigned(info.mapping[tool]??'');},[info,tool]);
 const run=async(msg:Record<string,unknown>,clear?:()=>void)=>{Busy(true);const r=await call(msg);Busy(false);if(r.ok)clear?.();apply(r);};
 if(!host())return <Panel icon={KeyRound} title="Keys and setup" meta="Desktop app only"><p className="text-sm text-muted-foreground">Open the Nexus desktop app to save TypeSafe keys, assign keys to tools, or set up and repair the harness.</p></Panel>;
 return <Panel icon={KeyRound} title="Keys and setup" meta={info?info.root:'Reading installation'}><div className="max-w-xl space-y-6">
  <section className="space-y-2"><h3 className="text-sm font-medium">TypeSafe API key</h3><p className="text-xs text-muted-foreground">{info?.keySaved?'A key is saved for this Windows account. Saving a new key replaces it.':'No key is saved for this installation.'}</p>
   <input type="password" aria-label="TypeSafe API key" autoComplete="off" className={field} value={key} onChange={e=>Key(e.target.value)}/>
   <Button size="sm" disabled={busy||!key.trim()} onClick={()=>run({type:'saveKey',key},()=>Key(''))}>Save API key</Button></section>
  <section className="space-y-2"><h3 className="text-sm font-medium">Keys for individual tools</h3><p className="text-xs text-muted-foreground">Save a named key, then assign it to a tool. Other tools use the default key.</p>
   <input aria-label="Key name" maxLength={40} placeholder="Key name" className={field} value={alias} onChange={e=>Alias(e.target.value)}/>
   <input type="password" aria-label="Named TypeSafe API key" autoComplete="off" placeholder="API key" className={field} value={named} onChange={e=>Named(e.target.value)}/>
   <Button size="sm" disabled={busy||!alias.trim()||!named.trim()} onClick={()=>run({type:'saveNamedKey',alias:alias.trim(),key:named},()=>{Named('');Alias('');})}>Save named key</Button>
   <div className="grid gap-2 pt-2 sm:grid-cols-2"><select aria-label="Tool" className={field} value={tool} onChange={e=>Tool(e.target.value)}>{info?.tools.map(t=><option key={t}>{t}</option>)}</select>
    <select aria-label="Key for selected tool" className={field} value={assigned} onChange={e=>Assigned(e.target.value)}><option value="">Use default key</option>{info?.keys.map(k=><option key={k}>{k}</option>)}</select></div>
   <Button size="sm" variant="outline" disabled={busy||!tool} onClick={()=>run({type:'assign',tool,alias:assigned})}>Save tool assignment</Button></section>
  <section className="space-y-2"><h3 className="text-sm font-medium">Harness and agents</h3><p className="text-xs text-muted-foreground">Sets up the monitor, search, desktop driver and available Codex and Claude registrations. Registrations belonging to another installation are preserved.</p>
   <Button size="sm" variant="outline" disabled={busy} onClick={()=>run({type:'setup'})}><Wrench/>Set up or repair</Button></section>
  <Note text={note}/></div></Panel>;
}

export function SettingsView({accent,setAccent,dark,theme}:{accent:string;setAccent:(c:string)=>void;dark:boolean;theme:()=>void}){
 return <><Panel icon={Palette} title="Appearance" meta="Theme and accent colour"><div className="max-w-xl space-y-6"><div className="flex items-center justify-between gap-4"><span className="text-sm">Theme</span><Button variant="outline" size="sm" onClick={theme}>{dark?<Sun/>:<Moon/>}{dark?'Use light theme':'Use dark theme'}</Button></div><fieldset><legend className="mb-3 text-sm">Accent colour</legend><div className="flex flex-wrap gap-2">{swatches.map(c=><button key={c} aria-label={`Use ${c}`} aria-pressed={accent===c} onClick={()=>setAccent(c)} className={cn('grid size-8 place-items-center rounded-full ring-offset-2 ring-offset-surface',accent===c&&'ring-2 ring-foreground')} style={{background:c}}>{accent===c&&<Check className="size-4 text-black"/>}</button>)}<input type="color" aria-label="Custom colour" value={accent} onChange={e=>setAccent(e.target.value)} className="size-8 rounded-full border bg-transparent"/></div></fieldset></div></Panel>
  <Keys/>
  <Panel icon={BookOpen} title="Usage guide" meta="Keep credentials and sessions on this computer"><ol className="max-w-3xl space-y-5 text-sm">{steps.map((s,i)=><li className="flex gap-3" key={s.title}><span className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-2 text-xs tabular-nums text-muted-foreground">{i+1}</span><div><h3 className="font-medium">{s.title}</h3><p className="mt-1 text-meta leading-6 text-muted-foreground">{s.body}</p></div></li>)}</ol><a href="http://10.2.6.112:8080/ssm/shared-computer-use" target="_blank" rel="noreferrer" className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-signal underline-offset-4 hover:underline">Open the complete team guide<ExternalLink className="size-3.5"/></a></Panel></>;
}
export const SettingsIcon=Settings;
