// Real MV3 worker/tabs, isolated Edge; Bilibili/ChatGPT APIs are synthetic.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),art=process.env.VIDSIFT_QUEUE_EVIDENCE||path.join(root,'.task-artifacts','summary-queue-browser');fs.mkdirSync(art,{recursive:true});
const profile=fs.mkdtempSync(path.join(art,'profile-')),id='kggdkncbamdlhhihfkeldbbkppkgihad';
const library=process.env.VIDSIFT_LIBRARY_ROOT,receiver=library&&fs.mkdtempSync(path.join(art,'receiver-'));
if(receiver){
 fs.cpSync(library,receiver,{recursive:true});
 const manifestPath=path.join(receiver,'manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
 manifest.permissions=manifest.permissions.filter(permission=>permission!=='nativeMessaging');
 fs.writeFileSync(manifestPath,JSON.stringify(manifest));
}
const report={owner:'01a1cd4c',profile,syntheticAPI:true,dailyProfileUsed:false,checks:[]};
fs.writeFileSync(path.join(art,'resource.json'),JSON.stringify({owner:report.owner,profile,purpose:'close source and queue generation acceptance',cleanup:'close context and remove this exact profile'},null,2));
let context,control,worker;const conversations=new Map(),finished=new Set(),failed=new Set();let sends=0;
async function until(fn,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('acceptance timeout');}
const html=`<!doctype html><title>Queue fixture</title><form><div id="prompt-textarea" contenteditable="true"></div><input type="file" multiple><button type="button" data-testid="send-button">Send</button></form><script>
const cid=crypto.randomUUID();document.querySelector('input').onchange=event=>{for(const file of event.target.files){const tile=document.createElement('div');tile.className='file-tile';tile.setAttribute('role','group');tile.setAttribute('aria-label',file.name);tile.textContent=file.name;document.querySelector('form').append(tile);}};
document.querySelector('button').onclick=async()=>{const text=document.querySelector('#prompt-textarea').innerText;await fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({conversation_id:cid,messages:[{id:crypto.randomUUID(),author:{role:'user'},content:{parts:[text]}}]})});document.querySelector('#prompt-textarea').textContent='';history.replaceState({},'','/c/'+cid);};</script>`;
(async()=>{try{
 const extensions=receiver?[root,receiver].join(','):root;
 context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.VIDSIFT_BROWSER_EXE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--disable-extensions-except='+extensions,'--load-extension='+extensions]});
 await context.route('https://www.bilibili.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Source</title>'}));
 await context.route('https://chatgpt.com/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/fixture-worker.js')return route.fulfill({contentType:'application/javascript',body:`self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(e.request.mode==='navigate')e.respondWith(new Response(${JSON.stringify(html)},{headers:{'Content-Type':'text/html'}}));});`});
  if(url.pathname==='/api/auth/session')return route.fulfill({json:{accessToken:'synthetic'}});
  if(url.pathname==='/backend-api/f/conversation'){
   const body=route.request().postDataJSON();sends++;conversations.set(body.conversation_id,{message:body.messages[0],created:Date.now()/1000});
   return route.fulfill({contentType:'text/event-stream',body:'data: '+JSON.stringify({conversation_id:body.conversation_id})+'\n\ndata: [DONE]\n\n'});
  }
  const cid=url.pathname.split('/').at(-1),conversation=conversations.get(cid);
  if(conversation){
   if(route.request().method()==='PATCH')return route.fulfill({json:{ok:true}});
   return route.fulfill({json:{conversation_id:cid,title:'Fixture title already generated',create_time:conversation.created,mapping:{user:{message:conversation.message},reply:{parent:'user',message:{author:{role:'assistant'},status:failed.has(cid)?'failed':finished.has(cid)?'finished_successfully':'in_progress',end_turn:finished.has(cid),content:{content_type:'text',parts:['A synthetic completed summary']}}}}}});
  }
  return route.fulfill({contentType:'text/html',body:html});
 });
 const warm=await context.newPage();await warm.goto('https://chatgpt.com/');await warm.evaluate(async()=>{await navigator.serviceWorker.register('/fixture-worker.js');await navigator.serviceWorker.ready;});await warm.close();
 control=await context.newPage();await control.goto('chrome-extension://'+id+'/popup.html');
 await until(()=>context.serviceWorkers().some(w=>w.url().includes(id)));
 worker=context.serviceWorkers().find(w=>w.url().includes(id));
 let libraryId;
 if(receiver){
  await until(()=>context.serviceWorkers().some(w=>!w.url().includes(id)));
  libraryId=new URL(context.serviceWorkers().find(w=>!w.url().includes(id)).url()).hostname;
 }
 await worker.evaluate(libraryEnabled=>{
  const realFetch=fetch;globalThis.fetch=async(url,options)=>{
   const u=new URL(url);if(u.hostname==='api.bilibili.com'){
    if(u.pathname.endsWith('/view')){if(options?.credentials!=='include')throw Error('redundant library cover fetch must not be required');const bvid=u.searchParams.get('bvid');return new Response(JSON.stringify({code:0,data:{bvid,aid:1,cid:2,pic:'http://i1.hdslb.com/'+bvid+'.jpg',title:'Fixture '+bvid,duration:10,pages:[{cid:2,duration:10}]}}));}
    return new Response(JSON.stringify({data:{subtitle:{subtitles:[{lan:'zh',subtitle_url:'https://fixture.test/subtitle'}]}}}));
   }
   if(u.hostname==='fixture.test')return new Response(JSON.stringify({body:[{from:0,to:1,content:'Synthetic complete subtitle'}]}));
   if(u.hostname==='i1.hdslb.com')return new Response(null,{status:404});
   return realFetch(url,options);
  };
  globalThis.libraryRegistrations=[];const register=_videoLibrary.register.bind(_videoLibrary);_videoLibrary.register=async task=>{libraryRegistrations.push(task);return register(task);};
  if(!libraryEnabled)_videoLibrary.drain=async()=>{};
 },!!receiver);
 await control.evaluate(extensionId=>chrome.storage.local.set({videoLibrarySettings:{enabled:true,reminderEnabled:false,extensionId},customPrompt:'Summarize this synthetic test subtitle.'}),libraryId);
 const a=await context.newPage(),b=await context.newPage(),c=await context.newPage();await a.goto('https://www.bilibili.com/video/BVtest00000A');await b.goto('https://www.bilibili.com/video/BVtest00000B');await c.goto('https://www.bilibili.com/video/BVtest00000C');
 await control.evaluate(async()=>{
  window.notes=[];window.ports=[];const tabs=(await chrome.tabs.query({})).filter(t=>t.url?.includes('/video/BVtest'));
  for(const tab of tabs){const p=chrome.runtime.connect({name:'vidsift-video'});ports.push(p);p.onMessage.addListener(m=>notes.push({source:tab.id,...m}));p.postMessage({type:'START_VIDEO_TASK',sourceUrl:tab.url,openerTabId:tab.id,source:{},bgOpen:true,tempChat:false,screenshotSettings:{enabled:false}});}
 });
 await until(()=>control.evaluate(()=>notes.filter(note=>note.type==='ACCEPTED').length===3));
 await a.close();await c.close();
 await until(()=>sends===1);await new Promise(r=>setTimeout(r,1200));
 assert.equal(sends,1,'second job must wait beyond send acknowledgement and generated title');
 assert.equal(await worker.evaluate(()=>_summaryQueue.length),3);
 assert.deepEqual((await control.evaluate(()=>chrome.tabs.query({}))).filter(t=>t.url?.includes('/video/BVtest')).map(t=>t.url.split('/').at(-1)),['BVtest00000B']);
 report.checks.push('first and third source tabs closed after acceptance; first summary sends once','later summaries remain queued while first has generated title but unfinished response');
 failed.add([...conversations.keys()][0]);await until(()=>sends===2);assert.equal(sends,2);
 finished.add([...conversations.keys()][1]);await until(()=>sends===3);
 for(const cid of conversations.keys())finished.add(cid);
 await until(()=>worker.evaluate(()=>_summaryQueue.length===0));
 const notes=await control.evaluate(()=>window.notes);assert.equal(notes.filter(n=>n.type==='ERROR').length,1,JSON.stringify(notes));assert.match(notes.find(n=>n.type==='ERROR').text,/生成失败/);assert.equal(notes.filter(n=>n.type==='DONE').length,2);assert.equal(notes.filter(n=>n.type==='ACCEPTED').length,3);
 assert.equal(b.isClosed(),false);
 const registered=await worker.evaluate(()=>libraryRegistrations);assert.equal(registered.length,3);for(const task of registered)assert.equal(task.source.coverUrl,'https://i1.hdslb.com/'+task.source.videoId+'.jpg@640w_360h_1c.jpg');
 report.checks.push('explicit first generation failure releases second job without resend','second generation completes with source open and releases third job','all three summaries retain the matching normalized cover at library registration');
 if(libraryId){
  for(const [index,visit] of [false,true].entries()){
   const source=await context.newPage();await source.goto('https://www.bilibili.com/video/BVcollect00'+index);
   await source.bringToFront();
   await control.evaluate(async sourceUrl=>{
    const tab=(await chrome.tabs.query({})).find(candidate=>candidate.url===sourceUrl);
    const port=chrome.runtime.connect({name:'vidsift-video'});
    ports.push(port);port.onMessage.addListener(message=>notes.push({source:tab.id,...message}));
    port.postMessage({type:'START_VIDEO_TASK',sourceUrl,openerTabId:tab.id,collect:true,bgOpen:false,tempChat:true,screenshotSettings:{enabled:false}});
   },source.url());
   await until(()=>sends===index+4);
   const conversationId=[...conversations.keys()].at(-1),chatgptUrl='https://chatgpt.com/c/'+conversationId;
   const read=()=>control.evaluate(({libraryId,chatgptUrl})=>chrome.runtime.sendMessage(libraryId,{type:'ZHIXING_VIDSIFT_SUMMARY_CONTEXT',version:1,chatgptUrl,limit:10}),{libraryId,chatgptUrl});
   const tabs=()=>control.evaluate(()=>chrome.tabs.query({}));
   await until(async()=> (await tabs()).some(tab=>tab.url===chatgptUrl));
   assert.equal((await tabs()).find(tab=>tab.active).url,source.url());
   assert.equal((await read()).code,'NOT_FOUND','unfinished collection must not appear in the library');
   if(visit){
    const page=context.pages().find(candidate=>candidate.url()===chatgptUrl);assert(page);
    await page.bringToFront();await source.bringToFront();
   }
   finished.add(conversationId);
   await until(()=>worker.evaluate(()=>_summaryQueue.length===0));
   const saved=await read();
   assert.equal(saved.ok,true,'completed collection is stored under its real conversation ID: '+JSON.stringify(saved));
   assert.equal((await tabs()).some(tab=>tab.url===chatgptUrl),visit,'preserve any collection tab the user activated');
   assert.equal((await tabs()).find(tab=>tab.active).url,source.url());
  }
  report.checks.push('collection uses a normal ChatGPT conversation without stealing focus; durable library record appears only after completion; untouched tab closes and a visited tab stays');
 }
 report.passed=true;
}catch(error){report.notifications=await control?.evaluate(()=>window.notes).catch(()=>[]);report.targets=await control?.evaluate(()=>chrome.tabs.query({})).then(tabs=>tabs.map(t=>({id:t.id,url:t.url,title:t.title}))).catch(()=>[]);report.queue=await worker?.evaluate(()=>_summaryQueue.map(j=>({id:j.task?.id,status:j.task?.statusText,cancelled:j.task?.cancelled}))).catch(()=>[]);report.library=await worker?.evaluate(()=>_videoLibrary.status()).catch(()=>null);report.error=error.stack;process.exitCode=1;}finally{
 if(context)await context.close();report.contextClosed=true;
 for(const item of [profile,receiver].filter(Boolean)){assert(path.resolve(item).startsWith(path.resolve(art)+path.sep));fs.rmSync(item,{recursive:true,force:true});}
 report.profileRemoved=!fs.existsSync(profile);report.receiverRemoved=!receiver||!fs.existsSync(receiver);
 fs.writeFileSync(path.join(art,'receipt.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}})();
