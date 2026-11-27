import {chromium} from '../jev-use/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const origin='http://127.0.0.1:8769';
const browser=await chromium.launch({channel:'chrome',headless:true});
const results=[];
try{
 for(const mode of ['installed','candidate']){
  for(const count of [0,500]){
   for(let i=0;i<3;i++){
    const page=await browser.newPage({viewport:{width:1600,height:1000},userAgent:'Nexus QA NexusDesktop/1.0'});
    if(mode==='candidate')for(const name of ['app.js','app.css'])await page.route('**/assets/'+name,r=>r.fulfill({path:fileURLToPath(new URL('./dist/'+name,import.meta.url))}));
    const now=Date.now(),fixture=Array.from({length:count},(_,j)=>({id:'perf-'+j,tool:j%2?'jev_browse':'find_files',status:j%10===0?'error':'passed',started:now-500000+j*1000,ms:100+j,client:'test-client',requestFields:[{name:'path',type:'string',bytes:150}],responseFields:[{name:'status',type:'string',bytes:4}]}));
    await page.route('**/runs',r=>r.fulfill({json:fixture}));
    const start=performance.now();await page.goto(origin+'/?theme=light#/observability',{waitUntil:'domcontentloaded'});
    await page.getByTestId('observability').waitFor();
    await page.getByText('Monitor online',{exact:true}).waitFor();
    if(count)await page.getByRole('button',{name:'Inspect call perf-0',exact:true}).waitFor();
    const ready=performance.now()-start;
    let filter=null;
    if(count){const t=performance.now();await page.getByRole('textbox',{name:'Filter calls'}).fill('jev_browse');await page.getByRole('button',{name:'Inspect call perf-1',exact:true}).waitFor();filter=performance.now()-t;assert.equal(await page.getByRole('button',{name:'Inspect call perf-0',exact:true}).count(),0);}
    results.push({mode,count,readyMs:Math.round(ready),filterMs:filter==null?null:Math.round(filter)});
    await page.close();
   }
  }
 }
 console.log(JSON.stringify(results));
}finally{await browser.close();}
