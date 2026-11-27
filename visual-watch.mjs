// Durable visual watches run only in the managed monitor (the single event writer).
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile, link } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { emit } from './events.mjs';

const exec=promisify(execFile);
const folder=root=>join(root,'secrets','visual-watches');
const validId=id=>typeof id==='string'&&/^[a-z0-9][a-z0-9_-]{15,79}$/.test(id);
const validateId=id=>{if(!validId(id))throw new Error('Invalid watch ID');return id;};
const exists=async p=>{try{await stat(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const get=async(p,fallback)=>{try{return await read(p);}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
const write=async(p,v,exclusive=false)=>{
  const tmp=p+'.'+randomUUID()+'.tmp';
  try{await writeFile(tmp,JSON.stringify(v),{flag:'wx'});if(exclusive)await link(tmp,p);else await rename(tmp,p);}
  finally{await rm(tmp,{force:true});}
};
const files=async root=>(await readdir(folder(root)).catch(e=>{if(e.code==='ENOENT')return [];throw e;})).filter(n=>n.endsWith('.watch.json')&&validId(n.slice(0,-11)));
const configPath=(root,id)=>join(folder(root),validateId(id)+'.watch.json');
const statePath=(root,id)=>join(folder(root),validateId(id)+'.state.json');
const cancelPath=(root,id)=>join(folder(root),validateId(id)+'.cancel');
const range=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
export async function watchManage(root,args){
  if(args.action==='list'){
    const watches=[];
    for(const f of (await files(root)).slice(0,100)){
      const c=await read(join(folder(root),f)),s=await get(statePath(root,c.id),{});
      watches.push({id:c.id,project:c.project,created_at:c.created_at,expires_at:c.expires_at,interval_ms:c.interval_ms,cancelled:await exists(cancelPath(root,c.id)),...s});
    }
    return {status:'done',watches,decisions:0};
  }
  const id=validateId(args.id);
  if(args.action==='cancel'){
    if(!await exists(configPath(root,id)))throw new Error('Watch not found');
    await writeFile(cancelPath(root,id),'cancelled',{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});
    return {status:'done',id,cancelled:true,decisions:0};
  }
  if(args.action!=='create'||args.confirm_upload!==true||args.confirm_future_frames!==true)throw new Error('Explicit watch and future-frame authorization required');
  if(typeof args.path!=='string'||!isAbsolute(args.path)||typeof args.question!=='string'||!args.question.trim()||args.question.length>2000)throw new Error('Invalid watch input');
  const project=args.project??'local',interval=args.interval_ms??10000,duration=args.duration_ms??300000,threshold=args.threshold??0.8;
  if(typeof project!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(project)||!range(interval,5000,60000)||!range(duration,10000,3600000)||typeof threshold!=='number'||!Number.isFinite(threshold)||threshold<=0.5||threshold>1)throw new Error('Invalid watch bounds');
  const request={path:args.path,question:args.question,project,confirm_upload:true,threshold};
  await mkdir(folder(root),{recursive:true});
  const prior=await get(configPath(root,id),null);
  if(prior){if(JSON.stringify(prior.request)!==JSON.stringify(request)||prior.interval_ms!==interval||prior.duration_ms!==duration)throw new Error('Watch ID already used');return {status:'done',id,expires_at:prior.expires_at,reused:true,decisions:0};}
  let active=0;
  for(const f of await files(root)){const c=await read(join(folder(root),f));if(c.expires_at>Date.now()&&!await exists(cancelPath(root,c.id)))active++;}
  if(active>=8)throw new Error('Maximum eight active watches');
  const now=Date.now(),config={id,project,request,interval_ms:interval,duration_ms:duration,created_at:now,expires_at:now+duration};
  await write(configPath(root,id),config,true);
  return {status:'done',id,expires_at:config.expires_at,decisions:0};
}
export async function runVisualWatches(root,{now=Date.now(),evaluate,emitEvent=emit}={}){
  for(const f of await files(root)){
    const c=await read(join(folder(root),f));
    if(!validId(c.id)||c.expires_at<=now||await exists(cancelPath(root,c.id)))continue;
    const s=await get(statePath(root,c.id),{});
    if((s.next_at??0)>now||(s.calls??0)>=100)continue;
    let stamp='';
    try{
      const st=await stat(c.request.path);if(!st.isFile())throw new Error('Missing watch source');
      stamp=st.size+':'+st.mtimeMs;
      if(stamp===s.stamp)continue;
      const result=await evaluate(c.request);
      if(await exists(cancelPath(root,c.id))||Date.now()>=c.expires_at)continue;
      if(result.status!=='done'||!['satisfied','not_satisfied','uncertain'].includes(result.verdict)||!Array.isArray(result.asset_hashes)||!/^[a-f0-9]{64}$/.test(result.asset_hashes[0]??''))throw new Error('Invalid watch result');
      const asset_hash=result.asset_hashes[0];
      const next={stamp,calls:(s.calls??0)+1,next_at:now+c.interval_ms,last_observed_at:now,verdict:result.verdict,asset_hash,sequence:(s.sequence??0)+1};
      if(asset_hash!==s.asset_hash||result.verdict!==s.verdict){
        const eventId=createHash('sha256').update(JSON.stringify([c.id,next.sequence,asset_hash,result.verdict])).digest('hex');
        await emitEvent(root,{name:'visual.watch',eventId,deduplicate:true,data:{watch_id:c.id,project:c.project,kind:result.verdict==='satisfied'?'condition_matched':'state_changed',verdict:result.verdict,asset_hash}});
      }
      await write(statePath(root,c.id),next);
    }catch{
      await write(statePath(root,c.id),{...s,calls:(s.calls??0)+1,next_at:now+c.interval_ms,last_error_at:now,error:'Observation failed; check approved source and configuration'});
    }
  }
}
export function startVisualWatches(root,{log=()=>{}}={}){
  let running=false;
  const evaluate=async args=>{
    const p=join(folder(root),randomUUID()+'.request.json');
    try{
      await writeFile(p,JSON.stringify(args),{flag:'wx'});
      const {stdout}=await exec(process.execPath,[join(root,'jev-use','cli.mjs'),'visual_verify','@'+p],{windowsHide:true,timeout:35000,maxBuffer:256*1024,env:{...process.env,HARNESS_MONITOR_OBSERVATION:'1'}});
      return JSON.parse(stdout);
    }finally{await rm(p,{force:true});}
  };
  const tick=async()=>{if(running)return;running=true;try{await runVisualWatches(root,{evaluate});}catch{log('Visual watch service failed to read state');}finally{running=false;}};
  const timer=setInterval(tick,2000);timer.unref();
  return ()=>clearInterval(timer);
}
