import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {addPeer,sendMessage,receive,readMailbox,setPeer} from '../../peers.mjs';
import {respondTo} from '../../agent-responder.mjs';
test('peer trace joins send, receive, responder and reply without logging payloads',async()=>{
 const a=await mkdtemp(join(tmpdir(),'nexus-peer-')),b=await mkdtemp(join(tmpdir(),'nexus-peer-'));
 try{
  const pa=await addPeer(a,{name:'b',url:'http://b:8770'});
  const pb=await addPeer(b,{name:'a',url:'http://a:8770',outbound:pa.inbound});
  await setPeer(a,'b',{outbound:pb.inbound});
  const relay=(root:string)=>async (_url:unknown,init:any)=>{const status=await receive(root,init.headers.Authorization,JSON.parse(init.body));return {status,ok:status===200};};
  await sendMessage(a,{to:'b',kind:'chat',body:'private-fixture-body'},relay(b) as unknown as typeof fetch);
  const incoming=(await readMailbox(b))[0] as any;
  await writeFile(join(b,'secrets','agent-responder.json'),JSON.stringify({command:process.execPath,args:['-e','process.stdin.resume();process.stdin.on("end",()=>console.log("fixture-answer"))'],timeoutMs:5000}));
  const outcome=await respondTo(b,incoming,{send:(root,message)=>sendMessage(root,message,relay(a) as unknown as typeof fetch)});
  assert.equal(outcome,'replied');
  const logs=await Promise.all([a,b].map(r=>readFile(join(r,'runs.jsonl'),'utf8')));
  assert.ok(logs.every(l=>!l.includes('private-fixture-body')&&!l.includes('fixture-answer')&&!l.includes(pa.inbound)&&!l.includes(pb.inbound)));
  const rows=logs.flatMap(l=>l.trim().split('\n').map(v=>JSON.parse(v))).filter(r=>r.status==='passed');
  assert.equal(rows.length,5);
  assert.equal(new Set(rows.map(r=>r.traceId)).size,1);
  const first=rows.find(r=>r.tool==='peer_send'&&!r.parentSpanId),recv=rows.find(r=>r.parentSpanId===first.spanId),responder=rows.find(r=>r.tool==='peer_responder');
  assert.equal(recv.messageId,first.messageId);assert.equal(responder.parentSpanId,recv.spanId);
  assert.ok(rows.some(r=>r.tool==='peer_send'&&r.parentSpanId===responder.spanId));assert.ok(responder.queueMs>=0);assert.ok(responder.executionMs>=0);
  await setPeer(b,'a',{enabled:false});
  await assert.rejects(sendMessage(a,{to:'b',body:'refused'},relay(b) as unknown as typeof fetch),/403/);
  assert.ok((await readFile(join(a,'runs.jsonl'),'utf8')).includes('"outcome":"refused"'));
 }finally{await rm(a,{recursive:true,force:true});await rm(b,{recursive:true,force:true});}
});
