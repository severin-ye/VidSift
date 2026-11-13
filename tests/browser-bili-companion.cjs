// Isolated MV3 Edge with real media playback; Bilibili HTML/API are synthetic.
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),art=path.join(root,'.task-artifacts','bili-companion-browser');fs.mkdirSync(art,{recursive:true});
const profile=path.join(art,'profile-'+crypto.randomUUID()),id='kggdkncbamdlhhihfkeldbbkppkgihad';
const report={owner:'01a1d2e9-3963-7633-8a21-f7a86be45275',profile,syntheticSite:true,realMediaElement:true,dailyProfileUsed:false,checks:[]};
fs.writeFileSync(path.join(art,'resource.json'),JSON.stringify({...report,purpose:'isolated companion playback and settings acceptance',cleanup:'close context then remove only this generated profile'},null,2));
// Four seconds of actual PCM media, not a mocked play() method or forged ended event.
const rate=8000,samples=rate*4,wav=Buffer.alloc(44+samples*2);
wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(samples*2,40);
for(let i=0;i<samples;i++)wav.writeInt16LE(Math.round(Math.sin(i/rate*440*Math.PI*2)*1000),44+i*2);
let context,control,worker;
async function until(read,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){const result=await read();if(result)return result;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('companion browser acceptance timeout');}
const state=()=>worker.evaluate(()=>VidSiftCompanion.status());
const source=(videoId,part=1)=>({platform:'bilibili',videoId,part,title:'Synthetic companion '+videoId});
(async()=>{try{
 context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.VIDSIFT_BROWSER_EXE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--disable-extensions-except='+root,'--load-extension='+root]});
 await context.route('https://www.bilibili.com/**',route=>route.request().url().includes('fixture.wav')?route.fulfill({contentType:'audio/wav',body:wav}):route.fulfill({contentType:'text/html',body:'<!doctype html><title>Synthetic Bilibili</title><h1>Companion fixture</h1><video controls preload="auto" src="/fixture.wav"></video>'}));
 control=await context.newPage();await control.goto('chrome-extension://'+id+'/options.html');
 worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'+id))||await context.waitForEvent('serviceworker');
 await worker.evaluate(()=>{
  globalThis.companionTestEvents=[];
  for(const method of ['onUpdated','onActivated','onRemoved']){
   const original=VidSiftCompanion[method].bind(VidSiftCompanion);
   VidSiftCompanion[method]=(...args)=>{companionTestEvents.push({method,args});return original(...args);};
  }
 });
 await control.evaluate(()=>chrome.storage.local.set({customPrompt:'private fixture prompt',videoLibrarySettings:{enabled:false},biliCompanionEnabled:true}));
 const normal=await context.newPage();await normal.goto('https://www.bilibili.com/video/BVordinary');
 await normal.locator('video').waitFor();await control.bringToFront();
 const enqueue=value=>worker.evaluate(source=>VidSiftCompanion.enqueue(source,{taskId:'synthetic-summary'}),value);
 await enqueue(source('BVcompanionA',2));await enqueue(source('BVcompanionB'));await enqueue(source('BVcompanionB'));
 let current=await until(async()=>{const value=await state();return value.current?.state==='playing'?value:null;});
 assert.equal(current.queued,1);
 const firstId=current.current.tabId,tab=await control.evaluate(id=>chrome.tabs.get(id),firstId);
 assert.equal(tab.active,false);assert.equal(tab.mutedInfo.muted,true);assert.match(tab.url,/BVcompanionA\?p=2/);
 const firstPage=context.pages().find(page=>page.url().includes('BVcompanionA'));assert(firstPage);
 const media=await firstPage.locator('video').evaluate(video=>({muted:video.muted,rate:video.playbackRate,time:video.currentTime,paused:video.paused}));
 assert.equal(media.muted,true);assert.equal(media.rate,1);assert.equal(media.paused,false);assert(media.time>0&&media.time<4);
 assert.equal(await normal.locator('video').evaluate(video=>video.paused),true);
 report.checks.push('ordinary source remains paused; owned official-host page plays actual media muted at 1x in background','part identity and duplicate queue entries preserved');
 await until(async()=>{const value=await state();return value.current?.source.videoId==='BVcompanionB';});
 await until(async()=>!(await state()).current);
 const completed=await state();assert.equal(completed.last.state,'player-ended');assert.equal(completed.historyConfirmed,false);assert.equal(completed.queued,0);
 report.checks.push('two real-media ended events close each owned tab and advance queue; no synthetic history confirmation');
 await enqueue(source('BVstopA'));await enqueue(source('BVstopB'));
 await until(async()=>(await state()).current?.state==='playing');
 await control.locator('#companion-stop').click();await until(async()=>{const value=await state();return !value.current&&value.queued===0;});
 await control.locator('#companion-enabled').uncheck();await control.locator('#companion-save').click();await until(async()=>(await state()).enabled===false);
 const skipped=await enqueue(source('BVdisabled'));assert.equal(skipped.ok,false);
 assert.equal(await control.evaluate(async()=>(await chrome.storage.local.get('customPrompt')).customPrompt),'private fixture prompt');
 assert.equal(await control.locator('#companion-label').innerText(),'总结伴播·关');
 await control.screenshot({path:path.join(art,'settings.png'),fullPage:true});
 report.checks.push('settings stop-all clears queue, saved off blocks future playback and leaves custom prompt unchanged');
 await control.locator('#companion-reset').click();await until(async()=>(await state()).enabled===true);
 await enqueue(source('BVcloseA'));await until(async()=>(await state()).current?.state==='playing');
 const closedId=(await state()).current.tabId;await control.evaluate(id=>chrome.tabs.remove(id),closedId);await until(async()=>!(await state()).current);
 await new Promise(resolve=>setTimeout(resolve,500));assert.equal((await state()).current,null);
 report.checks.push('manual close stops current item and does not reopen it');
 const errors=await control.evaluate(async()=>{const value=await chrome.storage.local.get(null);return JSON.stringify(value.biliCompanionLast);});
 assert(!/BVcloseA|BVcompanion/.test(errors));
 report.passed=true;
}catch(error){report.error=error.stack;report.status=await state().catch(()=>null);report.events=await worker?.evaluate(()=>companionTestEvents).catch(()=>null);process.exitCode=1;}
finally{
 if(context)await context.close();report.contextClosed=true;
 assert(path.resolve(profile).startsWith(path.resolve(art)+path.sep));fs.rmSync(profile,{recursive:true,force:true});report.profileRemoved=!fs.existsSync(profile);
 fs.writeFileSync(path.join(art,'receipt.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}})();
