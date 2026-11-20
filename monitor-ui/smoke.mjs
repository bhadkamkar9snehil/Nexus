// Browser plugin not available; use the harness's installed Playwright for rendered QA.
import {chromium} from '../jev-use/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const out=new URL('../docs/screenshots/',import.meta.url);
const origin=`http://127.0.0.1:${Number(process.env.NEXUS_MONITOR_PORT || 8769)}`;
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1100}});
const errors=[];let injectingFailure=false;page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!injectingFailure)errors.push(m.text());});
const screenshot=async name=>{await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:fileURLToPath(new URL(name,out)),fullPage:true});};
const go=async name=>{await page.getByRole('button',{name,exact:true}).click();await page.getByRole('heading',{name,exact:true}).waitFor();};
try{
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
 await page.getByRole('heading',{name:'Terminal sessions',exact:true}).waitFor();
 await page.waitForFunction(()=>!document.body.innerText.includes('Checking sessions…'));
 const sessionResult=await (await page.request.get(origin+'/sessions')).json();
 assert.ok(Array.isArray(sessionResult.sessions));
 for(const session of sessionResult.sessions) assert.deepEqual(Object.keys(session).sort(),['ended_at','exit_code','pid','session_id','shell','started_at','state']);
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
 await go('Appearance');await page.getByRole('button',{name:'Use #a78bfa',exact:true}).click();
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
