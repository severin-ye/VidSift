// Opt-in real public Bilibili integration; isolated, signed out, no daily profile.
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),art=path.join(root,'.task-artifacts','bili-public');fs.mkdirSync(art,{recursive:true});
const profile=path.join(art,'profile-'+crypto.randomUUID()),id='kggdkncbamdlhhihfkeldbbkppkgihad',bvid=process.env.VIDSIFT_TEST_BVID||'BV18R4s6dEQe';
const report={owner:'01a1d2e9-3963-7633-8a21-f7a86be45275',profile,bvid,realBilibili:true,signedIn:false,dailyProfileUsed:false,historyVerified:false};
fs.writeFileSync(path.join(art,'resource.json'),JSON.stringify({...report,cleanup:'close owned context then remove only generated profile'},null,2));
let context,worker;
(async()=>{try{
 context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.VIDSIFT_BROWSER_EXE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--disable-extensions-except='+root,'--load-extension='+root]});
 const control=await context.newPage();await control.goto('chrome-extension://'+id+'/options.html');
 worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'+id))||await context.waitForEvent('serviceworker');
 await control.evaluate(()=>chrome.storage.local.set({videoLibrarySettings:{enabled:false},biliCompanionEnabled:true}));
 await worker.evaluate(bvid=>VidSiftCompanion.enqueue({platform:'bilibili',videoId:bvid,part:1}),bvid);
 const deadline=Date.now()+75000;let state;
 while(Date.now()<deadline){state=await worker.evaluate(()=>VidSiftCompanion.status());if(state.current?.state==='playing'||!state.current)break;await new Promise(resolve=>setTimeout(resolve,1000));}
 const page=context.pages().find(page=>page.url().includes(bvid));
 if(page){
  report.domMedia=await page.locator('video,bwp-video').evaluateAll(elements=>elements.map(e=>({tag:e.tagName,ready:e.readyState,duration:Number.isFinite(e.duration)?e.duration:null,time:e.currentTime,paused:e.paused,muted:e.muted,playType:typeof e.play}))).catch(()=>[]);
  report.pageTitle=await page.title();await page.screenshot({path:path.join(art,'actual-player.png')}).catch(()=>{});
 }
 report.state=state;
 assert.equal(state?.current?.state,'playing','real official page must start muted actual playback');
 await new Promise(resolve=>setTimeout(resolve,12000));
 const after=await worker.evaluate(()=>VidSiftCompanion.status());report.after=after;
 assert(after.current?.position>state.current.position+5,'official playback must advance without seeking');
 const tab=await control.evaluate(tabId=>chrome.tabs.get(tabId),after.current.tabId);assert.equal(tab.mutedInfo.muted,true);assert.equal(tab.active,false);
 report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{
 if(worker)await worker.evaluate(()=>VidSiftCompanion.stopAll()).catch(()=>{});
 if(context)await context.close();report.contextClosed=true;
 assert(path.resolve(profile).startsWith(path.resolve(art)+path.sep));fs.rmSync(profile,{recursive:true,force:true});report.profileRemoved=!fs.existsSync(profile);
 fs.writeFileSync(path.join(art,'receipt.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}})();
