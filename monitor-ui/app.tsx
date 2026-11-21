import {useCallback,useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SettingsView} from './settings';
import {UpdatesView} from './updates';
import {PeersView} from './peers';
import {Bot,Download,Gauge,HeartPulse,Moon,Network,PanelLeftClose,PanelLeftOpen,Settings,Sun,Wrench} from 'lucide-react';
import {Panel,IconTile} from './upstream/viz';
import {Button} from './upstream/button';
import {Run,Runtime,Tool,names,number,money} from './data';
import {Metrics,Workload,State} from './widgets';
import {RunsView,HealthView,ToolsView} from './views';
import {cn} from './utils';
const routes=[{id:'overview',label:'Command centre',icon:Gauge},{id:'tools',label:'Agents & tools',icon:Wrench},{id:'peers',label:'Devices & agents',icon:Network},{id:'health',label:'Runtime health',icon:HeartPulse},{id:'usage',label:'Usage & cost',icon:Bot},{id:'updates',label:'Updates',icon:Download},{id:'settings',label:'Settings',icon:Settings}];
const Mark=({className}:{className?:string})=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className={className} aria-hidden><circle cx="12" cy="12" r="2.6"/><path d="M12 9.4V4.6M14.3 10.7l4-2.4M14.3 13.3l3.4 2.4M12 14.6v4.8M9.7 13.3l-3.4 2.4M9.7 10.7l-4-2.4"/><circle cx="12" cy="3.6" r="1.4" fill="currentColor"/><circle cx="19" cy="7.6" r="1.4" fill="currentColor"/><circle cx="18" cy="16.6" r="1.4" fill="currentColor"/><circle cx="12" cy="20.4" r="1.4" fill="currentColor"/><circle cx="6" cy="16.6" r="1.4" fill="currentColor"/><circle cx="5" cy="7.6" r="1.4" fill="currentColor"/></svg>;
const safe=<T,>(fn:()=>T,fallback:T):T=>{try{return fn();}catch{return fallback;}};
const parse=()=>routes.some(r=>r.id===location.hash.slice(2))?location.hash.slice(2):'overview';
function App(){
 const [view,View]=useState(parse),[collapsed,Collapse]=useState(safe(()=>localStorage.getItem('desk.nav.collapsed')==='1',false)),[dark,Dark]=useState(document.documentElement.classList.contains('dark')),[accent,Accent]=useState(safe(()=>localStorage.getItem('harness.accent')||'#4ceea8','#4ceea8'));
 const [runs,Runs]=useState<Run[]>([]),[error,SetError]=useState(''),[loaded,Loaded]=useState(false),[synced,Synced]=useState(0);
 const [tools,Tools]=useState<Tool[]>([]),[toolError,ToolError]=useState(''),[runtime,RuntimeState]=useState<Runtime|null>(null),[runtimeError,RuntimeError]=useState(''),[checking,Checking]=useState(false);
 useEffect(()=>{document.documentElement.style.setProperty('--brand',accent);safe(()=>localStorage.setItem('harness.accent',accent),undefined);},[accent]);
 const checkHealth=useCallback(async()=>{Checking(true);try{const r=await fetch('/runtime');if(!r.ok)throw new Error();RuntimeState(await r.json());RuntimeError('');}catch{RuntimeError('Runtime observations are unavailable. The monitor can still show recorded calls.');}finally{Checking(false);}},[]);
 useEffect(()=>{checkHealth();const timer=setInterval(checkHealth,30000);return()=>clearInterval(timer);},[checkHealth]);
 useEffect(()=>{fetch('/tools').then(r=>{if(!r.ok)throw new Error();return r.json();}).then(r=>Tools(r.tools)).catch(()=>ToolError('Tool catalog unavailable. Check the local launcher and dependencies.'));},[]);
 useEffect(()=>{
  const sync=()=>View(parse());window.addEventListener('hashchange',sync);
  let stopped=false,timer:ReturnType<typeof setTimeout>;
  const refresh=async()=>{try{const r=await fetch('/runs');if(!r.ok)throw new Error();const data=await r.json();if(!stopped){Runs(data.map((v:Run)=>({...v,status:v.status==='running'&&Date.now()-v.started>150000?'unconfirmed':v.status})));Loaded(true);Synced(Date.now());SetError('');}}catch{if(!stopped)SetError('Monitor disconnected. Reconnecting…');}if(!stopped)timer=setTimeout(refresh,2000);};refresh();return()=>{stopped=true;clearTimeout(timer);window.removeEventListener('hashchange',sync);};
 },[]);
 const go=(id:string)=>{location.hash='/'+id;};
 const theme=()=>{Dark(!dark);document.documentElement.classList.toggle('dark',!dark);safe(()=>localStorage.setItem('l1.theme',!dark?'dark':'light'),undefined);};
 const title=routes.find(r=>r.id===view)!.label,Icon=routes.find(r=>r.id===view)!.icon;
 const attention=runtime?.checks.filter(c=>c.state==='attention').length??0;
 return <div className="flex h-dvh overflow-hidden bg-background">
  <nav aria-label="Harness" className={cn('scrollbar-thin hidden w-16 shrink-0 flex-col md:flex items-center overflow-y-auto border-r bg-canvas py-3 *:shrink-0',!collapsed&&'xl:w-60 xl:items-stretch xl:px-2')}>
   <div className={cn('flex w-full items-center justify-center gap-2.5 pb-3',!collapsed&&'xl:justify-start xl:px-3')}><span className="grid size-8 shrink-0 place-items-center rounded-lg bg-foreground text-background"><Mark className="size-5"/></span>{!collapsed&&<span className="hidden min-w-0 flex-1 xl:block"><span className="block truncate text-sm font-semibold leading-tight">Computer use harness</span><span className="block truncate text-2xs text-subtle-foreground">Shared local runtime</span></span>}</div>
   {routes.map((n,i)=><div key={n.id} className={cn('w-full',(i===0||i===1)&&'mt-2')}>{!collapsed&&(i===0||i===1)&&<p className="hidden px-2.5 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wider text-subtle-foreground xl:block">{i===0?'Operate':'System'}</p>}<button onClick={()=>go(n.id)} aria-label={n.label} title={n.label} aria-current={view===n.id?'page':undefined} className={cn('mx-auto flex size-10 items-center justify-center gap-2.5 rounded-lg text-sm font-medium text-muted-foreground hover:bg-surface-2 hover:text-foreground',!collapsed&&'xl:h-9 xl:w-full xl:justify-start xl:px-2.5',view===n.id&&(collapsed?'bg-signal-soft text-signal':'bg-surface-2 text-foreground'))}><n.icon className="size-4.5 xl:size-4" aria-hidden/>{!collapsed&&<><span className="hidden xl:inline">{n.label}</span>{n.id==='health'&&attention>0&&<span className="ml-auto hidden rounded bg-warning-soft px-1.5 text-2xs text-warning xl:block">{attention}</span>}</>}</button></div>)}
   <div className="mt-auto w-full space-y-0.5 pt-3"><button onClick={()=>{Collapse(!collapsed);safe(()=>localStorage.setItem('desk.nav.collapsed',collapsed?'0':'1'),undefined);}} aria-label={collapsed?'Expand navigation':'Collapse navigation'} className={cn('mx-auto hidden size-10 items-center justify-center gap-2.5 rounded-lg text-sm text-muted-foreground hover:bg-surface-2 xl:flex',!collapsed&&'xl:h-9 xl:w-full xl:justify-start xl:px-2.5')}>{collapsed?<PanelLeftOpen className="size-4"/>:<PanelLeftClose className="size-4"/>}{!collapsed&&'Collapse'}</button><button onClick={theme} aria-label="Switch theme" className={cn('mx-auto flex size-10 items-center justify-center gap-2.5 rounded-lg text-sm text-muted-foreground hover:bg-surface-2',!collapsed&&'xl:h-9 xl:w-full xl:justify-start xl:px-2.5')}>{dark?<Sun className="size-4"/>:<Moon className="size-4"/>}{!collapsed&&<span className="hidden xl:inline">{dark?'Light theme':'Dark theme'}</span>}</button></div>
  </nav>
  <main className="flex min-w-0 flex-1 flex-col"><div className="flex items-center gap-3 border-b bg-canvas px-4 py-2 md:hidden"><Mark className="size-5"/><select aria-label="Page" className="min-w-0 flex-1 bg-canvas text-sm" value={view} onChange={e=>go(e.target.value)}>{routes.map(r=><option key={r.id} value={r.id}>{r.label}</option>)}</select><Button variant="ghost" size="icon-sm" onClick={theme} aria-label="Switch theme">{dark?<Sun/>:<Moon/>}</Button></div>
   <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto"><div className="space-y-3 px-4 py-3 lg:px-6">
    <header className="flex flex-wrap items-center gap-3"><IconTile icon={Icon}/><div className="min-w-0 flex-1"><h1 className="text-title font-semibold tracking-tight">{title}</h1><p className="text-xs text-subtle-foreground">{view==='overview'?'Recorded activity · up to 500 calls · live refresh':view==='peers'?'Your computers and their agents: paired, messaging, answering':'Computer, browser, search and decision tools'}</p></div><span role="status"><State value={error?'error':loaded?'healthy':'unknown'} label={error?'Reconnecting':loaded?'Monitor online':'Connecting'}/></span></header>
    {error&&<div role="alert" className="rounded-lg bg-destructive-soft px-4 py-3 text-sm text-destructive">{error} Showing the last received data.</div>}
    {view==='overview'&&<><Metrics runs={runs}/><Workload runs={runs}/><RunsView runs={runs} loading={!loaded}/></>}
    {view==='tools'&&<ToolsView tools={tools} runs={runs} runtime={runtime} error={toolError}/>}
    {view==='health'&&<HealthView runtime={runtime} error={runtimeError} checking={checking} refresh={checkHealth}/>}
    {view==='usage'&&<><Metrics runs={runs}/><Panel icon={Bot} title="Usage ledger" meta="Reported API responses · this recorded window" pad="none"><div className="scrollbar-thin max-h-[480px] overflow-auto rounded-xl"><table className="w-full min-w-[620px] text-left text-xs"><thead className="sticky top-0 bg-surface text-muted-foreground"><tr>{['Tool','Input tokens','Output tokens','Estimated USD','Coverage'].map(v=><th className="border-b px-4 py-3 font-medium" key={v}>{v}</th>)}</tr></thead><tbody>{runs.map(r=><tr className="border-b last:border-0" key={r.id}><td className="px-4 py-3">{names[r.tool]??r.tool}</td><td className="px-4 py-3 tabular-nums">{r.inputTokens==null?'—':number(r.inputTokens)}</td><td className="px-4 py-3 tabular-nums">{r.outputTokens==null?'—':number(r.outputTokens)}</td><td className="px-4 py-3 tabular-nums">{r.estimatedJevUsd==null?'—':money(r.estimatedJevUsd)}</td><td className="px-4 py-3">{r.inputTokens==null?'Unknown':r.usagePartial?'Partial':'Reported'}</td></tr>)}</tbody></table></div></Panel><p className="text-2xs text-subtle-foreground">Estimate uses the historical $0.042 per million input tokens. Not a bill. Missing usage is unknown, not free; direct Cua calls are outside this ledger.</p></>}
    {view==='updates'&&<UpdatesView/>}
    {view==='peers'&&<PeersView/>}
    {view==='settings'&&<SettingsView accent={accent} setAccent={Accent} dark={dark} theme={theme}/>}
   </div></div>
   <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t bg-canvas px-4 py-1.5 text-2xs text-subtle-foreground"><span className="flex items-center gap-1.5"><span className={cn('size-1.5 rounded-full',error?'bg-destructive':'bg-signal')}/>Local monitor</span><span>{runs.length} recorded calls</span><span>{runs.filter(r=>r.status==='running').length} running</span><span className="ml-auto">{synced?'Updated '+new Date(synced).toLocaleTimeString():'Waiting for activity'} · 127.0.0.1:8769</span></footer>
  </main>
 </div>;
}
createRoot(document.getElementById('app')!).render(<App/>);
