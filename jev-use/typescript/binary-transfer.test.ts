import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {binaryTransfer} from '../binary-transfer.js';
test('binary round trip, integrity and no overwrite',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nexus-binary-'));
 try{
  const path=join(root,'input.bin'),out=join(root,'output.bin'),b=Buffer.from([0,255,42,10]);await writeFile(path,b);
  const download=await binaryTransfer({action:'download',path,allowedRoots:[root]});
  const args={action:'upload',path:out,data:download.blob!,size:download.bytes,sha256:download.sha256,allowedRoots:[root]};
  await assert.rejects(binaryTransfer({...args,sha256:'0'.repeat(64)}),/mismatch/);
  await binaryTransfer(args);assert.deepEqual(await readFile(out),b);
  await assert.rejects(binaryTransfer(args),/exists/);
  await assert.rejects(binaryTransfer({action:'download',path,allowedRoots:[join(root,'missing')]}),/outside/);
  await writeFile(join(root,'large.bin'),Buffer.alloc(256*1024+1));
  await assert.rejects(binaryTransfer({action:'download',path:join(root,'large.bin'),allowedRoots:[root]}),/maximum/);
 }finally{await rm(root,{recursive:true,force:true});}
});
