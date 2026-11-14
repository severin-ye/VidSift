// Real MV3 message metadata and SPA navigation; summary/library responses are fixtures.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),art=path.join(root,'.task-artifacts','summary-navigation'),id='kggdkncbamdlhhihfkeldbbkppkgihad';
fs.mkdirSync(art,{recursive:true});const profile=fs.mkdtempSync(path.join(art,'profile-')),report={dailyProfileUsed:false,summaryResponsesMocked:true,checks:[]};let context;
const cases=[
 ['bilibili','https://www.bilibili.com/list/watchlater/?bvid=BV1xx411c7mD','https://www.bilibili.com/list/watchlater/?bvid=BV1yy411c7mD'],
 ['youtube','https://www.youtube.com/watch?v=abcdefghijk&list=WL','https://www.youtube.com/watch?v=lmnopqrstuv&list=WL'],
 ['douyin','https://www.douyin.com/user/self?showTab=watch_later&modal_id=123456789','https://www.douyin.com/user/self?showTab=watch_later&modal_id=987654321']
];
(async()=>{try{
 context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.VIDSIFT_BROWSER_EXE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',viewport:{width:1280,height:900},args:['--disable-extensions-except='+root,'--load-extension='+root]});
 for(const host of ['www.bilibili.com','www.youtube.com','www.douyin.com'])await context.route('https://'+host+'/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><title>SPA fixture</title><video style="width:600px;height:300px"></video><button id="next">Next video</button>'}));
 const control=await context.newPage();await control.goto('chrome-extension://'+id+'/options.html');const worker=context.serviceWorkers().find(w=>w.url().includes(id))||await context.waitForEvent('serviceworker');
 await worker.evaluate(()=>{
  globalThis.__navigationSenders=[];
  chrome.runtime.onMessage.addListener((msg,sender)=>{if(msg.type==='VIDSIFT_SUMMARIES_QUERY')__navigationSenders.push({documentUrl:sender.url,tabUrl:sender.tab?.url,requested:msg.videoUrl});});
  _videoLibrary.getSettings=async()=>({enabled:true,reminderEnabled:true});
  VidSiftSummaryLookup.completedPage=async({source})=>({ok:true,records:[{id:'11111111-2222-4333-8444-555555555555',chatgptUrl:'https://chatgpt.com/c/11111111-2222-4333-8444-555555555555',title:source.videoId,createdAt:'2026-11-13T01:00:00Z'}],checked:1,totalCandidates:1,pending:0,unknown:0,nextCursor:null});
 });
 for(const [platform,first,next] of cases){
  const page=await context.newPage();await page.goto(first);await page.locator('#vidsift-summary-reminder .capsule').getByText('已有 1 份总结').waitFor({timeout:10000});
  await page.locator('#next').evaluate((e,url)=>e.onclick=()=>history.pushState({},'',url),next);await page.locator('#next').click();await page.waitForURL(next);
  await page.waitForFunction(()=>document.querySelector('#vidsift-summary-reminder')?.dataset.state==='ready'&&document.querySelector('#vidsift-summary-reminder')?.shadowRoot.querySelector('.record')?.title===(new URL(location.href).searchParams.get('bvid')||new URL(location.href).searchParams.get('v')||new URL(location.href).searchParams.get('modal_id')),{},{timeout:5000});
  assert.match(await page.locator('#vidsift-summary-reminder .capsule').innerText(),/已有 1 份总结/);
  await page.locator('#vidsift-summary-reminder .capsule').click();await page.locator('#vidsift-summary-reminder .refresh').click();await page.waitForFunction(()=>document.querySelector('#vidsift-summary-reminder')?.dataset.state==='ready');
  assert.equal(await page.locator('#vidsift-summary-reminder .record').count(),1);report.checks.push(platform+' same-document next video and manual refresh use current source');await page.close();
 }
 report.senders=await worker.evaluate(()=>__navigationSenders);assert(report.senders.some(s=>s.documentUrl!==s.tabUrl),'exercise actual Chrome stale document URL');report.passed=true;
}catch(e){report.error=e.stack;if(context){report.states=await Promise.all(context.pages().map(async p=>({url:p.url(),note:await p.locator('#vidsift-summary-reminder .note').textContent({timeout:300}).catch(()=>null)})));const w=context.serviceWorkers().find(w=>w.url().includes(id));report.senders=await w?.evaluate(()=>__navigationSenders).catch(()=>null);}process.exitCode=1;}
finally{if(context)await context.close();assert(path.resolve(profile).startsWith(path.resolve(art)+path.sep));fs.rmSync(profile,{recursive:true,force:true});report.profileRemoved=!fs.existsSync(profile);fs.writeFileSync(path.join(art,'receipt.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}})();
