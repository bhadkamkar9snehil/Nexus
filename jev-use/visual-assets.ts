import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, readFile, readdir, link, unlink, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';
import sharp from 'sharp';
import { guardPath } from './read-text-file.js';

export type VisualImage = { bytes: Buffer; sha256: string; width: number; height: number };
const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const validId = (id: unknown): string => {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid visual asset ID');
  return id;
};
export function visualProject(value: unknown = 'local'): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new Error('Invalid project identifier');
  return value;
}
const bounded = (v:unknown,max:number,required=false) => {
  if(v===undefined&&!required)return '';
  if(typeof v!=='string'||v.length>max||(required&&!v.trim()))throw new Error('Invalid visual metadata');
  return v;
};
const directory=(root:string,project:string)=>join(root,'secrets','visual-assets',visualProject(project));

/** Atomic no-overwrite publication; never exposes a half-written final file. */
export async function publishFile(path:string, bytes:Buffer|string) {
  const temp=path+'.'+randomUUID()+'.tmp';
  const f=await open(temp,'wx');
  try {
    try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}
    await link(temp,path);
  } finally {await unlink(temp).catch(()=>{});}
}
async function publishOnce(path:string,bytes:Buffer|string){
  try {await publishFile(path,bytes);return true;}
  catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;return false;}
}
export async function persistVisual(root:string,image:VisualImage,meta:Record<string,unknown>={}){
  const project=visualProject(meta.project);
  const label=bounded(meta.label,2000), source=bounded(meta.source,100)||'explicit_file',taskId=bounded(meta.task_id,128);
  const dir=directory(root,project);
  await mkdir(dir,{recursive:true});
  const assetId=validId(image.sha256);
  if(hash(image.bytes)!==assetId)throw new Error('Asset hash mismatch');
  const path=join(dir,assetId+'.png');
  const created=await publishOnce(path,image.bytes);
  if(!created && hash(await readFile(path))!==assetId)throw new Error('Stored asset hash mismatch');
  const record={asset_id:assetId,project,width:image.width,height:image.height,bytes:image.bytes.length,recorded_at:new Date().toISOString(),label,source,device:hostname(),task_id:taskId||undefined};
  // Every observation is immutable. The same image may have several observations and labels.
  const observationId=hash(JSON.stringify([assetId,project,label,source,taskId]));
  const observationPath=join(dir,assetId+'.'+observationId+'.json');
  const newObservation=await publishOnce(observationPath,JSON.stringify({...record,observation_id:observationId}));
  const durable=newObservation?{...record,observation_id:observationId}:JSON.parse(await readFile(observationPath,'utf8'));
  return {...durable,deduplicated:!created};
}
export async function searchVisual(root:string,project:string,query:string){
  const dir=directory(root,project);
  const entries=await readdir(dir).catch(e=>{if(e.code==='ENOENT')return [] as string[];throw e;});
  const names=entries.filter(f=>/^[a-f0-9]{64}\.[a-f0-9]{64}\.json$/.test(f)).sort();
  const results=[];
  for(const file of names.slice(0,2000)){
    const item=JSON.parse(await readFile(join(dir,file),'utf8'));
    if(!query||String(item.label).toLowerCase().includes(query.toLowerCase()))results.push(item);
    if(results.length>=50)break;
  }
  return {results,truncated:names.length>2000||results.length===50};
}
export async function readVisualAsset(root:string,project:string,id:unknown){
  const assetId=validId(id),dir=directory(root,project),path=join(dir,assetId+'.png');
  const info=await stat(path);
  if(!info.isFile()||info.size>16*1024*1024)throw new Error('Invalid stored image');
  const bytes=await readFile(path);
  if(hash(bytes)!==assetId)throw new Error('Stored image integrity failure');
  const meta=await sharp(bytes).metadata();
  if(!meta.width||!meta.height)throw new Error('Invalid image metadata');
  return {bytes,sha256:assetId,width:meta.width,height:meta.height};
}
export async function redactVisual(image:VisualImage,masks:unknown){
  if(!Array.isArray(masks)||masks.length<1||masks.length>100)throw new Error('Supply 1-100 redaction rectangles');
  const overlays=masks.map((m:any)=>{
    if(!m||!['left','top','width','height'].every(k=>Number.isSafeInteger(m[k]))||m.left<0||m.top<0||m.width<1||m.height<1||m.left+m.width>image.width||m.top+m.height>image.height)throw new Error('Invalid redaction rectangle');
    return {input:{create:{width:m.width,height:m.height,channels:3 as const,background:'#000000'}},left:m.left,top:m.top};
  });
  const bytes=await sharp(image.bytes).flatten({background:'white'}).composite(overlays).png().toBuffer();
  return {...image,bytes,sha256:hash(bytes)};
}
export async function exportVisual(image:VisualImage,destination:unknown){
  if(typeof destination!=='string'||!isAbsolute(destination)||!/\.png$/i.test(destination))throw new Error('Absolute new PNG destination required');
  const path=await guardPath(destination,undefined,'NEXUS_WRITE_ROOTS',true);
  await publishFile(path,image.bytes);
  return {path,asset_id:image.sha256,width:image.width,height:image.height,bytes:image.bytes.length};
}
