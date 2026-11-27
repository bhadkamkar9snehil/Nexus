import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { loadVisual, prepare, infer, boxToPixels, visualTool } from '../visual-intelligence.js';
import { createCoreRegistry } from '../tool-handlers/index.js';

test('visual tools bind in production registry',()=>{
  assert.equal(createCoreRegistry().list().filter(t=>t.name.startsWith('visual_')).length,24);
});
test('image pipeline, privacy, multipart, cache, abstention, local assets and diff',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'nexus-visual-'));
  const env={...process.env};
  try {
    const path=join(dir,'red.png'), other=join(dir,'blue.png');
    await sharp({create:{width:100,height:50,channels:3,background:'red'}}).png().toFile(path);
    await sharp({create:{width:100,height:50,channels:3,background:'blue'}}).png().toFile(other);
    process.env.NEXUS_READ_ROOTS=dir;
    delete process.env.NEXUS_VISUAL_OUTBOUND;
    delete process.env.NEXUS_VISUAL_OUTBOUND_ROOTS;
    await assert.rejects(visualTool('visual_verify',{path,question:'Red?',confirm_upload:true},dir,()=>{}),/operator opt-in/);
    process.env.NEXUS_VISUAL_OUTBOUND='1';
    await assert.rejects(visualTool('visual_verify',{path,question:'Red?',confirm_upload:true},dir,()=>{}),/outbound roots/);
    process.env.NEXUS_VISUAL_OUTBOUND_ROOTS=dir;
    await assert.rejects(visualTool('visual_verify',{path,question:'Red?'},dir,()=>{}),/task authorization/);
    const img=await loadVisual(path,true), p=await prepare(img);
    assert.equal(p.sentWidth,280); assert.equal(p.sentHeight,280);
    assert.deepEqual(boxToPixels({left:0,top:0,right:1,bottom:1},p,img),{left:0,top:0,width:100,height:50});
    assert.throws(()=>boxToPixels({left:0.9,right:0.1,top:0,bottom:1},p,img),/Invalid/);
    let requests=0,usage=0;
    const sender=async(form:FormData)=>{
      requests++;
      const json=JSON.parse(await (form.get('request') as Blob).text());
      assert.equal(json.model,'jev-1.14.0'); assert.equal(Object.keys(json.assets).length,1);
      assert.ok(form.get('image_0') instanceof Blob);
      return {model:'jev-1.14.0',answers:{answer:{type:'noul',noul:0.95}},usage:{input_tokens:100,output_tokens:1}};
    };
    const args={path,question:'Synthetic red test?',confirm_upload:true};
    assert.equal((await visualTool('visual_verify',args,dir,()=>{usage++},sender) as any).verdict,'satisfied');
    assert.equal((await visualTool('visual_verify',args,dir,()=>{usage++},sender) as any).cache_hit,true);
    assert.equal(requests,1); assert.equal(usage,1);
    const waited=await visualTool('visual_wait',{...args,timeout_ms:1000},dir,()=>{},sender) as any;
    assert.equal(waited.matched,true); assert.equal(waited.decisions,0);
    const contract=await visualTool('visual_contract',{path,contract_id:'test.v1',checks:['Red background','No clipped text'],confirm_upload:true},dir,()=>{},async()=>({model:'jev-1.14.0',answers:{check_0:{type:'noul',noul:0.95},check_1:{type:'noul',noul:0.5}},usage:{}})) as any;
    assert.equal(contract.verdict,'uncertain'); assert.match(contract.contract_hash,/^[a-f0-9]{64}$/);
    const absent=await visualTool('visual_find',{path,question:'Invisible target',confirm_upload:true},dir,()=>{},async()=>({model:'jev-1.14.0',answers:{exists:{type:'noul',noul:0.01},location:{type:'box',box:{left:0,top:0,right:1,bottom:1},confidence:1}},usage:{}}));
    assert.equal((absent as any).box,null);
    assert.equal((await visualTool('visual_diff',{path,references:[path]},dir,()=>{}) as any).identical,true);
    assert.ok((await visualTool('visual_diff',{path,references:[other]},dir,()=>{}) as any).mean_normalized_pixel_difference>0);
    const remembered=await visualTool('visual_remember',{path,label:'red sample'},dir,()=>{}) as any;
    assert.equal((await visualTool('visual_search',{query:'red'},dir,()=>{}) as any).results[0].asset_id,remembered.asset_id);
    await writeFile(join(dir,'fake.png'),'not an image');
    await assert.rejects(loadVisual(join(dir,'fake.png')));
  } finally {
    for(const k of ['NEXUS_READ_ROOTS','NEXUS_VISUAL_OUTBOUND','NEXUS_VISUAL_OUTBOUND_ROOTS']){if(env[k]===undefined)delete process.env[k];else process.env[k]=env[k];}
    await rm(dir,{recursive:true,force:true});
  }
});
