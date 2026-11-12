// Two real extensions, isolated profile and synthetic video/ChatGPT pages.
// No daily login, user annotations, native registration or shared center touched.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),library=process.env.VIDSIFT_LIBRARY_ROOT,extension=process.env.VIDSIFT_EXTENSION_ROOT||root;
assert(library&&fs.existsSync(path.join(library,'manifest.json')),'VIDSIFT_LIBRARY_ROOT must point to the built annotation extension');
const artifacts=path.join(root,'.task-artifacts','video-library-integration');fs.mkdirSync(artifacts,{recursive:true});
const profile=path.join(artifacts,'profile-'+Date.now());
const receiverFixture=fs.mkdtempSync(path.join(artifacts,'receiver-'));
fs.cpSync(library,receiverFixture,{recursive:true});
const fixtureManifestPath=path.join(receiverFixture,'manifest.json'),fixtureManifest=JSON.parse(fs.readFileSync(fixtureManifestPath,'utf8'));
fixtureManifest.permissions=(fixtureManifest.permissions||[]).filter(p=>p!=='nativeMessaging');
fs.writeFileSync(fixtureManifestPath,JSON.stringify(fixtureManifest,null,2));
const report={syntheticPages:true,dailyProfileUsed:false,nativePermissionRemovedFromTestCopy:true,profile,receiverFixture,checks:[],passed:false};
fs.writeFileSync(path.join(artifacts,'resource.json'),JSON.stringify({owner:'video-library-integration',profile,receiverFixture,purpose:'isolated two-extension test without Native access',cleanup:'close context then remove only these test paths'},null,2));
const video='https://www.bilibili.com/video/BV1uLpn6AEtS',cid='11111111-2222-4333-8444-555555555555',id='kggdkncbamdlhhihfkeldbbkppkgihad';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const chatHTML=`<!doctype html><meta charset="utf-8"><title>Library fixture</title><main><form><div id="prompt-textarea" contenteditable="true" role="textbox"></div><input type="file" multiple><button type="button" data-testid="send-button">Send</button></form><article>合成的视频总结正文。</article></main><script>
window.sent=[];document.querySelector('input').onchange=event=>{for(const file of event.target.files){const tile=document.createElement('div');tile.className='file-tile';tile.setAttribute('role','group');tile.setAttribute('aria-label',file.name);tile.textContent=file.name;document.querySelector('form').append(tile);}};
document.querySelector('button').onclick=async()=>{await fetch('/backend-api/f/conversation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[{author:{role:'user'},content:{parts:[document.querySelector('#prompt-textarea').innerText]}}]})});window.sent.push(document.querySelector('#prompt-textarea').innerText);document.querySelector('#prompt-textarea').textContent='';history.pushState({},'',location.search.includes('temporary-chat')?'/?temporary-chat=true':'/c/${cid}');};</script>`;
let context;
async function tabs(control,url){return control.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url),url);}
async function refresh(page){await page.locator('#refresh').click();await page.waitForTimeout(150);}
(async()=>{
 try{
 context=await chromium.launchPersistentContext(profile,{headless:true,channel:process.env.VIDSIFT_BROWSER_CHANNEL||'msedge',args:['--disable-extensions-except='+[extension,receiverFixture].join(','),'--load-extension='+[extension,receiverFixture].join(',')]});
 await context.route('https://api.bilibili.com/**',route=>route.fulfill({json:{code:0,data:{bvid:'BV1uLpn6AEtS',pic:'http://i0.hdslb.com/fixture.jpg',title:'联动验收视频'}}}));
 await context.route('https://i0.hdslb.com/**',route=>route.fulfill({contentType:'image/png',body:png}));
 await context.route('https://www.bilibili.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>联动验收视频</title><main>合成视频页</main>'}));
 await context.route('https://chatgpt.com/**',route=>{const u=new URL(route.request().url());return route.fulfill(u.pathname==='/api/auth/session'?{json:{accessToken:'synthetic-test-token'}}:u.pathname==='/backend-api/f/conversation'?{contentType:'text/event-stream',body:'data: '+JSON.stringify({conversation_id:cid})+'\n\n'}:u.pathname.startsWith('/backend-api/')?{json:{title:'联动验收视频'}}:{contentType:'text/html',body:chatHTML});});
 const control=await context.newPage();await control.goto(`chrome-extension://${id}/options.html`);await control.locator('#library-id').waitFor();
 const worker=context.serviceWorkers().find(w=>w.url().includes(id))||await context.waitForEvent('serviceworker',w=>w.url().includes(id));
 const deadline=Date.now()+15000;while(!context.serviceWorkers().some(w=>!w.url().includes(id))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
 const libraryWorker=context.serviceWorkers().find(w=>!w.url().includes(id));assert(libraryWorker,'annotation worker loaded');const receiver=new URL(libraryWorker.url()).hostname;report.receiver=receiver;
 await control.locator('#library-id').fill(receiver);await control.locator('#library-save').click();
 const popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);assert.equal(await popup.locator('#tempChatCheckbox').isChecked(),false);await popup.close();report.checks.push('ordinary chat is the default');
 const source=await context.newPage();await source.goto(video);const target=await context.newPage();await target.goto('https://chatgpt.com/');
 const targetTab=await tabs(control,'https://chatgpt.com/'),sourceTab=await tabs(control,video);assert(targetTab&&sourceTab);
 await source.close();report.checks.push('source tab closes before cover registration; HTTP metadata must supply the HTTPS cover');
 const prepared=await worker.evaluate(async ({taskId,targetTabId,openerTabId,url})=>prepareVideoLibraryTask({taskId,targetTabId,openerTabId,source:{url},videoTitle:'联动验收视频',tempChat:false}),{taskId:'integration-normal',targetTabId:targetTab.id,openerTabId:sourceTab.id,url:video});assert.equal(prepared,true);
 await control.evaluate(async ({tabId})=>chrome.tabs.sendMessage(tabId,{type:'VIDSIFT_CHATGPT_PREPARE_PROMPT',taskId:'integration-normal',libraryEligible:true,tempChat:false,videoTitle:'联动验收视频',source:{url:'https://www.bilibili.com/video/BV1uLpn6AEtS'},file:{name:'fixture.srt',content:'1\n00:00:00,000 --> 00:00:02,000\nSynthetic transcript.'},prompt:'First paragraph\n\nSecond paragraph\n\nThird paragraph'}),{tabId:targetTab.id});
 await target.waitForURL('**/c/'+cid,{timeout:20000});
 await control.waitForFunction(async()=>{const x=await chrome.runtime.sendMessage({type:'VIDSIFT_LIBRARY_STATUS'});return x.ok&&x.pending===0&&x.lastSavedAt;},{},{timeout:20000});
 assert.equal(await target.evaluate(()=>window.sent.length),1);report.checks.push('real content submission obtains conversation URL and hands metadata to the second extension once');
 const book=await context.newPage();await book.goto(`chrome-extension://${receiver}/src/library/index.html`);await book.locator('.book.video').waitFor();assert.equal(await book.locator('.book.video').count(),1);
 await book.locator('[data-source="video"]').click();await book.locator('#annotation-filter').selectOption('without');assert.equal(await book.locator('.book.video').count(),1);await book.locator('.book.video').click();
 assert.equal(await book.locator('#reader-actions a').count(),2);assert(await book.locator('#reader-actions a').evaluateAll(links=>links.some(a=>a.href==='https://chatgpt.com/c/11111111-2222-4333-8444-555555555555')));assert(await book.locator('.video-cover').count()||await book.locator('.book.video img').count()||await book.locator('#reader img').count());await book.locator('#close-reader').click();report.checks.push('zero-annotation card contains persisted cover, source video and private conversation links');
 await book.locator('#annotation-filter').selectOption('with');assert.equal(await book.locator('.book.video').count(),0);
 const note=await book.evaluate(async url=>chrome.runtime.sendMessage({type:'CREATE_HIGHLIGHT',payload:{url,title:'联动验收视频',domain:'chatgpt.com',text:'合成的视频总结正文。',color:'yellow',note:'',anchor:{text:'合成的视频总结正文。',prefix:'',suffix:'',xpath:'/html/body/main/article',offset:0,endXpath:'/html/body/main/article',endOffset:11}}}),`https://chatgpt.com/c/${cid}`);assert.equal(note.type,'HIGHLIGHT_SAVED');await refresh(book);assert.equal(await book.locator('.book.video').count(),1);report.checks.push('pure highlight counts as annotated without creating a duplicate web card');
 await book.evaluate(async highlightId=>chrome.runtime.sendMessage({type:'DELETE_HIGHLIGHT',highlightId}),note.savedHighlight.id);await refresh(book);assert.equal(await book.locator('.book.video').count(),0);await book.locator('#annotation-filter').selectOption('without');assert.equal(await book.locator('.book.video').count(),1);report.checks.push('deleting the last highlight retains the video record as unannotated');
 await book.reload();await book.locator('.book.video').waitFor();assert.equal(await book.locator('.book.video').count(),1);report.checks.push('card survives library reload');
 const temp=await context.newPage();await temp.goto('https://chatgpt.com/?temporary-chat=true');const tempTab=await tabs(control,'https://chatgpt.com/?temporary-chat=true');
 assert.equal(await worker.evaluate(async data=>prepareVideoLibraryTask(data),{taskId:'integration-temp',targetTabId:tempTab.id,openerTabId:sourceTab.id,source:{url:video},tempChat:true}),false);
 const before=await control.evaluate(()=>chrome.storage.local.get('videoLibraryState'));assert.equal(before.videoLibraryState.tasks.some(x=>x.taskId==='integration-temp'),false);report.checks.push('temporary chat is excluded before registration and queueing');
 await book.screenshot({path:path.join(artifacts,'library.png'),fullPage:true});report.passed=true;
 }catch(error){report.error=String(error.stack||error);throw error;}
 finally{if(context)await context.close();report.contextClosed=true;for(const target of [profile,receiverFixture]){const absolute=path.resolve(target);if(absolute.startsWith(path.resolve(artifacts)+path.sep))fs.rmSync(absolute,{recursive:true,force:true});}report.profileRemoved=!fs.existsSync(profile);report.receiverFixtureRemoved=!fs.existsSync(receiverFixture);fs.writeFileSync(path.join(artifacts,'receipt.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:report.checks,profileRemoved:report.profileRemoved,receiverFixtureRemoved:report.receiverFixtureRemoved,receipt:path.join(artifacts,'receipt.json')}));}
})().catch(e=>{console.error(e);process.exitCode=1;});
