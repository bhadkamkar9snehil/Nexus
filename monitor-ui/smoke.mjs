// Browser plugin not available; use the harness's installed Playwright for rendered QA.
import {chromium} from '../jev-use/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const out=new URL('../docs/screenshots/',import.meta.url);
const origin=`http://127.0.0.1:${Number(process.env.NEXUS_MONITOR_PORT || 8769)}`;
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1100},userAgent:'Nexus smoke NexusDesktop/1.0'});
const errors=[];let injectingFailure=false;page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!injectingFailure)errors.push(m.text());});
const screenshot=async name=>{await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:fileURLToPath(new URL(name,out)),fullPage:true});};
const go=async name=>{await page.getByRole('button',{name,exact:true}).click();await page.getByRole('heading',{name,exact:true}).waitFor();};
try{
 const runtime=await (await page.request.get(origin+'/monitor-status')).json();
 {
  const standalone=await page.request.get(origin+'/',{headers:{'User-Agent':'Standalone browser'}});
  assert.equal(standalone.status(),404);
  assert.match(await standalone.text(),/Open Nexus from the Windows Start menu/);
 }
 await page.goto(origin+'/?theme=light');
 await page.getByText('Monitor online',{exact:true}).waitFor();
 await page.getByRole('heading',{name:'Recorded calls',exact:true}).waitFor();
 assert.equal(await page.locator('nav').evaluate(e=>e.getBoundingClientRect().width),240);
 assert.match(await page.locator('body').evaluate(e=>getComputedStyle(e).fontFamily),/Geist/);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 const scroll=page.getByTestId('runs-scroll');
 assert.equal(await scroll.evaluate(e=>getComputedStyle(e).overflowY),'auto');
 assert.equal(await page.locator('thead').first().evaluate(e=>getComputedStyle(e).position),'sticky');
 const actual=await (await page.request.get(origin+'/runs')).json();
 assert.ok(await page.locator('tbody tr').count()<=10);
 if(actual.length>10){const before=await page.locator('tbody tr').first().innerText();await page.getByRole('button',{name:'Next page',exact:true}).click();assert.notEqual(await page.locator('tbody tr').first().innerText(),before);await page.getByRole('button',{name:'Previous page',exact:true}).click();}
 await page.getByRole('combobox',{name:'Status filter'}).selectOption('blocked');
 for(const row of await page.locator('tbody tr').all())assert.match(await row.innerText(),/blocked/);
 await page.getByRole('button',{name:'Clear filters',exact:true}).click();
 if(actual.length){
  const matchTool=actual[0].tool;
  await page.getByRole('combobox',{name:'Tool filter'}).selectOption(matchTool);
  for(const button of await page.getByRole('button',{name:/^Inspect run /}).all()){
   const id=(await button.getAttribute('aria-label')).slice(12);assert.equal(actual.find(r=>r.id===id).tool,matchTool);
  }
  await page.getByRole('button',{name:'Clear filters',exact:true}).click();
 }
 await page.getByRole('button',{name:'Sort by Duration',exact:true}).click();
 const longest=[...actual].filter(r=>r.ms!=null).sort((a,b)=>b.ms-a.ms)[0];
 if(longest)assert.equal(await page.getByRole('button',{name:/^Inspect run /}).first().getAttribute('aria-label'),'Inspect run '+longest.id);
 await page.getByRole('button',{name:'Sort by Started',exact:true}).click();
 await page.getByRole('combobox',{name:'Rows per page'}).selectOption('20');
 assert.ok(await page.locator('tbody tr').count()<=20);
 await page.getByRole('combobox',{name:'Rows per page'}).selectOption('10');
 await page.getByRole('spinbutton',{name:'Minimum duration'}).fill('1000000');
 await page.getByText('No matching runs.',{exact:false}).waitFor();
 await page.getByRole('button',{name:'Clear filters',exact:true}).click();
 await page.getByRole('textbox',{name:'Filter runs'}).fill('fixture-that-does-not-exist');
 await page.getByText('No matching runs.',{exact:false}).waitFor();
 await page.getByRole('button',{name:'Clear filters',exact:true}).click();
 if(actual.length){await page.getByRole('button',{name:/^Inspect run /}).first().click();await page.getByText('Recorded call details',{exact:true}).waitFor();assert.equal(await page.locator('pre').count(),0);await page.getByRole('button',{name:'Close details',exact:false}).click();}
 await screenshot('overview-light.png');
 await go('Agents & tools');
 await page.getByRole('heading',{name:'Capability catalog',exact:true}).waitFor();
 assert.equal(await page.getByRole('heading',{name:'Terminal sessions',exact:true}).count(),0); // not shown, not fetched, until opened
 await page.getByRole('button',{name:'Terminal sessions',exact:true}).click();
 await page.getByRole('heading',{name:'Terminal sessions',exact:true}).waitFor();
 await page.waitForFunction(()=>!document.body.innerText.includes('Checking sessions…'));
 const sessionResult=await (await page.request.get(origin+'/sessions')).json();
 assert.ok(Array.isArray(sessionResult.sessions));
 for(const session of sessionResult.sessions) assert.deepEqual(Object.keys(session).sort(),['ended_at','exit_code','pid','session_id','shell','started_at','state']);
 await page.getByRole('button',{name:'Terminal sessions',exact:true}).click(); // close it again: the page is shown without it
 assert.equal(await page.getByRole('heading',{name:'Terminal sessions',exact:true}).count(),0);
 await page.getByRole('group',{name:'Tool categories'}).getByRole('button',{name:/^Terminal/}).click();
 for(const name of ['Start a process','Read process output','Send process input','List terminal sessions','Terminate a session','List processes','Terminate a process']) await page.getByRole('button',{name:new RegExp('^'+name)}).waitFor();
 await page.getByRole('button',{name:/^Terminate a process/}).click();
 await page.getByText('expected_start_time',{exact:true}).waitFor();
 await screenshot('tools-light.png');
 await page.getByRole('textbox',{name:'Search capabilities'}).fill('browser');
 await page.getByRole('group',{name:'Tool categories'}).getByRole('button',{name:/^Browser/}).click();
 await page.getByRole('heading',{name:'Inputs',exact:true}).waitFor();
 assert.equal(await page.locator('pre').count(),0);
 await page.getByRole('textbox',{name:'Search capabilities'}).fill('');
 await page.getByRole('group',{name:'Tool categories'}).getByRole('button',{name:/^All/}).click();
 await go('Runtime health');
 await page.getByRole('heading',{name:'Availability',exact:true}).waitFor();
 await page.getByRole('heading',{name:'Jev decisions',exact:true}).waitFor();
 await page.getByRole('button',{name:'Check runtime',exact:true}).click();
 assert.equal(await page.locator('pre').count(),0);
 await screenshot('health-light.png');
 await go('Usage & cost');
 await page.getByRole('columnheader',{name:'Coverage',exact:true}).waitFor();
 assert.equal(await page.locator('pre').count(),0);
 // Use demo conversations so screenshots never contain private peer data.
 const responder={enabled:true,autonomy:'safe'};
 const device={name:'Workshop PC',url:'http://192.0.2.2:8770',enabled:true,paired:true,own:true,online:true,allow:{chat:true,mail:true},responder:{}};
 const fixture={self:{name:'Demo laptop',addresses:['192.0.2.1'],tailscale:true},firewall:{open:true,port:8770},peers:[device],responder};
 const at=Date.UTC(2026,10,21,9);
 let unread=1;
 const messages=[
  {id:'0',box:'out',at:at-1000,kind:'mail',subject:'GitLab: Comment by root',body:JSON.stringify({id:'e1',kind:'note',project:'ssm/demo',title:'Comment by root'}),hop:0,read:true},
  {id:'1',box:'out',at,kind:'chat',body:'Is the demo board ready?',hop:0,read:true},
  {id:'2',box:'in',at:at+1000,kind:'chat',body:'The demo board is ready for review.',hop:1,read:false},
 ];
 let deviceRequests=0;
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/api/peers'){
   if(url.searchParams.get('view')==='inbox')return route.fulfill({json:{peers:[device],responder}});
   deviceRequests++;
   return route.fulfill({json:fixture});
  }
  if(url.pathname==='/api/mail')return route.fulfill({json:url.searchParams.has('summary')
   ? {threads:[{peer:device.name,unread,latest:{at:at+1000,box:'in',preview:messages[1].body}}]}
   : {messages}});
  if(url.pathname==='/api/mail/read'){
   const {ids}=route.request().postDataJSON();
   for(const message of messages) if(ids.includes(message.id)) message.read=true;
   unread=messages.filter(message=>message.box==='in'&&!message.read).length;
   return route.fulfill({json:{}});
  }
  if(url.pathname==='/api/mail/send'){
   const {kind,subject,body}=route.request().postDataJSON();
   assert.equal(kind,'mail');
   messages.push({id:'3',box:'out',at:at+2000,kind,subject,body,read:true});
   return route.fulfill({json:{}});
  }
  if(url.pathname==='/api/responder'){
   const {peer,enabled}=route.request().postDataJSON();
   assert.equal(peer,device.name);
   device.responder.enabled=enabled;
   return route.fulfill({json:device});
  }
  return route.abort();
 });
 await page.getByLabel('1 unread messages',{exact:true}).waitFor();
 await go('Inbox');
 const search=page.getByRole('searchbox',{name:'Search inbox'});
 await search.waitFor();
 assert.equal(deviceRequests,0,'Inbox must not request device diagnostics');
 await search.fill('does not exist');
 await page.getByText('No matching devices').waitFor();
 await search.fill('demo board');
 await page.getByRole('button',{name:/Workshop PC/}).click();
 await page.getByText('Agent replied automatically',{exact:true}).waitFor();
 await page.getByText('Comment by root',{exact:false}).first().waitFor(); // a forwarded GitLab event shows as one line
 assert.equal(await page.getByText('"project"',{exact:false}).count(),0); // never as raw JSON
 const listHeight=async()=>(await page.locator('aside[aria-label="Conversations"]').boundingBox()).height;
 const before=await listHeight();
 await page.getByRole('combobox',{name:'Message type'}).selectOption('mail');
 await page.getByRole('textbox',{name:'Subject'}).fill('Review complete');
 await page.getByRole('textbox',{name:'Message',exact:true}).fill('The demo board is approved.');
 await page.getByRole('button',{name:'Send',exact:true}).click();
 await page.getByText('Review complete',{exact:true}).waitFor();
 assert.equal(await listHeight(),before); // the inbox never grows with its messages
 assert.equal(await page.getByRole('log',{name:'Messages'}).evaluate(e=>e.scrollHeight>=e.clientHeight),true);
 await screenshot('inbox-light.png');
 await go('Devices');
 await page.getByRole('heading',{name:'Paired computers',exact:true}).waitFor();
 await screenshot('devices-light.png');
 await page.getByRole('switch',{name:'Workshop PC agent auto-reply',exact:true}).click();
 await page.getByRole('switch',{name:'Workshop PC agent auto-reply',exact:true,checked:false}).waitFor();
 await page.getByRole('button',{name:'Pair a computer',exact:true}).click();
 await page.getByRole('textbox',{name:'Pairing code from the other computer'}).waitFor();
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.getByRole('combobox',{name:'Page',exact:true}).selectOption('inbox');
 await page.getByRole('button',{name:/Workshop PC/}).click();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.getByRole('button',{name:'Back to inbox',exact:true}).click();
 await search.waitFor();
 await page.setViewportSize({width:1600,height:1100});
 await page.unroute('**/api/**');
 await page.evaluate(()=>{
  const listeners=new Set();
  const deliver=data=>listeners.forEach(listener=>listener({data}));
  window.chrome.webview={
   addEventListener:(_,listener)=>listeners.add(listener),
   removeEventListener:(_,listener)=>listeners.delete(listener),
   postMessage:request=>{
    if(request.type==='updates.list'){
     deliver({id:request.id,ok:true,current:'1.19.1',autoUpdate:true,autoUpdateAvailable:true,
      releases:[{tag:'v1.19.2',date:'',notes:'',installable:true,newer:true,isCurrent:false}]});
    }
    if(request.type==='updates.install'){
     window.mockUpdateProgress=(message,percent)=>deliver({type:'updateProgress',tag:request.tag,message,percent});
     window.mockUpdateFailure=()=>deliver({id:request.id,ok:false,message:'Setup did not complete.'});
    }
   }
  };
 });
 await go('Updates');
 const update=page.getByRole('button',{name:'Update now',exact:true});
 await update.waitFor();
 const updateButtonStyle=await update.evaluate(element=>{
  const style=getComputedStyle(element);
  return {foreground:style.color,background:style.backgroundColor,height:element.getBoundingClientRect().height};
 });
 assert.notEqual(updateButtonStyle.foreground,updateButtonStyle.background);
 assert.notEqual(updateButtonStyle.background,'rgba(0, 0, 0, 0)');
 assert.ok(updateButtonStyle.height>=32);
 await update.click();
 await page.getByRole('button',{name:'Update in progress',exact:true}).waitFor();
 assert.ok(await page.getByRole('button',{name:'Check now',exact:true}).isDisabled());
 await page.evaluate(()=>window.mockUpdateProgress('Downloading the installer',42));
 const progress=page.getByRole('progressbar',{name:'Update progress'});
 await page.getByText('42%',{exact:true}).waitFor();
 assert.equal(await progress.getAttribute('value'),'42');
 await page.evaluate(()=>window.mockUpdateProgress('Verifying the installer checksum',null));
 await page.getByText(/Verifying the installer checksum/).waitFor();
 assert.equal(await progress.getAttribute('value'),null);
 await page.evaluate(()=>window.mockUpdateProgress('Follow the Nexus Setup window to continue',null));
 await page.getByText(/Follow the Nexus Setup window/).waitFor();
 await page.evaluate(()=>window.mockUpdateFailure());
 await page.getByRole('alert').filter({hasText:'Setup did not complete.'}).waitFor();
 assert.ok(await update.isEnabled());
 await page.evaluate(()=>delete window.chrome.webview);
 await go('Settings');await page.getByRole('button',{name:'Use #a78bfa',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Use #a78bfa',exact:true}).getAttribute('aria-pressed'),'true');
 await page.getByRole('button',{name:'Use dark theme',exact:true}).click();
 await go('Command centre');await screenshot('overview-dark.png');
 await page.getByRole('button',{name:'Collapse navigation',exact:true}).click();assert.equal(await page.locator('nav').evaluate(e=>e.getBoundingClientRect().width),64);
 await page.getByRole('button',{name:'Expand navigation',exact:true}).click();
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await screenshot('mobile-dark.png');
 await page.getByRole('combobox',{name:'Page',exact:true}).selectOption('health');
 await page.getByRole('heading',{name:'Runtime health',exact:true}).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.equal((await page.request.post(origin+'/')).status(),403);
 assert.equal((await page.request.get(origin+'/assets/missing.js')).status(),404);
 assert.deepEqual(errors,[]);
 await page.setViewportSize({width:1600,height:1100});
 injectingFailure=true;
 await page.route('**/runs',route=>route.fulfill({status:503,body:'Unavailable'}));
 await page.getByRole('alert').filter({hasText:'Monitor disconnected'}).waitFor({timeout:6000});
 await page.unroute('**/runs');await page.getByText('Monitor online',{exact:true}).waitFor({timeout:6000});injectingFailure=false;
 console.log(JSON.stringify({passed:true,calls:actual.length,tool_count:(await (await page.request.get(origin+'/tools')).json()).tools.length,themes:['light','dark'],viewports:['1600x1100','390x844'],raw_json_panels:0,filters:true,pagination:true,disconnect_recovery:true,screenshots:fileURLToPath(out),console_errors:errors}));
}finally{await browser.close();}
