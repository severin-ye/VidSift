// Real two-extension messages and IndexedDB. Only synthetic conversations in an isolated profile.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),extension=process.env.VIDSIFT_EXTENSION_ROOT||root,library=process.env.VIDSIFT_LIBRARY_ROOT;
assert(library&&fs.existsSync(path.join(library,'manifest.json')),'Set VIDSIFT_LIBRARY_ROOT to the built library');
const artifacts=process.env.VIDSIFT_POPUP_EVIDENCE||path.join(root,'.task-artifacts','gpt-summary-popup');
fs.mkdirSync(artifacts,{recursive:true});
const profile=fs.mkdtempSync(path.join(artifacts,'profile-')),receiver=fs.mkdtempSync(path.join(artifacts,'receiver-'));
fs.cpSync(library,receiver,{recursive:true});
const manifestPath=path.join(receiver,'manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
manifest.permissions=manifest.permissions.filter(p=>p!=='nativeMessaging');fs.writeFileSync(manifestPath,JSON.stringify(manifest));
const id='kggdkncbamdlhhihfkeldbbkppkgihad',videoUrl='https://www.bilibili.com/video/BV1xx411c7mD';
const cid=n=>String(n).padStart(8,'0')+'-2222-4333-8444-555555555555',chat=n=>'https://chatgpt.com/c/'+cid(n);
const report={owner:'01a1d8e2-a99f-7083-b946-8e6e722a6eae',profile,receiver,dailyProfileUsed:false,nativeDisabled:true,checks:[]};
fs.writeFileSync(path.join(artifacts,'resources.json'),JSON.stringify({...report,cleanup:'Close context, then remove only these two exact directories'},null,2));
let context;
// Toolbar popup targets are real Chrome pages but Playwright does not expose
// them as context pages. Attach only to this isolated browser's exact target.
async function toolbarPopup(browser,worker){
 await until(async()=>!(await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['POPUP']}))).length,'previous toolbar popup closed');
 try{await worker.evaluate(()=>chrome.action.openPopup());}catch(error){
  // The native toolbar widget may finish closing just after its context dies.
  assert(!(await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['POPUP']}))).length);
  await new Promise(r=>setTimeout(r,150));await worker.evaluate(()=>chrome.action.openPopup());
 }
 const client=await browser.newBrowserCDPSession();
 const info=(await client.send('Target.getTargets')).targetInfos.find(t=>t.url==='chrome-extension://'+id+'/popup.html');assert(info,'actual toolbar popup target');
 const {sessionId}=await client.send('Target.attachToTarget',{targetId:info.targetId,flatten:false});let counter=0;const pending=new Map();
 client.on('Target.receivedMessageFromTarget',event=>{if(event.sessionId!==sessionId)return;const message=JSON.parse(event.message),entry=pending.get(message.id);if(entry){pending.delete(message.id);clearTimeout(entry.timer);message.error?entry.reject(Error(message.error.message)):entry.resolve(message.result);}});
 async function rpc(method,params={}){const call=++counter;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(call);reject(Error('Popup CDP timeout: '+method));},6000);pending.set(call,{resolve,reject,timer});client.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id:call,method,params})}).catch(reject);});}
 async function evaluate(expression){const result=await rpc('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.text);return result.result?.value;}
 function locator(selector,last=false){const element=`Array.from(document.querySelectorAll(${JSON.stringify(selector)}))${last?'.at(-1)':'[0]'}`;return {
  count:()=>evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`),
  innerText:()=>evaluate(`${element}?.innerText||''`),inputValue:()=>evaluate(`${element}?.value`),
  isEnabled:()=>evaluate(`!!${element}&&!${element}.disabled`),isVisible:()=>evaluate(`!!${element}&&!!${element}.getClientRects().length`),
  selectOption:value=>evaluate(`(()=>{const e=${element};e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`),
  click:()=>evaluate(`(()=>{${element}.click();return true;})()`),
  boundingBox:()=>evaluate(`(()=>{const r=${element}.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()`),
  last:()=>locator(selector,true)
 };}
 return {locator,close:async()=>{await evaluate('window.close()').catch(()=>{});await until(async()=>!(await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['POPUP']}))).length,'toolbar popup closes');await client.detach().catch(()=>{});},screenshot:async({path:out})=>{const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(out,Buffer.from(shot.data,'base64'));}};
}
async function until(read,why){const end=Date.now()+15000;while(Date.now()<end){if(await read())return;await new Promise(r=>setTimeout(r,80));}throw Error('Timeout: '+why);}
(async()=>{try{
 context=await chromium.launchPersistentContext(profile,{headless:true,channel:'msedge',args:['--disable-extensions-except='+[extension,receiver].join(','),'--load-extension='+[extension,receiver].join(',')]});
 await context.route('https://chatgpt.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><title>合成总结</title><main>用于弹窗测试的合成总结对话</main>'}));
 const control=await context.newPage();await control.goto('chrome-extension://'+id+'/options.html');
 await until(()=>context.serviceWorkers().some(w=>!w.url().includes(id)),'library service worker');
 const libraryId=new URL(context.serviceWorkers().find(w=>!w.url().includes(id)).url()).hostname;
 const worker=context.serviceWorkers().find(w=>w.url().includes(id));
 const external=msg=>control.evaluate(({libraryId,msg})=>chrome.runtime.sendMessage(libraryId,msg),{libraryId,msg});
 await control.evaluate(libraryId=>chrome.storage.local.set({videoLibrarySettings:{enabled:true,reminderEnabled:false,extensionId:libraryId}}),libraryId);
 for(let n=1;n<=12;n++){
  const record={id:cid(n),title:'同视频总结 '+n,videoUrl,chatgptUrl:chat(n),platform:'bilibili',videoId:'BV1xx411c7mD',coverDataUrl:'',coverUrl:'',createdAt:`2026-11-${String(n).padStart(2,'0')}T00:00:00Z`,updatedAt:`2026-11-${String(n).padStart(2,'0')}T00:00:00Z`};
  assert.equal((await external({type:'ZHIXING_VIDSIFT_SAVE_VIDEO',version:1,record})).ok,true);
 }
 const target=await context.newPage();await target.goto(chat(12)+'?model=fixture#tail');
 const targetId=await control.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id,target.url());
 async function popup(){
  await target.bringToFront();
  const page=await toolbarPopup(context.browser(),worker);
  try{await until(()=>page.locator('#summaryRating').isEnabled(),'popup rating readiness');}catch(error){report.popupText=await page.locator('body').innerText();report.popupTabs=await control.evaluate(()=>chrome.tabs.query({active:true,currentWindow:true}));throw error;}return page;
 }
 let panel=await popup();assert.equal(await panel.locator('#summaryRating').inputValue(),'');
 assert.equal(await panel.locator('#summaryList button').count(),10);assert.equal(await panel.locator('#optionArea').isVisible(),false);
 assert.match(await panel.locator('#summaryTitle').innerText(),/总结 12/);
 const bounds=await panel.locator('#summaryRating').boundingBox(),listBounds=await panel.locator('#summaryList').boundingBox();assert(bounds.y<listBounds.y);
 report.checks.push('GPT query/hash route loads current rating first; video extraction controls hidden; 10-row bounded page');
 await panel.locator('#summaryRating').selectOption('8');await until(async()=>/本地保存/.test(await panel.locator('#summaryState').innerText()),'rating saved');
 assert.equal((await external({type:'ZHIXING_VIDSIFT_SUMMARY_CONTEXT',version:1,chatgptUrl:chat(12),limit:10})).rating,8);
 await panel.screenshot({path:path.join(artifacts,'popup-rating.png')});
 await panel.close();
 const book=await context.newPage();await book.goto('chrome-extension://'+libraryId+'/src/library/index.html');
 await book.locator('.all-conversations').click();
 assert.equal(await book.locator('select[data-rating-target="video:'+cid(12)+'"]').inputValue(),'8');
 report.checks.push('popup rating persists through real external message and matches library member control');
 panel=await popup();await panel.locator('#summaryRating').selectOption('');await until(async()=>/本地保存/.test(await panel.locator('#summaryState').innerText()),'rating cleared');
 await panel.close();
 await until(async()=>await book.locator('select[data-rating-target="video:'+cid(12)+'"]').inputValue()==='','library sees clear');
 panel=await popup();assert.equal(await panel.locator('#summaryRating').inputValue(),'');report.checks.push('clear is shared with library and survives reopening popup');
 await panel.locator('#summaryNext').click();await until(async()=>await panel.locator('#summaryList button').count()===2,'second page');
 assert.equal(await panel.locator('#summaryNext').isVisible(),false);
 await panel.screenshot({path:path.join(artifacts,'popup.png')});
 const selected=panel.locator('#summaryList button').last();await selected.click();await target.waitForURL(chat(1));
 assert.equal((await control.evaluate(async id=>chrome.tabs.get(id),targetId)).url,chat(1));
 report.checks.push('second page contains final two members; click navigates original GPT tab without creating a summary');
 panel=await popup();assert.equal(await panel.locator('#summaryRating').inputValue(),'');
 await panel.locator('#summaryRating').selectOption('3');await until(async()=>/本地保存/.test(await panel.locator('#summaryState').innerText()),'second member saved');
 assert.equal((await external({type:'ZHIXING_VIDSIFT_SUMMARY_CONTEXT',version:1,chatgptUrl:chat(12),limit:10})).rating,null);
 assert.equal((await external({type:'ZHIXING_VIDSIFT_SUMMARY_CONTEXT',version:1,chatgptUrl:chat(1),limit:10})).rating,3);
 report.checks.push('switching summary keeps ratings independent');
 await panel.close();await target.goto('https://chatgpt.com/g/g-fixture/c/'+cid(1));panel=await popup();assert.equal(await panel.locator('#summaryRating').inputValue(),'3');
 report.checks.push('custom GPT route finds previously saved ordinary conversation UUID');
 await control.evaluate(()=>chrome.storage.local.set({videoLibrarySettings:{enabled:true,extensionId:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}}));
 await panel.locator('#summaryRating').selectOption('9');await until(async()=>/未确认保存/.test(await panel.locator('#summaryState').innerText()),'failed save reported');
 assert.equal(await panel.locator('#summaryRating').inputValue(),'3');
 assert.equal((await external({type:'ZHIXING_VIDSIFT_SUMMARY_CONTEXT',version:1,chatgptUrl:chat(1),limit:10})).rating,3);
 await control.evaluate(libraryId=>chrome.storage.local.set({videoLibrarySettings:{enabled:true,extensionId:libraryId}}),libraryId);
 report.checks.push('unavailable library rolls UI back to last confirmed score without changing persisted rating');
 await panel.close();await target.goto(chat(99));await target.bringToFront();
 panel=await toolbarPopup(context.browser(),worker);
 await until(async()=>/尚未收录/.test(await panel.locator('#summaryState').innerText()),'unregistered conversation state');assert.equal(await panel.locator('#summaryRating').isEnabled(),false);assert.equal(await panel.locator('#summaryRating').inputValue(),'unknown');
 report.checks.push('missing saved conversation remains explicit unknown with scoring disabled');
 report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{if(context)await context.close();report.contextClosed=true;for(const item of [profile,receiver]){const absolute=path.resolve(item);assert(absolute.startsWith(path.resolve(artifacts)+path.sep));fs.rmSync(absolute,{recursive:true,force:true});}report.profileRemoved=!fs.existsSync(profile);report.receiverRemoved=!fs.existsSync(receiver);fs.writeFileSync(path.join(artifacts,'receipt.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}})();
