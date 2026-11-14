// Real MV3 extension and persistent storage, isolated browser, synthetic ChatGPT API.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),cp=require('node:child_process');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),art=path.join(root,'.task-artifacts','visible-errors-browser');fs.mkdirSync(art,{recursive:true});
const profile=fs.mkdtempSync(path.join(art,'profile-')),id='kggdkncbamdlhhihfkeldbbkppkgihad',cid='11111111-2222-4333-8444-555555555555';
const report={profile,syntheticAPI:true,dailyProfileUsed:false,checks:[]};let context,old=false;
async function until(read,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(await read())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out waiting for persisted state');}
fs.writeFileSync(path.join(art,'resource.json'),JSON.stringify({owner:'01a1c5ca',profile,purpose:'isolated extension errors/capture acceptance',cleanup:'close browser, read CLI, remove only this profile'},null,2));
const html=`<!doctype html><meta charset="utf-8"><title>Fixture</title><main><form><div id="prompt-textarea" contenteditable="true"></div><input type="file" multiple><button type="button" data-testid="send-button">Send</button></form></main><script>
 window.sent=0;window.files=[];document.querySelector('input').onchange=async e=>{for(const f of e.target.files){if(new TextEncoder().encode(f.name).length>120)throw Error('filename exceeds UTF-8 limit');window.files.push({name:f.name,content:await f.text()});const d=document.createElement('div');d.className='file-tile';d.setAttribute('role','group');d.setAttribute('aria-label',f.name);d.textContent=f.name;document.querySelector('form').append(d);}history.replaceState({},'','/c/${cid}');};
 document.querySelector('button').onclick=async()=>{const text=document.querySelector('#prompt-textarea').innerText;window.sent++;await fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({conversation_id:'${cid}',messages:[{id:'user-message-one',author:{role:'user'},content:{parts:[text]}}]})});document.querySelector('#prompt-textarea').textContent='';};</script>`;
(async()=>{try{
 context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.VIDSIFT_BROWSER_EXE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--disable-extensions-except='+root,'--load-extension='+root]});
 let outgoing;
 await context.route('https://chatgpt.com/**',async route=>{const u=new URL(route.request().url());
  if(u.pathname==='/api/auth/session')return route.fulfill({json:{accessToken:'synthetic'}});
  if(u.pathname==='/backend-api/f/conversation'){outgoing=route.request().postDataJSON();return route.fulfill({contentType:'text/event-stream',body:'data: '+JSON.stringify({conversation_id:cid})+'\n\n'});}
  if(u.pathname==='/backend-api/conversation/'+cid)return route.fulfill({json:{conversation_id:cid,title:'generated title',create_time:Date.now()/1000-(old?86400:0),mapping:{first:{message:outgoing?.messages?.[0]}}}});
  return route.fulfill({contentType:'text/html',body:html});
 });
 const control=await context.newPage();await control.goto('chrome-extension://'+id+'/options.html');
 const worker=context.serviceWorkers().find(w=>w.url().includes(id))||await context.waitForEvent('serviceworker');
 await control.evaluate(()=>chrome.storage.local.set({customPrompt:'acceptance prompt'}));
 for(const which of ['fresh','old']){
  old=which==='old';outgoing=null;const page=await context.newPage();await page.goto('https://chatgpt.com/');await page.locator('#prompt-textarea').waitFor();
  const target=await control.evaluate(async()=>{const tabs=await chrome.tabs.query({});return tabs.find(t=>t.url==='https://chatgpt.com/');});assert(target);
  const taskId='capture-'+which;
  await worker.evaluate(async ({taskId,tabId})=>{await _diagnostics.begin(taskId,{sourceTabId:tabId});await _diagnostics.record(taskId,'target.registered',{targetTabId:tabId});await _videoLibrary.register({taskId,tabId,source:{url:'https://www.bilibili.com/video/BV1LtWT66EMR',title:'acceptance'},tempChat:false});}, {taskId,tabId:target.id});
  await control.evaluate(async ({taskId,tabId})=>chrome.tabs.sendMessage(tabId,{type:'VIDSIFT_CHATGPT_PREPARE_PROMPT',taskId,libraryEligible:true,videoTitle:'acceptance',prompt:'acceptance prompt',file:{name:'7698527283597905202_'+'荣格红书精读'.repeat(23)+'.srt',content:'1\n00:00:00,000 --> 00:00:01,000\nfixture'},bgOpen:true,tempChat:false}),{taskId,tabId:target.id});
  await page.waitForFunction(()=>window.sent===1,{},{timeout:20000});
  const files=await page.evaluate(()=>window.files);assert.equal(files.length,1);assert(Buffer.byteLength(files[0].name,'utf8')<=120);assert(files[0].name.endsWith('.srt'));assert.equal(files[0].content,'1\n00:00:00,000 --> 00:00:01,000\nfixture');report.checks.push(which+': long Chinese filename fits UTF-8 budget; complete subtitle sent once');
  if(!old){await until(()=>control.evaluate(async()=>{const s=(await chrome.storage.local.get('videoLibraryState')).videoLibraryState;return s?.pending?.some(r=>r.chatgptUrl==='https://chatgpt.com/c/11111111-2222-4333-8444-555555555555');}));report.checks.push('preallocated ID verified from exact first user message and queued without URL guessing');}
  else{await until(()=>control.evaluate(async()=>{const s=(await chrome.storage.local.get('vidsiftTaskDiagnostics')).vidsiftTaskDiagnostics;const library=(await chrome.storage.local.get('videoLibraryState')).videoLibraryState;return s.tasks.find(t=>t.taskId==='capture-old')?.events.some(e=>e.stage==='library.ownership_rejected'&&e.details.reason==='conversation_predates_task')&&library?.tasks.some(t=>t.taskId==='capture-old'&&t.captureStatus==='unconfirmed');}));const s=await control.evaluate(()=>chrome.storage.local.get('videoLibraryState'));report.oldState=s;assert(s.videoLibraryState.tasks.some(t=>t.taskId==='capture-old'&&t.captureStatus==='unconfirmed'),JSON.stringify(s));report.checks.push('old conversation rejected; submitted pending task preserved without another send');}
  await control.evaluate(async tabId=>chrome.tabs.sendMessage(tabId,{type:'EXT_ERROR',text:'日志验收错误：HTTP 503 token=never-export-this https://example.test/?secret=private'}),target.id);
  await page.getByText('日志验收错误：HTTP 503',{exact:false}).waitFor();
  await until(()=>control.evaluate(async()=>{const s=(await chrome.storage.local.get('vidsiftErrorLog')).vidsiftErrorLog;return s?.errors.some(e=>e.message.includes('日志验收错误'));}));
  assert.equal(await page.evaluate(()=>window.sent),1);await page.close();
 }
 const settings=await control.evaluate(()=>chrome.storage.local.get('customPrompt'));assert.equal(settings.customPrompt,'acceptance prompt');
 await context.close();context=null;
 const cli=cp.spawnSync('py',['-3','scripts/diagnostics.py','--store',path.join(profile,'Default','Local Extension Settings',id),'--json'],{cwd:root,encoding:'utf8'});assert.equal(cli.status,0,cli.stderr||cli.stdout);const output=JSON.parse(cli.stdout);const errors=output.profiles[0].errors;assert(errors.some(e=>e.message.includes('日志验收错误')));assert(!cli.stdout.includes('never-export-this'));assert(!cli.stdout.includes('acceptance prompt'));report.checks.push('visible error persisted and CLI read it after browser exit with secrets and custom prompt excluded');
 report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}finally{
 if(context)await context.close();report.contextClosed=true;
 assert(path.resolve(profile).startsWith(path.resolve(art)+path.sep));fs.rmSync(profile,{recursive:true,force:true});report.profileRemoved=!fs.existsSync(profile);
 fs.writeFileSync(path.join(art,'receipt.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}})();
