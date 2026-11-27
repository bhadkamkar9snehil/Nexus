import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdtemp,writeFile,rm,readFile,readdir,mkdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import sharp from 'sharp';
import {getPeer,sendMessage,readMailbox} from '../peers.mjs';
import {persistVisual,readVisualAsset,visualProject,publishFile, type VisualImage} from './visual-assets.js';
const exec=promisify(execFile);
const sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const text=(v:unknown,max=2000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw new Error('Invalid evidence text');return v;};
const optional=(v:unknown,max=2000)=>v===undefined||v===''?'':text(v,max);
const assetId=(v:unknown)=>{if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))throw new Error('Invalid evidence asset hash');return v;};
export async function perceptualHash(image:VisualImage){
 const pixels=await sharp(image.bytes).flatten({background:'white'}).resize(9,8,{fit:'fill'}).greyscale().raw().toBuffer();
 let n=0n;for(let y=0;y<8;y++)for(let x=0;x<8;x++)n=(n<<1n)|BigInt(pixels[y*9+x]>pixels[y*9+x+1]);
 return n.toString(16).padStart(16,'0');
}
export function hashDistance(a:string,b:string){
 if(!/^[a-f0-9]{16}$/.test(a)||!/^[a-f0-9]{16}$/.test(b))throw new Error('Invalid perceptual hash');
 let n=BigInt('0x'+a)^BigInt('0x'+b),count=0;while(n){n&=n-1n;count++;}return count;
}
export async function localOcr(image:VisualImage){
 if(process.platform!=='win32')throw new Error('Windows OCR is not available on this platform');
 const dir=await mkdtemp(join(tmpdir(),'nexus-ocr-'));
 try{
  const file=join(dir,'image.png');await writeFile(file,image.bytes);
  const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',join(import.meta.dirname,'visual-ocr.ps1'),'-ImagePath',file],{windowsHide:true,timeout:30000,maxBuffer:1024*1024,encoding:'utf8'});
  const result=JSON.parse(stdout);
  if(typeof result.text!=='string'||!Array.isArray(result.words))throw new Error('Invalid local OCR result');
  return {...result,asset_hashes:[image.sha256],decisions:0,status:'done',local:true};
 }catch{throw new Error('Local Windows OCR unavailable or failed; no external fallback was used');}
 finally{await rm(dir,{recursive:true,force:true});}
}
export async function visualNovelty(root:string,project:string,image:VisualImage){
 const dir=join(root,'secrets','visual-assets',visualProject(project));
 const files=await readdir(dir).catch(e=>{if(e.code==='ENOENT')return [] as string[];throw e;});
 const ids=files.filter(n=>/^[a-f0-9]{64}\.png$/.test(n)).sort();
 const p=await perceptualHash(image);
 const candidates=[];
 for(const file of ids.slice(0,100)){
  const id=file.slice(0,-4);const other=await readVisualAsset(root,project,id);
  const [a,b]=await Promise.all([image,other].map(i=>sharp(i.bytes).flatten({background:'white'}).resize(32,32,{fit:'fill'}).removeAlpha().raw().toBuffer()));
  let sum=0;for(let i=0;i<a.length;i++)sum+=Math.abs(a[i]-b[i]);
  candidates.push({asset_id:id,identical:id===image.sha256,hash_distance:hashDistance(p,await perceptualHash(other)),pixel_difference:sum/(a.length*255)});
 }
 candidates.sort((a,b)=>a.pixel_difference-b.pixel_difference||a.hash_distance-b.hash_distance);
 return {status:'done',asset_hashes:[image.sha256],perceptual_hash:p,nearest:candidates.slice(0,10),compared:candidates.length,truncated:ids.length>100,decisions:0,limitation:'Local novelty evidence only; does not discard images or assert semantic equivalence.'};
}
const subject='Nexus visual handover v1';
const MAX_CROP=32*1024;
type Packet={version:1;project:string;asset_id:string;task_id:string;state:string;verification:string;defect:string;recorded_at:string;crop?:{sha256:string;data:string;size:number}};
function parsePacket(body:string):Packet{
 if(Buffer.byteLength(body)>60*1024)throw new Error('Handover too large');
 const p=JSON.parse(body);
 if(p.version!==1||!Number.isFinite(Date.parse(p.recorded_at)))throw new Error('Invalid handover');
 const result:Packet={version:1,project:visualProject(p.project),asset_id:assetId(p.asset_id),task_id:text(p.task_id,128),state:text(p.state),verification:text(p.verification),defect:optional(p.defect),recorded_at:p.recorded_at};
 if(p.crop!==undefined){
  if(typeof p.crop.data!=='string'||p.crop.data.length>Math.ceil(MAX_CROP/3)*4)throw new Error('Invalid crop');
  const bytes=Buffer.from(p.crop.data,'base64');
  if(!bytes.length||bytes.length>MAX_CROP||bytes.length!==p.crop.size||bytes.toString('base64')!==p.crop.data||sha(bytes)!==assetId(p.crop.sha256))throw new Error('Handover crop integrity failure');
  result.crop={sha256:p.crop.sha256,data:p.crop.data,size:bytes.length};
 }
 return result;
}
export async function visualHandover(root:string,args:Record<string,any>,context:{trace?:string;parentSpanId?:string}={},fetcher?:typeof fetch){
 const project=visualProject(args.project);
 if(args.action==='send'){
  if(args.confirm_send!==true)throw new Error('Explicit peer transfer authorization required');
  const to=text(args.to,40),peer=await getPeer(root,to);
  if(!peer?.enabled||!peer.paired||!peer.allow.mail||!peer.own)throw new Error('Visual handover requires an enabled paired own device with mail permission');
  const image=await readVisualAsset(root,project,args.asset_id);
  const packet:Packet={version:1,project,asset_id:image.sha256,task_id:text(args.task_id,128),state:text(args.state),verification:text(args.verification),defect:optional(args.defect),recorded_at:new Date().toISOString()};
  if(args.crop!==undefined){
   if(args.confirm_crop!==true)throw new Error('Explicit crop transfer authorization required');
   const b=args.crop;
   if(!b||!['left','top','width','height'].every(k=>Number.isSafeInteger(b[k]))||b.left<0||b.top<0||b.width<1||b.height<1||b.left+b.width>image.width||b.top+b.height>image.height||(b.width===image.width&&b.height===image.height))throw new Error('A strict bounded crop is required, not the entire image');
   const bytes=await sharp(image.bytes).extract({left:b.left,top:b.top,width:b.width,height:b.height}).png().toBuffer();
   if(bytes.length>MAX_CROP)throw new Error('Crop exceeds 32 KiB; select a smaller area');
   packet.crop={sha256:sha(bytes),data:bytes.toString('base64'),size:bytes.length};
  }
  const body=JSON.stringify(packet);parsePacket(body);
  const sent=await sendMessage(root,{to,kind:'mail',subject,body,...context},fetcher);
  return {action:'send' as const,status:'done',...sent,project,asset_hashes:[image.sha256],task_id:packet.task_id,crop_sha256:packet.crop?.sha256,decisions:0};
 }
 if(!['list','receive'].includes(args.action))throw new Error('Invalid handover action');
 const inbox=(await readMailbox(root,{box:'in',limit:200})).filter(m=>m.kind==='mail'&&m.subject===subject);
 const records=[];
 for(const m of inbox){
  try{const peer=await getPeer(root,m.peer);if(!peer?.own||!peer.enabled||!peer.paired||!peer.allow.mail)continue;const packet=parsePacket(m.body);if(packet.project!==project)continue;
   if(args.action==='list'){const {crop,...meta}=packet;records.push({message_id:m.id,peer:m.peer,trace_id:m.trace,...meta,crop_sha256:crop?.sha256,crop_bytes:crop?.size});continue;}
   if(m.id!==args.message_id)continue;
   if(args.confirm_receive!==true)throw new Error('Explicit import authorization required');
   let imported;
   if(packet.crop){
    const bytes=Buffer.from(packet.crop.data,'base64'),info=await sharp(bytes,{limitInputPixels:25_000_000}).metadata();
    if(info.format!=='png'||!info.width||!info.height||info.pages&&info.pages!==1)throw new Error('Invalid received image');
    imported=await persistVisual(root,{bytes,sha256:packet.crop.sha256,width:info.width,height:info.height},{project,label:'Authorized handover crop',source:'peer:'+m.peer,task_id:packet.task_id});
   }
   const {crop,...meta}=packet;return {action:'receive' as const,status:'done',message_id:m.id,peer:m.peer,trace_id:m.trace,...meta,imported,decisions:0};
  }catch(e){if(args.action==='receive'&&m.id===args.message_id)throw e;}
 }
 if(args.action==='receive')throw new Error('Authorized handover not found');
 return {action:'list' as const,status:'done',records,decisions:0};
}
export async function visualMemoryRecord(root:string,args:Record<string,any>){
 const project=visualProject(args.project),image=await readVisualAsset(root,project,args.asset_id);
 const task=text(args.task_id,128),review=text(args.review,2000),summary=text(args.summary,2000);
 const supersedes=args.supersedes===undefined?null:assetId(args.supersedes);
 if(supersedes)await readVisualAsset(root,project,supersedes);
 const recordedAt=new Date().toISOString(),slug='nexus/visual/'+project+'/'+sha(JSON.stringify([image.sha256,task,summary,review,supersedes])).slice(0,32);
 const record={schema:'nexus.visual.observation.v1',source:'Nexus local asset registry',project,asset_id:image.sha256,task_id:task,summary,review,recorded_at:recordedAt,supersedes};

 const dir=join(root,'secrets','visual-memory',project);await mkdir(dir,{recursive:true});
 const path=join(dir,slug.split('/').at(-1)+'.json');
 try{await publishFile(path,JSON.stringify(record));}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
 const durable=JSON.parse(await readFile(path,'utf8'));
 const markdown='# Visual observation\n\n'+JSON.stringify(durable,null,2)+'\n';
 return {status:'done',slug,record:durable,agent_gbrain_payload:{slug,content:markdown,content_origin:'tool_output',reason:'Nexus visual evidence; raw image retained locally'},gbrain_written:false,decisions:0,limitation:'Use the authorized agent GBrain MCP source to publish the record; no product GBrain access.'};
}
