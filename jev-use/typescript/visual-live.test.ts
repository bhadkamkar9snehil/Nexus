import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { visualTool } from '../visual-intelligence.js';

test('live Jev synthetic image primitives and references (explicit opt-in)',{skip:process.env.NEXUS_VISUAL_LIVE_TEST!=='1'},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'nexus-visual-live-'));
  const usage:any[]=[];
  try {
    const path=join(dir,'synthetic.png'), ref=join(dir,'blue.png'), shape=join(dir,'shape.png');
    await sharp({create:{width:400,height:400,channels:3,background:'red'}}).png().toFile(path);
    await sharp({create:{width:400,height:400,channels:3,background:'blue'}}).png().toFile(ref);
    await sharp({create:{width:400,height:400,channels:3,background:'white'}}).composite([{input:{create:{width:120,height:120,channels:3,background:'red'}},left:140,top:140}]).png().toFile(shape);
    process.env.NEXUS_VISUAL_OUTBOUND='1'; process.env.NEXUS_VISUAL_OUTBOUND_ROOTS=dir;
    const run=async(name:string,args:object)=>{
      const r:any=await visualTool(name,{path,confirm_upload:true,...args},dir,u=>usage.push(u));
      console.log(JSON.stringify({name,result:r})); return r;
    };
    assert.equal((await run('visual_verify',{question:'Is the entire image red?'})).verdict,'satisfied');
    assert.equal((await run('visual_classify',{question:'Which solid color fills image_0?',criteria:{red:'Red',blue:'Blue'}})).selected,'red');
    const grade=await run('visual_grade',{question:'How much of image_0 is red?',levels:['No visible red','About half red','Almost entirely red']});
    assert.ok(grade.score>1.5);
    const compare=await run('visual_compare',{references:[ref],question:'Is image_0 the same color as [[image:1]]?'});
    assert.equal(compare.verdict,'not_satisfied');
    const found=await run('visual_find',{path:shape,question:'The red square',threshold:0.6});
    assert.equal(found.verdict,'found');
    const b=found.box, intersection=Math.max(0,Math.min(260,b.left+b.width)-Math.max(140,b.left))*Math.max(0,Math.min(260,b.top+b.height)-Math.max(140,b.top));
    const iou=intersection/(120*120+b.width*b.height-intersection);
    console.log(JSON.stringify({box_iou:iou,usage}));
    assert.ok(iou>0.5,'Synthetic target localization IoU below 0.5');
    const absent=await run('visual_find',{path:shape,question:'A green circle',threshold:0.6});
    assert.equal(absent.box,null);
  } finally {await rm(dir,{recursive:true,force:true});}
});
