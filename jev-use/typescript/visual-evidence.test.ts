import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {addPeer,receive,setPeer} from '../../peers.mjs';
import {persistVisual,readVisualAsset} from '../visual-assets.js';
import {visualHandover,visualMemoryRecord,visualNovelty,perceptualHash,hashDistance,localOcr} from '../visual-evidence.js';
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
test('scoped visual evidence, novelty and own-device crop handover',async()=>{
 const a=await mkdtemp(join(tmpdir(),'nexus-evidence-a-')),b=await mkdtemp(join(tmpdir(),'nexus-evidence-b-'));
 try{
  const bytes=await sharp({create:{width:40,height:40,channels:3,background:'white'}}).png().toBuffer();
  const image={bytes,sha256:hash(bytes),width:40,height:40};
  const rec=await persistVisual(a,image,{project:'fixture',label:'Reviewed fixture'});
  assert.equal(hashDistance(await perceptualHash(image),await perceptualHash(image)),0);
  const novelty=await visualNovelty(a,'fixture',image);assert.equal(novelty.nearest[0].identical,true);
  const mem=await visualMemoryRecord(a,{project:'fixture',asset_id:rec.asset_id,task_id:'task',summary:'Fixture is visible',review:'Reviewed'});
  assert.equal(mem.gbrain_written,false);assert.equal(mem.record.asset_id,rec.asset_id);
  const pa=await addPeer(a,{name:'device-b',url:'http://b:8770',outbound:'x'.repeat(24),own:true});
  const pb=await addPeer(b,{name:'device-a',url:'http://a:8770',outbound:pa.inbound,own:true});
  await addPeer(a,{name:'device-b',url:'http://b:8770',outbound:pb.inbound,own:true});
  const fetcher=(async(_url:string,init:any)=>{const status=await receive(b,init.headers.Authorization,JSON.parse(init.body));return {ok:status===200,status};}) as typeof fetch;
  const req={action:'send',to:'device-b',project:'fixture',asset_id:rec.asset_id,task_id:'task',state:'ready',verification:'checked',confirm_send:true,crop:{left:1,top:1,width:10,height:10},confirm_crop:true};
  await assert.rejects(visualHandover(a,{...req,confirm_send:false},{},fetcher));
  await assert.rejects(visualHandover(a,{...req,confirm_crop:false},{},fetcher));
  await assert.rejects(visualHandover(a,{...req,crop:{left:0,top:0,width:40,height:40}},{},fetcher));
  const sent=await visualHandover(a,req,{},fetcher);assert.equal(sent.action,"send");assert.equal(sent.delivered,true);
  const listing=await visualHandover(b,{action:'list',project:'fixture'});assert.equal(listing.action,"list");assert.equal(listing.records.length,1);
  const msg=listing.records![0];assert.equal(msg.crop_sha256,sent.crop_sha256);assert.equal(JSON.stringify(msg).includes('base64'),false);
  await assert.rejects(visualHandover(b,{action:'receive',project:'fixture',message_id:msg.message_id}));
  const imported=await visualHandover(b,{action:'receive',project:'fixture',message_id:msg.message_id,confirm_receive:true});
  assert.equal(imported.action,"receive");assert.equal(imported.imported?.asset_id,sent.crop_sha256);
  assert.equal((await readVisualAsset(b,'fixture',sent.crop_sha256)).width,10);
  await assert.rejects(readVisualAsset(b,'fixture',rec.asset_id));
  await setPeer(a,'device-b',{enabled:false});
  await assert.rejects(visualHandover(a,req,{},fetcher));
 }finally{await rm(a,{recursive:true,force:true});await rm(b,{recursive:true,force:true});}
});
test('live local Windows OCR synthetic fixture',{skip:process.env.NEXUS_VISUAL_OCR_LIVE_TEST!=='1'},async()=>{
 const svg=Buffer.from('<svg width="800" height="220"><rect width="800" height="220" fill="white"/><text x="30" y="115" font-family="Arial" font-size="64" fill="black">NEXUS READY</text></svg>');
 const bytes=await sharp(svg).png().toBuffer();
 const result=await localOcr({bytes,sha256:hash(bytes),width:800,height:220});
 console.log(JSON.stringify(result));assert.match(result.text,/NEXUS READY/i);
});
