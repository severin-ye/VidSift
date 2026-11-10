// Real isolated MV3/DOM, synthetic ChatGPT API; no daily profile or media upload.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),art=path.join(root,'.task-artifacts','video-title-browser');
fs.mkdirSync(art,{recursive:true});
const profile=fs.mkdtempSync(path.join(art,'profile-')),id='kggdkncbamdlhhihfkeldbbkppkgihad';
const report={syntheticAPI:true,dailyProfileUsed:false,checks:[],profile};
fs.writeFileSync(path.join(art,'resource.json'),JSON.stringify({owner:'01a1c59f-video-title',profile,purpose:'isolated title/rename and raw library compatibility',cleanup:'close context then remove only registered profile'},null,2));
let context;
async function until(read,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await read())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out waiting for title acceptance');}
const html=`<!doctype html><meta charset="utf-8"><title>Fixture</title><main><form><div id="prompt-textarea" contenteditable="true"></div><input type="file" multiple><button type="button" data-testid="send-button">Send</button></form></main><script>
window.sent=0;document.querySelector('input').onchange=e=>{for(const f of e.target.files){const x=document.createElement('div');x.className='file-tile';x.setAttribute('role','group');x.setAttribute('aria-label',f.name);x.textContent=f.name;document.querySelector('form').append(x);}history.replaceState({},'','/c/FIXTURE_CID');};
document.querySelector('button').onclick=async()=>{window.sent++;await fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({conversation_id:'FIXTURE_CID',messages:[{id:'fixture-user',author:{role:'user'},content:{parts:[document.querySelector('#prompt-textarea').innerText]}}]})});document.querySelector('#prompt-textarea').textContent='';};</script>`;
(async()=>{try{
 context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.VIDSIFT_BROWSER_EXE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--disable-extensions-except='+root,'--load-extension='+root]});
 const control=await context.newPage();await control.goto('chrome-extension://'+id+'/options.html');
 const worker=context.serviceWorkers().find(w=>w.url().includes(id))||await context.waitForEvent('serviceworker');
 await control.evaluate(()=>chrome.storage.local.set({customPrompt:'isolated title acceptance'}));
 const cases=[
  {platform:'douyin',url:'https://www.douyin.com/video/7700722107428244763',raw:'【抖音精选】42分钟看懂冲绳岛战役始末。太平洋战场赢来终章。 #地图推演 #第二次世界大战 @抖音人文',expected:'【抖音】42分钟看懂冲绳岛战役始末。太平洋战场赢来终章。'},
  {platform:'bilibili',url:'https://www.bilibili.com/video/BV1LtWT66EMR',raw:'C# 入门：理解 #include 与 a@b.com',expected:'【B站】C# 入门：理解 #include 与 a@b.com',legacy:true},
  {platform:'youtube',url:'https://www.youtube.com/watch?v=nAEcMiFmqgg',raw:'【YouTube】字幕与原题 #学习 @作者',expected:'【YouTube】字幕与原题'},
  {platform:'douyin',url:'https://www.douyin.com/video/7700722107428244763',raw:'临时会话 #标签',temp:true}
 ];
 for(let i=0;i<cases.length;i++){
  const c=cases[i],cid='11111111-2222-4333-8444-'+String(i+1).padStart(12,'0'),patches=[];
  let outgoing,title='generated title';
  const page=await context.newPage();
  const events=[];page.on('pageerror',e=>events.push(e.message));page.on('console',m=>{if(m.type()==='error')events.push(m.text());});
  await page.route('https://chatgpt.com/**',async route=>{const req=route.request(),u=new URL(req.url());
   if(u.pathname==='/api/auth/session')return route.fulfill({json:{accessToken:'synthetic'}});
   if(u.pathname==='/backend-api/f/conversation'){outgoing=req.postDataJSON();return route.fulfill({contentType:'text/event-stream',body:'data: '+JSON.stringify({conversation_id:cid})+'\n\n'});}
   if(u.pathname==='/backend-api/conversation/'+cid){if(req.method()==='PATCH'){title=req.postDataJSON().title;patches.push(title);}return route.fulfill({json:{conversation_id:cid,title,create_time:Date.now()/1000,mapping:{first:{message:outgoing?.messages?.[0]}}}});}
   return route.fulfill({contentType:'text/html',body:html.replaceAll('FIXTURE_CID',cid)});
  });
  await page.goto('https://chatgpt.com/');await page.locator('#prompt-textarea').waitFor();
  const target=await control.evaluate(async()=>{const tabs=await chrome.tabs.query({});return tabs.find(t=>t.url==='https://chatgpt.com/');});assert(target);
  const taskId='title-'+i,source={platform:c.platform,url:c.url,title:c.raw,videoId:c.legacy?'BV1LtWT66EMR':'sample-'+i};
  if(!c.temp)await worker.evaluate(async({taskId,tabId,source})=>_videoLibrary.register({taskId,tabId,source,tempChat:false}),{taskId,tabId:target.id,source});
  const message={type:'VIDSIFT_CHATGPT_PREPARE_PROMPT',taskId,libraryEligible:!c.temp,videoTitle:c.raw,prompt:'isolated title acceptance',file:{name:'sample.srt',content:'1\n00:00:00,000 --> 00:00:01,000\nfixture'},bgOpen:true,tempChat:!!c.temp,bvid:source.videoId};
  if(!c.legacy)message.source=source;
  await control.evaluate(async({tabId,message})=>chrome.tabs.sendMessage(tabId,message),{tabId:target.id,message});
  try{await page.waitForFunction(()=>window.sent===1,{},{timeout:20000});}catch(e){report.failedCase={i,events,state:await page.evaluate(()=>({title:document.title,text:document.body.innerText,sent:window.sent}))};throw e;}
  if(!c.temp){
   await until(()=>patches.length>0);assert.equal(patches[0],c.expected);await until(async()=>(await page.title())===c.expected);
   const state=await control.evaluate(()=>chrome.storage.local.get('videoLibraryState'));
   const record=state.videoLibraryState.pending.find(r=>r.id===cid);assert(record);assert.equal(record.title,c.raw);
   report.checks.push({platform:c.platform,legacy:!!c.legacy,title,rawLibraryTitlePreserved:true});
  }else{await page.waitForTimeout(2000);assert.equal(patches.length,0);assert.equal(await page.title(),'Fixture');report.checks.push({temporaryChat:true,noRename:true});}
  assert.equal(await page.evaluate(()=>window.sent),1);await page.close();
 }
 assert.equal((await control.evaluate(()=>chrome.storage.local.get('customPrompt'))).customPrompt,'isolated title acceptance');
 report.passed=true;
}catch(e){report.error=e.stack;process.exitCode=1;}finally{
 if(context)await context.close();report.contextClosed=true;
 assert(path.resolve(profile).startsWith(path.resolve(art)+path.sep));fs.rmSync(profile,{recursive:true,force:true});report.profileRemoved=!fs.existsSync(profile);
 fs.writeFileSync(path.join(art,'receipt.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}})();
