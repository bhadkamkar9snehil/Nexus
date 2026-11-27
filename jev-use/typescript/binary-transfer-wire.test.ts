import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const FILES='io.modelcontextprotocol/files';
test('MCP binary compatibility and negotiated inline file upload', {timeout:30000}, async()=>{
 const root=await mkdtemp(join(tmpdir(),'nexus-wire-'));
 const path=join(root,'wire.bin'),path2=join(root,'native.bin'),bytes=Buffer.from([0,1,255,127,90]);
 const digest=createHash('sha256').update(bytes).digest();
 const open=async(native:boolean)=>{
  const c=new Client({name:native?'native-test':'compat-test',version:'1.0'},{versionNegotiation:{mode:{pin:'2026-07-28'}},capabilities:native?{extensions:{[FILES]:{}}}:{}});
  await c.connect(new StdioClientTransport({command:process.execPath,args:[process.env.NEXUS_TEST_START??join(import.meta.dirname,'..','start.mjs')],env:{...process.env,NEXUS_READ_ROOTS:root,NEXUS_WRITE_ROOTS:root,HARNESS_MONITOR_OBSERVATION:'1'} as Record<string,string>,stderr:'ignore'}));
  return c;
 };
 let c:Client|undefined;
 try{
  c=await open(false);
  assert.equal((await c.listTools()).tools.some(t=>t.name==='nexus_upload_file'),false);
  const up=await c.callTool({name:'nexus_transfer_file',arguments:{action:'upload',path,data:bytes.toString('base64'),size:bytes.length,sha256:digest.toString('hex')}});
  assert.notEqual(up.isError,true);assert.deepEqual(await readFile(path),bytes);
  const down=await c.callTool({name:'nexus_transfer_file',arguments:{action:'download',path}});
  assert.notEqual(down.isError,true);
  const item=down.content?.find(x=>x.type==='resource');
  assert.equal(item?.type,'resource');
  assert.ok(item&&'blob' in item.resource);assert.deepEqual(Buffer.from(item.resource.blob as string,'base64'),bytes);
  await c.close();c=await open(true);
  assert.equal(c.getServerCapabilities()?.extensions?.[FILES]?.maxInlineBytes,262144);
  const native=(await c.listTools()).tools.find(t=>t.name==='nexus_upload_file');
  assert.ok(native,'native tool should be offered to extension-aware host');
  const result=await c.callTool({name:native.name,arguments:{path:path2,file:{id:'fixture',name:'wire.bin',mimeType:'application/octet-stream',size:bytes.length,digest:{algorithm:'sha-256',value:digest.toString('base64url')},data:bytes.toString('base64')}}});
  assert.notEqual(result.isError,true,JSON.stringify(result));assert.deepEqual(await readFile(path2),bytes);
 }finally{await c?.close();await rm(root,{recursive:true,force:true});}
});
