import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,utimes,writeFile,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {persistVisual,readVisualAsset} from '../visual-assets.js';
import {visualRetention} from '../visual-retention.js';
import {defineWorkflow,contractDefinition} from '../visual-workflows.js';
import {semanticJudge} from '../semantic-intelligence.js';
test('retention protects pinned and contract evidence and never deletes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nexus-retention-'));
 try{
  const ids=[];
  for(const color of ['red','blue','green']){
   const bytes=await sharp({create:{width:10,height:10,channels:3,background:color}}).png().toBuffer();
   const sha256=createHash('sha256').update(bytes).digest('hex');
   await persistVisual(root,{bytes,sha256,width:10,height:10},{project:'fixture',label:color});ids.push(sha256);
  }
  const dir=join(root,'secrets','visual-assets','fixture'),old=new Date(Date.now()-90*86400000);
  for(const name of await readdir(dir)){
   const file=join(dir,name);if(name.endsWith('.json')){const r=JSON.parse(await readFile(file,'utf8'));r.recorded_at=old.toISOString();await writeFile(file,JSON.stringify(r));}await utimes(file,old,old);
  }
  await visualRetention(root,{action:'pin',project:'fixture',asset_id:ids[0],reason:'Keep evidence'});
  await defineWorkflow(root,'contracts',contractDefinition({id:'fixture.v1',project:'fixture',checks:['Visible'],reference_hashes:[ids[1]]}));
  const plan=await visualRetention(root,{action:'plan',project:'fixture',older_than_days:30});
  assert.equal(plan.protected_assets,2);assert.equal(plan.candidate_count,1);assert.equal(plan.candidates?.[0].asset_id,ids[2]);assert.equal(plan.deleted,0);
  await readVisualAsset(root,'fixture',ids[2]);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('semantic judgment requires consent, independently judges candidates and abstains',async()=>{
 const previous=process.env.NEXUS_SEMANTIC_OUTBOUND;
 try{
  const args={mode:'citation_verification',query:'The build passed',candidates:[{id:'a',text:'Build succeeded'},{id:'b',text:'No result'},{id:'c',text:'Build failed'}],confirm_upload:true};
  const client={systemOne:async(req:any)=>{assert.equal(Object.keys(req.questions).length,3);return {model:'fixture',answers:{candidate_0:{type:'noul',noul:.95},candidate_1:{type:'noul',noul:.5},candidate_2:{type:'noul',noul:.05}},usage:{}};}} as any;
  delete process.env.NEXUS_SEMANTIC_OUTBOUND;await assert.rejects(semanticJudge(args,()=>{},client));
  process.env.NEXUS_SEMANTIC_OUTBOUND='1';await assert.rejects(semanticJudge({...args,confirm_upload:false},()=>{},client));
  const result=await semanticJudge(args,()=>{},client);
  assert.deepEqual(result.selected_ids,['a']);assert.deepEqual(result.judgments.map((j:any)=>j.verdict),['supported','uncertain','not_supported']);assert.equal(result.executed,false);
 }finally{if(previous===undefined)delete process.env.NEXUS_SEMANTIC_OUTBOUND;else process.env.NEXUS_SEMANTIC_OUTBOUND=previous;}
});
test('live semantic citation fixture separates support from contradiction',{skip:process.env.NEXUS_LIVE_SEMANTIC!=='1'},async()=>{
 const previous=process.env.NEXUS_SEMANTIC_OUTBOUND;
 try{
  process.env.NEXUS_SEMANTIC_OUTBOUND='1';
  const result=await semanticJudge({mode:'citation_verification',query:'The fixture build passed.',candidates:[{id:'pass',text:'The fixture build completed successfully.'},{id:'fail',text:'The fixture build failed.'}],confirm_upload:true},()=>{});
  assert.deepEqual(result.selected_ids,['pass']);assert.equal(result.judgments[1].verdict,'not_supported');
 }finally{if(previous===undefined)delete process.env.NEXUS_SEMANTIC_OUTBOUND;else process.env.NEXUS_SEMANTIC_OUTBOUND=previous;}
});
