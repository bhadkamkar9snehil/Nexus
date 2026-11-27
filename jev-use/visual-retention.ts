import {createHash} from 'node:crypto';
import {readdir,readFile,stat,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {visualProject,readVisualAsset,publishFile} from './visual-assets.js';

const id=(v:unknown)=>{if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))throw new Error('Invalid asset ID');return v;};
const files=async(dir:string)=>readdir(dir).catch(e=>{if(e.code==='ENOENT')return [] as string[];throw e;});
const exists=async(file:string)=>stat(file).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export async function visualRetention(root:string,args:Record<string,any>){
 const project=visualProject(args.project),dir=join(root,'secrets','visual-assets',project),ret=join(root,'secrets','visual-retention',project);
 if(args.action==='pin'){
  const asset=id(args.asset_id);await readVisualAsset(root,project,asset);
  if(typeof args.reason!=='string'||!args.reason.trim()||args.reason.length>1000)throw new Error('Pin reason required');
  await mkdir(ret,{recursive:true});
  const record={asset_id:asset,project,reason:args.reason,pinned_at:new Date().toISOString()};
  try{await publishFile(join(ret,asset+'.pin.json'),JSON.stringify(record));}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  return {status:'done',...JSON.parse(await readFile(join(ret,asset+'.pin.json'),'utf8')),decisions:0};
 }
 if(args.action!=='plan')throw new Error('Invalid retention action');
 const age=args.older_than_days??30;
 if(!Number.isSafeInteger(age)||age<1||age>3650)throw new Error('Invalid retention age');
 const protectedIds=new Set<string>();
 // Protect registered references, reviewed memory observations and active watch evidence.
 for(const [folder,pattern] of [
  [join(root,'secrets','visual-workflows',project,'contracts'),/\.json$/],
  [join(root,'secrets','visual-memory',project),/\.json$/],
  [join(root,'secrets','visual-watches'),/\.state\.json$/],
  [ret,/\.pin\.json$/]
 ] as const){
  const names=await files(folder);
  for(const name of names.filter(n=>pattern.test(n))){
   const raw=await readFile(join(folder,name),'utf8');
   const data=JSON.parse(raw);
   if(folder.endsWith('visual-watches')){ // Conservative: watch states lack project identity, protect matching hashes in every project.
    if(typeof data.asset_hash==='string'&&/^[a-f0-9]{64}$/.test(data.asset_hash))protectedIds.add(data.asset_hash);
   }else{
    for(const key of [...(data.definition?.reference_hashes??[]),data.asset_id,data.supersedes])if(typeof key==='string'&&/^[a-f0-9]{64}$/.test(key))protectedIds.add(key);
   }
  }
 }
 const entries=await files(dir);
 const names=entries.filter(n=>/^[a-f0-9]{64}\.png$/.test(n)).sort();
 const observationsByAsset=new Map<string,string[]>();
 for(const n of entries.filter(n=>/^[a-f0-9]{64}\.[a-f0-9]{64}\.json$/.test(n))){const key=n.slice(0,64);const list=observationsByAsset.get(key)??[];list.push(n);observationsByAsset.set(key,list);}
 const cutoff=Date.now()-age*86400000,old=[];
 let protectedCount=0,totalBytes=0;
 for(const name of names){
  const asset=name.slice(0,-4),info=await stat(join(dir,name));
  totalBytes+=info.size;
  if(protectedIds.has(asset)){protectedCount++;continue;}
  // All observations must also be older than the cutoff; no deletion is performed.
  const observations=observationsByAsset.get(asset)??[];
  let newest=info.mtimeMs;
  for(const obs of observations){const o=JSON.parse(await readFile(join(dir,obs),'utf8'));const time=Date.parse(o.recorded_at);if(!Number.isFinite(time))throw new Error('Invalid observation timestamp');newest=Math.max(newest,time);}
  if(newest<cutoff)old.push({asset_id:asset,bytes:info.size,last_observed_at:new Date(newest).toISOString()});
 }
 return {status:'done',project,older_than_days:age,total_assets:names.length,total_bytes:totalBytes,protected_assets:protectedCount,candidate_count:old.length,candidate_bytes:old.reduce((n,v)=>n+v.bytes,0),candidates:old.slice(0,100),plan_hash:digest(old),truncated:old.length>100,decisions:0,deleted:0,limitation:'Advisory retention plan only. No asset is deleted; references outside the local registry may exist.'};
}
