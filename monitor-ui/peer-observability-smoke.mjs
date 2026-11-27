import {chromium} from '../jev-use/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
const b=await chromium.launch({channel:'chrome',headless:true});
try{
 const p=await b.newPage({viewport:{width:1600,height:1000},userAgent:'Nexus QA NexusDesktop/1.0'});
 const t=Date.now()-10000, trace='1234567890abcdef1234567890abcdef';
 const spans=[{id:'m',tool:'nexus_mail',source:'mcp',traceId:trace,status:'passed',started:t,ms:200,spanId:'1234567890abcdef'},{id:'s',tool:'peer_send',source:'peer',traceId:trace,status:'passed',started:t+10,ms:175,peer:'laptop',messageKind:'chat',outcome:'delivered',spanId:'234567890abcdef1',parentSpanId:'1234567890abcdef',httpStatus:200},{id:'r',tool:'peer_responder',source:'peer',traceId:trace,status:'passed',started:t+250,ms:1200,peer:'laptop',queueMs:30,executionMs:1000,outcome:'replied'}];
 await p.route('**/runs',r=>r.fulfill({json:spans}));
 await p.goto('http://127.0.0.1:8769/?theme=light#/observability');
 await p.getByRole('button',{name:'Inspect call s',exact:true}).click();
 const detail=p.getByRole('complementary',{name:'Call inspector'});
 await detail.getByText('delivered',{exact:true}).waitFor();
 await detail.getByText(trace,{exact:true}).waitFor();
 await detail.getByRole('button',{name:'Trace',exact:true}).click();
 await detail.getByRole('button',{name:/peer_responder/}).click();
 await detail.getByRole('button',{name:'Timing',exact:true}).click();
 await detail.getByText('30 ms',{exact:true}).waitFor();
 await p.getByText('MCP calls',{exact:true}).waitFor();
 await p.getByText('Peer operations',{exact:true}).waitFor();
 console.log('PASS installed peer trace inspector, correlation, queue timing and separate counters');
}finally{await b.close();}
