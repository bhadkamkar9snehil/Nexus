import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import sharp from 'sharp';
import { guardPath } from './read-text-file.js';
import { toolKey } from './key-routing.js';
import { persistVisual, searchVisual, readVisualAsset, redactVisual, exportVisual, visualProject } from './visual-assets.js';
import { decide } from './decisions.js';
import { captureBrowser, captureDesktop } from './visual-capture.js';
import { contractDefinition, recipeDefinition, defineWorkflow, getWorkflow, listWorkflows, nextTransition } from './visual-workflows.js';
import { watchManage } from '../visual-watch.mjs';
import {localOcr,visualNovelty,visualHandover,visualMemoryRecord} from './visual-evidence.js';
import {visualRetention} from './visual-retention.js';

const MODEL = 'jev-1.14.0';
const MAX = 16 * 1024 * 1024;
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const text = (v: unknown, max = 2000) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error('Invalid text');
  return v;
};
const probability = (p: unknown): p is number => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1;
const threshold = (v: unknown) => { const t = v ?? 0.8; if (!probability(t) || t <= 0.5) throw new Error('Threshold must exceed 0.5'); return t; };
type Image = { bytes: Buffer; sha256: string; width: number; height: number };
type Question = { type: 'noul' | 'choice' | 'score' | 'box'; instructions: string; criteria?: unknown };
type Reply = { model: string; answers: Record<string, any>; usage: unknown };
type Sender = (form: FormData) => Promise<Reply>;
const cache = new Map<string, Reply>();


export async function loadVisual(path: string, external = false): Promise<Image> {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Absolute image path required');
  // Separate operator-configured outbound root; no implicit Documents/Downloads access for cloud.
  if (external && !process.env.NEXUS_VISUAL_OUTBOUND_ROOTS?.trim()) throw new Error('Visual outbound roots are not configured');
  const resolved = await guardPath(path, undefined, external ? 'NEXUS_VISUAL_OUTBOUND_ROOTS' : 'NEXUS_READ_ROOTS');
  const file = await open(resolved, 'r');
  let bytes: Buffer;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX) throw new Error('Invalid image size');
    bytes = Buffer.alloc(stat.size);
    const result = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    if (result.bytesRead !== bytes.length || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Image changed while reading');
  } finally { await file.close(); }
  return decodeVisual(bytes);
}
export async function decodeVisual(bytes:Buffer):Promise<Image>{
  if(bytes.length<1||bytes.length>MAX)throw new Error('Invalid image size');
  const decoder = sharp(bytes, { limitInputPixels: 25_000_000, animated: false });
  const meta = await decoder.metadata();
  if (!['png','jpeg'].includes(meta.format ?? '') || (meta.pages ?? 1) !== 1) throw new Error('Only still PNG and JPEG are supported');
  const oriented = await decoder.rotate().png().toBuffer({ resolveWithObject: true });
  if (oriented.data.length > MAX) throw new Error('Decoded image exceeds local limit');
  return { bytes: oriented.data, sha256: hash(oriented.data), width: oriented.info.width, height: oriented.info.height };
}
export async function prepare(image: Image) {
  const resized = await sharp(image.bytes).resize(1568, 1568, { fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
  const { width, height } = resized.info;
  const left = Math.floor(Math.max(0, 280 - width) / 2), top = Math.floor(Math.max(0, 280 - height) / 2);
  const right = Math.max(0, 280 - width) - left, bottom = Math.max(0, 280 - height) - top;
  const bytes = left + right + top + bottom ? await sharp(resized.data).extend({left,right,top,bottom,background:'white'}).png().toBuffer() : resized.data;
  if (bytes.length > MAX) throw new Error('Prepared image exceeds API limit');
  return { bytes, width, height, left, top, sentWidth: width+left+right, sentHeight: height+top+bottom };
}
async function send(form: FormData): Promise<Reply> {
  const key = toolKey();
  if (!key) throw new Error('Jev key not configured');
  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method:'POST', headers:{Authorization:'Bearer '+key,'TypeSafe-Danger-Zone-Images':'true'},
    body:form, redirect:'error', signal:AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error('TypeSafe visual request failed: HTTP '+res.status);
  return await res.json() as Reply;
}
export async function infer(images: Image[], questions: Record<string, Question>, addUsage: (u:unknown)=>void, sender: Sender=send) {
  if (images.length < 1 || images.length > 4 || Object.keys(questions).length > 12) throw new Error('Visual request bounds exceeded');
  const prepared = await Promise.all(images.map(prepare));
  if (prepared.reduce((s,i)=>s+i.bytes.length,0)>20*1024*1024) throw new Error('Visual request too large');
  const key = hash(JSON.stringify([MODEL,'visual-transform-v2',images.map(i=>i.sha256),questions]));
  const previous = cache.get(key);
  if (previous) return { reply: previous, cache_hit:true, prepared };
  const state: Record<string,string> = {}, assets: Record<string,object> = {};
  prepared.forEach((_,i)=>{ const ref='nexus-image-'+images[i].sha256+'-'+i; state['image_'+i]=ref; assets[ref]={type:'image',part:'image_'+i}; });
  // A caller can use [[image:1]] in an instruction or a criterion to place a reference directly there.
  // Only known, supplied image indexes are accepted; the generated reference never comes from user text.
  const inline=(value:unknown):unknown=>{
    if(typeof value==='string')return value.replace(/\[\[image:(\d+)\]\]/g,(_,i)=>{
      const ref=state['image_'+Number(i)];
      if(!ref)throw new Error('Unknown inline visual reference');
      return ref;
    });
    if(Array.isArray(value))return value.map(inline);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,inline(v)]));
    return value;
  };
  const wireQuestions=inline(questions);
  const form = new FormData();
  form.append('request',new Blob([JSON.stringify({model:MODEL,state,assets,questions:wireQuestions})],{type:'application/json'}));
  prepared.forEach((p,i)=>form.append('image_'+i,new Blob([new Uint8Array(p.bytes)],{type:'image/png'}),'image_'+i+'.png'));
  const reply = await sender(form);
  if (reply.model !== MODEL || !reply.answers || Object.keys(questions).some(k=>reply.answers[k]?.type!==questions[k].type)) throw new Error('Invalid visual response');
  addUsage(reply.usage);
  if(cache.size>=128) cache.delete(cache.keys().next().value!);
  cache.set(key,reply);
  return {reply,cache_hit:false,prepared};
}
export function boxToPixels(box:any, p:Awaited<ReturnType<typeof prepare>>, image:Image) {
  if (!box || !['left','right','top','bottom'].every(k=>probability(box[k])) || box.left>=box.right || box.top>=box.bottom) throw new Error('Invalid bounding box');
  const x=(v:number)=>Math.max(0,Math.min(image.width,(v*p.sentWidth-p.left)*image.width/p.width));
  const y=(v:number)=>Math.max(0,Math.min(image.height,(v*p.sentHeight-p.top)*image.height/p.height));
  const left=Math.floor(x(box.left)),right=Math.ceil(x(box.right)),top=Math.floor(y(box.top)),bottom=Math.ceil(y(box.bottom));
  if(right<=left||bottom<=top)throw new Error('Box does not overlap image');
  return {left,top,width:right-left,height:bottom-top};
}

export async function visualTool(name:string,args:Record<string,any>,root:string,addUsage:(u:unknown)=>void,sender?:Sender,context:{trace?:string;parentSpanId?:string}={}) {
  const start=Date.now(), project=visualProject(args.project);
  if(name==='visual_retention')return visualRetention(root,args);
  if(name==='visual_handover')return visualHandover(root,args,context);
  if(name==='visual_memory_record')return visualMemoryRecord(root,args);
  if(name==='visual_ocr'||name==='visual_novelty'){
    const image=await loadVisual(args.path);
    return name==='visual_ocr'?localOcr(image):visualNovelty(root,project,image);
  }
  if(name==='visual_watch_manage'){
    if(args.action==='create'){
      if(process.env.NEXUS_VISUAL_OUTBOUND!=='1'||args.confirm_upload!==true||args.confirm_future_frames!==true)throw new Error('Operator opt-in and explicit future-frame authorization required');
      if(project!=='local'&&!process.env.NEXUS_VISUAL_OUTBOUND_PROJECTS?.split(';').includes(project))throw new Error('Visual project not approved for external inference');
      await loadVisual(args.path,true);
    }
    return watchManage(root,args);
  }
  if(name==='visual_contract_registry'||name==='visual_recipe'){
    const isContract=name==='visual_contract_registry',kind=isContract?'contracts':'recipes';
    if(args.action==='list')return {status:'done',...await listWorkflows(root,kind,project),decisions:0};
    if(args.action==='define'){
      const definition=isContract?contractDefinition(args):recipeDefinition(args);
      return {status:'done',...await defineWorkflow(root,kind,definition),decisions:0};
    }
    const record=await getWorkflow(root,kind,project,args.id);
    if(args.action==='get')return {status:'done',...record,decisions:0};
    if(args.action!=='evaluate')throw new Error('Invalid visual workflow action');
    const definition=record.definition;
    if(isContract){
      if((args.references??[]).length!==definition.reference_hashes.length)throw new Error('Registered reference count differs');
      const result:any=await visualTool('visual_contract',{...args,contract_id:definition.id,checks:definition.checks,threshold:definition.threshold,expected_reference_hashes:definition.reference_hashes},root,addUsage,sender);
      return {...result,definition_hash:record.hash};
    }
    const result:any=await visualTool('visual_route',{...args,question:'Which registered visual state matches image_0?',criteria:definition.states,threshold:definition.threshold},root,addUsage,sender);
    return {...result,...nextTransition(definition,result.selected),definition_hash:record.hash};
  }
  if(name==='visual_capture'){
    if(args.confirm_capture!==true)throw new Error('Explicit capture authorization required');
    if(!['desktop','browser'].includes(args.source))throw new Error('Invalid capture source');
    const bytes=await (args.source==='desktop'?captureDesktop(root,args):captureBrowser(root,args));
    const image=await decodeVisual(bytes);
    return {status:'done',...await persistVisual(root,image,{project,label:args.label??'Captured visual state',source:args.source,task_id:args.task_id}),decisions:0,elapsed_ms:Date.now()-start};
  }
  if(name==='visual_asset'){
    if(args.action==='list')return {status:'done',...await searchVisual(root,project,''),decisions:0};
    const image=await readVisualAsset(root,project,args.asset_id);
    if(args.action==='get')return {status:'done',asset_id:image.sha256,width:image.width,height:image.height,bytes:image.bytes.length,project,decisions:0};
    if(args.action==='export'){
      if(args.confirm_export!==true)throw new Error('Explicit asset export authorization required');
      return {status:'done',...await exportVisual(image,args.destination),project,decisions:0};
    }
    throw new Error('Invalid visual asset action');
  }
  if(name==='visual_redact'){
    const image=await loadVisual(args.path), redacted=await redactVisual(image,args.masks);
    return {status:'done',...await exportVisual(redacted,args.destination),source_hash:image.sha256,redaction_count:args.masks.length,decisions:0};
  }
  if(name==='visual_wait'||name==='visual_watch'){
    // Bounded observation of a caller-maintained image, not a background capture or event publisher.
    const timeout=args.timeout_ms??10000, interval=args.interval_ms??1000;
    if(!Number.isSafeInteger(timeout)||timeout<1000||timeout>30000||!Number.isSafeInteger(interval)||interval<250||interval>5000)throw new Error('Invalid observation bounds');
    let previous='', decisions=0, observations=0, last:any=null;
    const changes:object[]=[];
    do {
      const result:any=await visualTool('visual_verify',args,root,addUsage,sender);
      decisions+=result.decisions; observations++;
      const hash=result.asset_hashes[0];
      if(hash!==previous){changes.push({asset_hash:hash,verdict:result.verdict,observed_at:new Date().toISOString()});previous=hash;}
      last=result;
      if(name==='visual_wait'&&result.verdict==='satisfied')return {status:'done',matched:true,observations,decisions,last};
      if(changes.length>=20||Date.now()-start>=timeout)break;
      await new Promise(resolve=>setTimeout(resolve,Math.min(interval,Math.max(0,timeout-(Date.now()-start)))));
    }while(Date.now()-start<timeout);
    return {status:'done',matched:last?.verdict==='satisfied',timed_out:true,observations,decisions,changes,last,limitation:'Bounded file observation only; no screen capture, durable subscription or event publication.'};
  }
  if(name==='visual_search'){
    const query=text(args.query);
    if(args.mode!=='semantic')return {status:'done',...await searchVisual(root,project,query),decisions:0};
    if(process.env.NEXUS_VISUAL_OUTBOUND!=='1'||args.confirm_upload!==true||!process.env.NEXUS_VISUAL_OUTBOUND_PROJECTS?.split(';').includes(project))throw new Error('Semantic metadata search requires approved outbound project and explicit authorization');
    const found=await searchVisual(root,project,'');
    const candidates=found.results.slice(0,24).map((r:any)=>({id:r.observation_id,text:r.label})).filter((r:any)=>r.text);
    if(!candidates.length)return {status:'done',results:[],decisions:0};
    const ranked=JSON.parse(await decide('jev_rank_results',{query,candidates},addUsage));
    return {status:'done',...ranked,results:found.results.filter((r:any)=>candidates.some((c:any)=>c.id===r.observation_id)),truncated:found.truncated||found.results.length>24,limitation:'Semantic ranking of authorized labels; raw images remain local.'};
  }
  const paths=[args.path,...(Array.isArray(args.references)?args.references:[])];
  if(paths.length>4)throw new Error('Maximum four images');
  const local=['visual_diff','visual_remember'].includes(name);
  if(!local && (process.env.NEXUS_VISUAL_OUTBOUND!=='1'||args.confirm_upload!==true))throw new Error('External image inference requires operator opt-in and explicit task authorization');
  if(!local && project!=='local' && !process.env.NEXUS_VISUAL_OUTBOUND_PROJECTS?.split(';').includes(project))throw new Error('Visual project not approved for external inference');
  const images=await Promise.all(paths.map(p=>loadVisual(p,!local)));
  if(args.expected_reference_hashes!==undefined&&JSON.stringify(images.slice(1).map(i=>i.sha256))!==JSON.stringify(args.expected_reference_hashes))throw new Error('Registered reference image changed');
  if(name==='visual_remember')return {status:'done',...await persistVisual(root,images[0],{project,label:text(args.label),source:args.source,task_id:args.task_id}),decisions:0};
  if(name==='visual_diff'){
    if(images.length!==2)throw new Error('Two images required');
    const raw=await Promise.all(images.map(i=>sharp(i.bytes).flatten({background:'white'}).resize(64,64,{fit:'fill'}).removeAlpha().raw().toBuffer()));
    let sum=0;for(let i=0;i<raw[0].length;i++)sum+=Math.abs(raw[0][i]-raw[1][i]);
    return {status:'done',identical:images[0].sha256===images[1].sha256,mean_normalized_pixel_difference:sum/(raw[0].length*255),asset_hashes:images.map(i=>i.sha256),decisions:0};
  }
  const t=threshold(args.threshold), question=name==='visual_contract'?'Visual contract':text(args.question);
  const questions:Record<string,Question>={};
  if(name==='visual_contract'){
    const contract=text(args.contract_id,128);
    if(!Array.isArray(args.checks)||args.checks.length<1||args.checks.length>12)throw new Error('Supply 1-12 independent assertions');
    const checks=args.checks.map((v:unknown)=>text(v));
    checks.forEach((check:string,i:number)=>questions['check_'+i]={type:'noul',instructions:check});
    const {reply,cache_hit}=await infer(images,questions,addUsage,sender);
    const results=checks.map((check:string,i:number)=>{
      const p=reply.answers['check_'+i].noul;
      if(!probability(p))throw new Error('Invalid assertion probability');
      return {check,probability:p,verdict:p>=t?'satisfied':p<=1-t?'not_satisfied':'uncertain'};
    });
    const verdict=results.some((r:any)=>r.verdict==='not_satisfied')?'not_satisfied':results.every((r:any)=>r.verdict==='satisfied')?'satisfied':'uncertain';
    return {status:'done',contract_id:contract,contract_hash:hash(JSON.stringify([contract,checks,t,images.slice(1).map(i=>i.sha256)])),verdict,results,asset_hashes:images.map(i=>i.sha256),model:reply.model,cache_hit,decisions:cache_hit?0:1,elapsed_ms:Date.now()-start};
  }
  if(name==='visual_find'||name==='visual_extract'){
    if(images.length!==1)throw new Error('Localization requires one image');
    questions.exists={type:'noul',instructions:'Is this target clearly visible exactly once in image_0? '+question};
    questions.location={type:'box',instructions:'Locate this target in image_0: '+question};
  } else if(name==='visual_classify'||name==='visual_route'){
    if(!args.criteria||typeof args.criteria!=='object'||Array.isArray(args.criteria)||Object.keys(args.criteria).length<2||Object.keys(args.criteria).length>12)throw new Error('Supply 2-12 choice options');
    const entries=Object.entries(args.criteria).map(([k,v])=>{if(!/^[a-zA-Z0-9_-]{1,64}$/.test(k))throw new Error('Invalid option');return [k,text(v)]});
    questions.answer={type:'choice',instructions:question,criteria:Object.fromEntries(entries)};
    questions.fits={type:'noul',instructions:'Does the visible evidence clearly support one offered option for: '+question+' Options: '+JSON.stringify(entries)};
  } else if(name==='visual_grade'){
    if(!Array.isArray(args.levels)||args.levels.length<2||args.levels.length>10)throw new Error('Supply 2-10 ordered levels');
    questions.answer={type:'score',instructions:question,criteria:args.levels.map((v:unknown)=>text(v))};
  } else if(name==='visual_verify'||name==='visual_compare'){
    if(name==='visual_compare'&&images.length<2)throw new Error('Comparison needs a reference image');
    questions.answer={type:'noul',instructions:question};
  } else throw new Error('Unknown visual tool');
  const {reply,cache_hit,prepared}=await infer(images,questions,addUsage,sender);
  const common={status:'done',model:reply.model,cache_hit,decisions:cache_hit?0:1,elapsed_ms:Date.now()-start,asset_hashes:images.map(i=>i.sha256)};
  if(questions.exists){
    const p=reply.answers.exists.noul, b=reply.answers.location;
    if(!probability(p)||!probability(b.confidence))throw new Error('Invalid localization confidence');
    if(p<t||b.confidence<t)return {...common,verdict:p<=1-t?'absent':'uncertain',box:null,probability:p};
    const box=boxToPixels(b.box,prepared[0],images[0]);
    if(name==='visual_extract'){
      const crop=await sharp(images[0].bytes).extract(box).png().toBuffer();
      return {...common,verdict:'found',box,crop:await persistVisual(root,{bytes:crop,sha256:hash(crop),width:box.width,height:box.height},{project,source:'visual_extract',label:question,task_id:args.task_id})};
    }
    return {...common,verdict:'found',box,probability:p,box_confidence:b.confidence};
  }
  const answer=reply.answers.answer;
  if(answer.type==='noul'){
    if(!probability(answer.noul))throw new Error('Invalid Noul answer');
    return {...common,verdict:answer.noul>=t?'satisfied':answer.noul<=1-t?'not_satisfied':'uncertain',probability:answer.noul};
  }
  if(answer.type==='choice'){
    const fit=reply.answers.fits.noul, p=answer.probabilities?.[answer.choice];
    if(!probability(fit)||!probability(p)||!Object.hasOwn(questions.answer.criteria as object,answer.choice))throw new Error('Invalid choice answer');
    return {...common,selected:fit>=t&&p>=t?answer.choice:null,probability:p,fit,executed:false};
  }
  if(!probability(answer.confidence)||!Number.isFinite(answer.score)||answer.score<0||answer.score>args.levels.length-1)throw new Error('Invalid score');
  return {...common,score:answer.score,confidence:answer.confidence,probabilities:answer.probabilities,verdict:answer.confidence>=t?'rated':'uncertain'};
}
