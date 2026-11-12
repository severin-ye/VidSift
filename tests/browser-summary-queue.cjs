// Real MV3 worker/tabs, isolated Edge; Bilibili/ChatGPT APIs are synthetic.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),art=path.join(root,'.task-artifacts','summary-queue-browser');fs.mkdirSync(art,{recursive:true});
const profile=fs.mkdtempSync(path.join(art,'profile-')),id='kggdkncbamdlhhihfkeldbbkppkgihad';
const report={owner:'01a1cd4c',profile,syntheticAPI:true,dailyProfileUsed:false,checks:[]};
fs.writeFileSync(path.join(art,'resource.json'),JSON.stringify({owner:report.owner,profile,purpose:'close source and queue generation acceptance',cleanup:'close context and remove this exact profile'},null,2));
let context,control,worker;const conversations=new Map(),finished=new Set();let sends=0;
async function until(fn,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('acceptance timeout');}
const html=`<!doctype html><title>Queue fixture</title><form><div id="prompt-textarea" contenteditable="true"></div><input type="file" multiple><button type="button" data-testid="send-button">Send</button></form><script>
const cid=crypto.randomUUID();document.querySelector('input').onchange=event=>{for(const file of event.target.files){const tile=document.createElement('div');tile.className='file-tile';tile.setAttribute('role','group');tile.setAttribute('aria-label',file.name);tile.textContent=file.name;document.querySelector('form').append(tile);}};
document.querySelector('button').onclick=async()=>{const text=document.querySelector('#prompt-textarea').innerText;await fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({conversation_id:cid,messages:[{id:crypto.randomUUID(),author:{role:'user'},content:{parts:[text]}}]})});document.querySelector('#prompt-textarea').textContent='';history.replaceState({},'','/c/'+cid);};</script>`;
(async()=>{try{
 context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.VIDSIFT_BROWSER_EXE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--disable-extensions-except='+root,'--load-extension='+root]});
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
   return route.fulfill({json:{conversation_id:cid,title:'Fixture title already generated',create_time:conversation.created,mapping:{user:{message:conversation.message},reply:{parent:'user',message:{author:{role:'assistant'},status:finished.has(cid)?'finished_successfully':'in_progress',end_turn:finished.has(cid)}}}}});
  }
  return route.fulfill({contentType:'text/html',body:html});
 });
 const warm=await context.newPage();await warm.goto('https://chatgpt.com/');await warm.evaluate(async()=>{await navigator.serviceWorker.register('/fixture-worker.js');await navigator.serviceWorker.ready;});await warm.close();
 control=await context.newPage();await control.goto('chrome-extension://'+id+'/options.html');
 worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'))||await context.waitForEvent('serviceworker');
 await worker.evaluate(()=>{
  const realFetch=fetch;globalThis.fetch=async(url,options)=>{
   const u=new URL(url);if(u.hostname==='api.bilibili.com'){
    if(u.pathname.endsWith('/view')){const bvid=u.searchParams.get('bvid');return new Response(JSON.stringify({code:0,data:{bvid,aid:1,cid:2,title:'Fixture '+bvid,duration:10,pages:[{cid:2,duration:10}]}}));}
    return new Response(JSON.stringify({data:{subtitle:{subtitles:[{lan:'zh',subtitle_url:'https://fixture.test/subtitle'}]}}}));
   }
   if(u.hostname==='fixture.test')return new Response(JSON.stringify({body:[{from:0,to:1,content:'Synthetic complete subtitle'}]}));
   return realFetch(url,options);
  };
 });
 await control.evaluate(()=>chrome.storage.local.set({videoLibrarySettings:{enabled:false},customPrompt:'Summarize this synthetic test subtitle.'}));
 const a=await context.newPage(),b=await context.newPage();await a.goto('https://www.bilibili.com/video/BVtestA');await b.goto('https://www.bilibili.com/video/BVtestB');
 await control.evaluate(async()=>{
  window.notes=[];window.ports=[];const tabs=(await chrome.tabs.query({})).filter(t=>t.url?.includes('/video/BVtest'));
  for(const tab of tabs){const p=chrome.runtime.connect({name:'vidsift-video'});ports.push(p);p.onMessage.addListener(m=>notes.push({source:tab.id,...m}));p.postMessage({type:'START_VIDEO_TASK',sourceUrl:tab.url,openerTabId:tab.id,source:{},bgOpen:true,tempChat:false,screenshotSettings:{enabled:false}});}
  await chrome.tabs.remove(tabs.map(t=>t.id));
 });
 await until(()=>sends===1);await new Promise(r=>setTimeout(r,1200));
 assert.equal(sends,1,'second job must wait beyond send acknowledgement and generated title');
 assert.equal(await worker.evaluate(()=>_summaryQueue.length),2);
 assert.equal((await control.evaluate(()=>chrome.tabs.query({}))).filter(t=>t.url?.includes('/video/BVtest')).length,0);
 report.checks.push('both source tabs closed immediately after submission; first summary sends once','second summary remains queued while first has generated title but unfinished response');
 finished.add([...conversations.keys()][0]);await until(()=>sends===2);assert.equal(sends,2);
 for(const cid of conversations.keys())finished.add(cid);
 await until(()=>worker.evaluate(()=>_summaryQueue.length===0));
 const notes=await control.evaluate(()=>window.notes);assert.equal(notes.filter(n=>n.type==='ERROR').length,0,JSON.stringify(notes));assert.equal(notes.filter(n=>n.type==='DONE').length,2);
 report.checks.push('first generation completion releases second job','both summaries finish exactly once with no source tabs');
 report.passed=true;
}catch(error){report.notifications=await control?.evaluate(()=>window.notes).catch(()=>[]);report.targets=await control?.evaluate(()=>chrome.tabs.query({})).then(tabs=>tabs.map(t=>({id:t.id,url:t.url,title:t.title}))).catch(()=>[]);report.queue=await worker?.evaluate(()=>_summaryQueue.map(j=>({id:j.task?.id,status:j.task?.statusText,cancelled:j.task?.cancelled}))).catch(()=>[]);report.error=error.stack;process.exitCode=1;}finally{
 if(context)await context.close();report.contextClosed=true;
 assert(path.resolve(profile).startsWith(path.resolve(art)+path.sep));fs.rmSync(profile,{recursive:true,force:true});report.profileRemoved=!fs.existsSync(profile);
 fs.writeFileSync(path.join(art,'receipt.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}})();
