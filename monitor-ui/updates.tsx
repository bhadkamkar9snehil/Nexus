import {useCallback,useEffect,useState} from 'react';
import {apiUrl} from './data';
import {ArrowDownToLine,Check,Copy,History,RefreshCw,RotateCcw,Webhook} from 'lucide-react';
import {Panel} from './upstream/viz';
import {Button} from './upstream/button';
import {call,host} from './settings';
import {cn} from './utils';

type Rel={tag:string;name:string;date:string;notes:string;source?:'github'|'gitlab';installable:boolean;isCurrent:boolean;newer:boolean};
type SourceState={ok:boolean;error?:string|null};
type Sources={github?:SourceState;gitlab?:SourceState};
type Ev={id:string;at:number;kind:string;project:string;title:string};
type InstallProgress={tag:string;source?:string;message:string;percent:number|null};
const field='w-full rounded-lg border bg-surface px-3 py-2 text-sm';
const day=(v:string)=>v?new Date(v).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}):'';
const sourceName=(s?:string)=>s==='github'?'GitHub':s==='gitlab'?'GitLab':'Release';
const relKey=(r:Rel)=>`${r.tag}:${r.source??'default'}`;
// Release notes are Markdown from the release job: "## What's new" bullets, then "## Checksums". Show only the changes.
const changes=(notes:string)=>notes.split(/^##\s+Checksums/m)[0].replace(/^##\s+What's new\s*/m,'').split('\n').map(l=>l.replace(/^[-*]\s*/,'').trim()).filter(Boolean);

export function UpdatesView(){
 const [current,Current]=useState<string|null>(null),[rels,Rels]=useState<Rel[]>([]),[sources,Sources]=useState<Sources|null>(null),[note,Note]=useState(''),[busy,Busy]=useState(''),[token,Token]=useState(''),[tokenSaved,TokenSaved]=useState(false),[open,Open]=useState('');
 const [events,Events]=useState<Ev[]>([]),[hook,Hook]=useState<{url:string;secret:string}|null>(null),[loaded,Loaded]=useState(false);
 const [autoUpdate,AutoUpdate]=useState(false),[autoUpdateAvailable,AutoUpdateAvailable]=useState(false);
 const [installing,Installing]=useState<InstallProgress|null>(null),[installError,InstallError]=useState('');
 const locked=!!busy||!!installing;
 const load=useCallback(async()=>{Busy('check');const r=await call({type:'updates.list'});Busy('');Loaded(true);Current(r.current??null);TokenSaved(r.tokenSaved===true);AutoUpdate(r.autoUpdate===true);AutoUpdateAvailable(r.autoUpdateAvailable===true);Sources(r.sources??null);if(r.ok){Rels(r.releases);Note('');}else Note(r.message??'');},[]);
 useEffect(()=>{if(host())load();else Loaded(true);},[load]);
 useEffect(()=>{const h=host();if(!h)return;const on=(e:{data:any})=>{
  if(e.data?.type==='updateAvailable')void load();
  if(e.data?.type==='updateProgress')Installing(previous=>previous&&previous.tag===e.data.tag&&(!e.data.source||!previous.source||previous.source===e.data.source)
    ? {tag:previous.tag,source:previous.source,message:e.data.message,percent:typeof e.data.percent==='number'?e.data.percent:null}
    : previous);
 };h.addEventListener('message',on);return()=>h.removeEventListener('message',on);},[load]);
 useEffect(()=>{let stop=false;const t=async()=>{try{const r=await fetch(apiUrl('/webhook-events'));if(r.ok&&!stop)Events((await r.json()).events);}catch{}};t();const i=setInterval(t,10000);return()=>{stop=true;clearInterval(i);};},[]);
 const install=async(r:Rel)=>{
  if(!r.newer&&!confirm(`Roll back to ${r.tag}${r.source?` (${sourceName(r.source)})`:''}? This turns off automatic updates.`))return;
  InstallError('');Note('');Installing({tag:r.tag,source:r.source,message:'Preparing the update',percent:null});
  const result=await call({type:'updates.install',tag:r.tag,source:r.source},20*60*1000);
  Installing(null);
  if(!result.ok){InstallError(result.message??'Nexus Setup could not complete.');return;}
  await load();
  Note(result.message??'');
 };
 const saveToken=async()=>{Busy('token');const x=await call({type:'updates.saveToken',token});Busy('');if(x.ok){Token('');await load();}Note(x.message??'');};
 const showHook=async()=>{const x=await call({type:'updates.webhook'});if(x.ok)Hook({url:x.url,secret:x.secret});else Note(x.message??'');};
 const setAutoUpdate=async(enabled:boolean)=>{Busy('autoUpdate');const result=await call({type:'updates.autoUpdate',enabled});Busy('');if(result.ok)AutoUpdate(result.autoUpdate);else Note(result.message??'');};
 const latest=rels.find(r=>r.installable);
 const latestGh=rels.find(r=>r.installable&&r.source==='github');
 const latestGl=rels.find(r=>r.installable&&r.source==='gitlab');
 const newerChoices=[latestGl,latestGh].filter((r):r is Rel=>Boolean(r?.newer));
 const differentVersions=Boolean(latestGh?.newer&&latestGl?.newer&&latestGh.tag!==latestGl.tag);
 const isInstalling=(r:Rel)=>Boolean(installing&&installing.tag===r.tag&&(!r.source||!installing.source||installing.source===r.source));
 if(!host())return <Panel icon={History} title="Updates" meta="Desktop app only"><p className="text-sm text-muted-foreground">Open the Nexus desktop app to see versions, update and roll back.</p></Panel>;
 return <>
  <Panel icon={ArrowDownToLine} title="Version" meta={current?`Installed ${current}`:'Not installed from an installer (source checkout)'}><div className="flex flex-wrap items-center gap-3">
   <p className="min-w-0 flex-1 text-sm">{!loaded||busy==='check'?'Checking GitHub and GitLab…':differentVersions?<>Different versions are available: <b>{latestGh!.tag.replace(/^v/,'')}</b> on GitHub and <b>{latestGl!.tag.replace(/^v/,'')}</b> on GitLab. Choose which one to download.</>:newerChoices.length===2?<>Version <b>{newerChoices[0].tag.replace(/^v/,'')}</b> is available from GitHub and GitLab.</>:newerChoices.length===1?<>Version <b>{newerChoices[0].tag.replace(/^v/,'')}</b> is available from {sourceName(newerChoices[0].source)}.</>:latest?.newer?<>Version <b>{latest.tag.replace(/^v/,'')}</b> is available.</>:latest?'You have the latest version.':'No releases found.'}</p>
   {newerChoices.length>0?newerChoices.map(choice=><Button key={relKey(choice)} size="sm" variant={choice===newerChoices[0]?'default':'outline'} disabled={locked} onClick={()=>install(choice)}><ArrowDownToLine/>{isInstalling(choice)?'Update in progress':differentVersions?`Update ${choice.tag} (${sourceName(choice.source)})`:`Update from ${sourceName(choice.source)}`}</Button>):latest?.newer&&<Button size="sm" disabled={locked} onClick={()=>install(latest)}><ArrowDownToLine/>{isInstalling(latest)?'Update in progress':'Update now'}</Button>}
   <Button size="sm" variant="outline" disabled={locked} onClick={load}><RefreshCw/>Check now</Button></div>
   {sources&&(sources.github?.ok===false||sources.gitlab?.ok===false)&&<div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
    {sources.github?.ok===false&&<p>GitHub: {sources.github.error||'Unavailable'}</p>}
    {sources.gitlab?.ok===false&&<p>GitLab: {sources.gitlab.error||'Unavailable'}</p>}
   </div>}
   {installing&&<div className="mt-4 space-y-2 rounded-lg border bg-surface p-3">
    <div role="status" className="flex flex-wrap items-center justify-between gap-2 text-sm">
     <span>{installing.tag}{installing.source?` (${sourceName(installing.source)})`:''} · {installing.message}</span>
     {installing.percent!==null&&<span className="tabular-nums">{installing.percent}%</span>}
    </div>
    <progress aria-label="Update progress" className="block h-2 w-full accent-signal" max={100} value={installing.percent??undefined}/>
   </div>}
   {installError&&<p role="alert" className="mt-3 rounded-lg bg-destructive-soft p-3 text-sm text-destructive">{installError}</p>}
   {autoUpdateAvailable&&<label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" role="switch" checked={autoUpdate} disabled={locked} onChange={e=>void setAutoUpdate(e.target.checked)}/>Install updates automatically when I am away</label>}
   {latest?.newer&&<ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{changes(latest.notes).map((c,i)=><li key={i}>{c}</li>)}</ul>}
   {note&&<p role="status" className="mt-3 text-xs text-muted-foreground">{note}</p>}</Panel>
  <Panel icon={History} title="Versions" meta="Install any release from GitHub or GitLab, including older ones, to roll back" pad="none"><div className="divide-y">
   {rels.map(r=>{const k=relKey(r);return <div key={k} className="px-4 py-3"><div className="flex flex-wrap items-center gap-3"><button className="min-w-0 flex-1 text-left" onClick={()=>Open(open===k?'':k)} aria-expanded={open===k}><span className="text-sm font-medium">{r.tag}</span>{r.source&&<span className="ml-2 inline-flex items-center rounded bg-surface-2 px-1.5 py-0.5 text-2xs text-muted-foreground">{sourceName(r.source)}</span>}<span className="ml-3 text-xs text-subtle-foreground">{day(r.date)}</span>{r.isCurrent&&<span className="ml-3 inline-flex items-center gap-1 rounded bg-signal-soft px-1.5 text-2xs text-signal"><Check className="size-3"/>Installed</span>}</button>
    {!r.isCurrent&&<Button size="sm" variant="outline" disabled={locked||!r.installable} title={r.installable?undefined:'No installer with a published checksum'} onClick={()=>install(r)}>{r.newer?<ArrowDownToLine/>:<RotateCcw/>}{isInstalling(r)?'Working…':r.newer?'Update':'Roll back'}</Button>}</div>
    {open===k&&<ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">{changes(r.notes).map((c,i)=><li key={i}>{c}</li>)}{!changes(r.notes).length&&<li>No release notes.</li>}</ul>}</div>;})}
   {loaded&&!rels.length&&<p className="p-4 text-sm text-muted-foreground">No releases to show.</p>}</div></Panel>
  <Panel icon={Webhook} title="GitLab" meta="Access and push notifications"><div className="max-w-xl space-y-5">
   <section className="space-y-2"><h3 className="text-sm font-medium">Access token</h3><p className="text-xs text-muted-foreground">{tokenSaved?'A token is saved for this Windows account.':'The release list is private. Save a GitLab access token with read_api scope.'}</p>
    <input type="password" aria-label="GitLab access token" autoComplete="off" className={field} value={token} onChange={e=>Token(e.target.value)}/>
    <Button size="sm" variant="outline" disabled={locked||!token.trim()} onClick={saveToken}>Save token</Button></section>
   <section className="space-y-2"><h3 className="text-sm font-medium">Push notifications</h3><p className="text-xs text-muted-foreground">Add this computer as a GitLab webhook (releases and pipeline events) so updates are announced immediately instead of within 30 minutes.</p>
    {hook?<div className="space-y-2 text-xs"><div className="flex items-center gap-2"><code className="min-w-0 flex-1 truncate rounded bg-surface-2 px-2 py-1">{hook.url}</code><Button size="icon-sm" variant="ghost" aria-label="Copy URL" onClick={()=>navigator.clipboard.writeText(hook.url)}><Copy/></Button></div>
      <Button size="sm" variant="outline" onClick={()=>navigator.clipboard.writeText(hook.secret)}><Copy/>Copy secret token</Button></div>:<Button size="sm" variant="outline" onClick={showHook}>Show webhook details</Button>}
    <ul className="space-y-1 pt-1">{events.slice(0,8).map(e=><li key={e.id} className="flex gap-3 text-xs"><span className="w-20 shrink-0 text-subtle-foreground">{new Date(e.at).toLocaleTimeString()}</span><span className={cn('min-w-0 flex-1 truncate')}>{e.title}</span></li>)}{!events.length&&<li className="text-xs text-subtle-foreground">No events received yet.</li>}</ul></section></div></Panel></>;
}
