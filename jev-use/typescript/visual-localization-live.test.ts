import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {visualTool,decodeVisual,prepare,boxToPixels} from '../visual-intelligence.js';

const cases=[{w:640,h:400,x:40,y:50,bw:100,bh:80},{w:640,h:400,x:480,y:300,bw:120,bh:70},{w:400,h:640,x:240,y:90,bw:90,bh:130},{w:1200,h:300,x:700,y:110,bw:180,bh:75},{w:120,h:90,x:15,y:15,bw:40,bh:30},{w:96,h:64,x:55,y:30,bw:30,bh:22}];
test('visual transform round trip across aspect ratios and small crops',async()=>{
 for(const c of cases){
  const bytes=await sharp({create:{width:c.w,height:c.h,channels:3,background:'white'}}).png().toBuffer();
  const image=await decodeVisual(bytes),p=await prepare(image);
  const box=boxToPixels({left:(p.left+c.x*p.width/c.w)/p.sentWidth,right:(p.left+(c.x+c.bw)*p.width/c.w)/p.sentWidth,top:(p.top+c.y*p.height/c.h)/p.sentHeight,bottom:(p.top+(c.y+c.bh)*p.height/c.h)/p.sentHeight},p,image);
  assert.ok(Math.abs(box.left-c.x)<=1&&Math.abs(box.top-c.y)<=1);
  assert.ok(Math.abs(box.width-c.bw)<=2&&Math.abs(box.height-c.bh)<=2);
  assert.ok(p.sentWidth>=280&&p.sentHeight>=280&&p.sentWidth<=1568&&p.sentHeight<=1568);
 }
});
test('live localization replay across six sizes (explicit opt-in)',{skip:process.env.NEXUS_VISUAL_LIVE_TEST!=='1'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'nexus-box-replay-'));
 const old={...process.env};
 try{
  process.env.NEXUS_VISUAL_OUTBOUND='1';process.env.NEXUS_VISUAL_OUTBOUND_ROOTS=root;
  const rows=[];
  for(const [i,c] of cases.entries()){
   const path=join(root,i+'.png');
   await sharp({create:{width:c.w,height:c.h,channels:3,background:'white'}}).composite([{input:{create:{width:c.bw,height:c.bh,channels:3,background:'#2056d9'}},left:c.x,top:c.y}]).png().toFile(path);
   const r:any=await visualTool('visual_find',{path,question:'The single blue rectangle',confirm_upload:true,threshold:0.6},root,()=>{});
   const b=r.box;
   const intersection=b?Math.max(0,Math.min(c.x+c.bw,b.left+b.width)-Math.max(c.x,b.left))*Math.max(0,Math.min(c.y+c.bh,b.top+b.height)-Math.max(c.y,b.top)):0;
   const iou=b?intersection/(c.bw*c.bh+b.width*b.height-intersection):0;
   rows.push({i,width:c.w,height:c.h,iou,verdict:r.verdict,ms:r.elapsed_ms});
  }
  console.log(JSON.stringify({rows,mean_iou:rows.reduce((s,r)=>s+r.iou,0)/rows.length}));
  assert.ok(rows.every(r=>r.iou>=0.5),'At least one fixture failed the localization gate');
 }finally{
  for(const k of ['NEXUS_VISUAL_OUTBOUND','NEXUS_VISUAL_OUTBOUND_ROOTS']){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}
  await rm(root,{recursive:true,force:true});
 }
});
