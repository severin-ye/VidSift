// Controlled pages exercise real popup -> service worker -> content script.
// They are fixtures, not evidence of login/network access to the real sites.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),art=path.join(root,'.task-artifacts');fs.mkdirSync(art,{recursive:true});
const id='kggdkncbamdlhhihfkeldbbkppkgihad';let extension=process.env.VIDSIFT_EXTENSION_ROOT||root;
if(process.env.VIDSIFT_FLOW_TARGET_MISSING==='1'){
 if(path.resolve(extension)===root)throw new Error('Target-missing test requires VIDSIFT_EXTENSION_ROOT pointing to a packaged directory');
 const copy=fs.mkdtempSync(path.join(art,'flow-fault-extension-'));fs.cpSync(extension,copy,{recursive:true});
 const m=JSON.parse(fs.readFileSync(path.join(copy,'manifest.json'),'utf8'));m.content_scripts=m.content_scripts.filter(c=>!c.matches.some(x=>x.includes('aistudio.google.com')));fs.writeFileSync(path.join(copy,'manifest.json'),JSON.stringify(m));extension=copy;
}
const profile=fs.mkdtempSync(path.join(art,'flow-profile-'));
const browser=process.env.VIDSIFT_BROWSER_EXE;
const audioFlow=process.env.VIDSIFT_FLOW_AUDIO==='1';
const report={at:new Date().toISOString(),browser,extension,profile,fixtures:true,privateProfileUsed:false,instrumentation:'Stage extension-created target at about:blank so network fixtures attach before target navigation',checks:[],errors:[]};let context;
const target=`<!doctype html><meta charset="utf-8"><title>ChatGPT fixture</title><form>
<div id="prompt-textarea" contenteditable="true"></div><input type="file" aria-label="Attach files"><button id="composer-submit-button" type="button" aria-label="Send">Send</button></form>
<script>window.uploads=[];window.sent=[];document.querySelector('input').addEventListener('change',async e=>{for(const f of e.target.files){window.uploads.push({name:f.name,mime:f.type,text:await f.text()});const tile=document.createElement('div');tile.className='file-tile';tile.setAttribute('role','group');tile.setAttribute('aria-label',f.name);tile.textContent=f.name;document.querySelector('form').append(tile);}});document.querySelector('button').addEventListener('click',()=>{window.sent.push(document.querySelector('#prompt-textarea').textContent);document.querySelector('#prompt-textarea').textContent='';});</script>`;
const syntheticTranscript='1\n00:00:00,000 --> 00:00:20,000\nBili complete fixture\n\n[转写完成 00:00:20]';
const generationDelay=process.env.VIDSIFT_FLOW_SLOW_RELAY==='1'?40000:0;
const audioTarget=`<!doctype html><meta charset="utf-8"><main><textarea></textarea><button type="button">Run</button></main><script>
window.uploads=[];window.sent=[];
document.querySelector('main').addEventListener('drop',e=>{e.preventDefault();for(const f of e.dataTransfer.files){window.uploads.push({name:f.name,mime:f.type,size:f.size});const card=document.createElement('ms-audio-chunk');card.textContent=f.name;card.setAttribute('data-state','ready');document.querySelector('main').append(card);}});
document.querySelector('button').addEventListener('click',()=>{window.sent.push(document.querySelector('textarea').value);document.querySelector('textarea').value='';const userTurn=document.createElement('ms-chat-turn');userTurn.innerHTML='<div class="chat-turn-container user">audio prompt fixture</div>';document.querySelector('main').append(userTurn);setTimeout(()=>{const turn=document.createElement('ms-chat-turn');turn.innerHTML='<div class="chat-turn-container model"><ms-text-chunk style="white-space:pre-wrap"></ms-text-chunk></div>';turn.querySelector('ms-text-chunk').textContent=${JSON.stringify(syntheticTranscript)};document.querySelector('main').append(turn);},${generationDelay});});</script>`;
(async()=>{
 context=await chromium.launchPersistentContext(profile,{headless:true,...(browser?{executablePath:browser}:{channel:'msedge'}),args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 report.version=context.browser()?.version();
 await context.route('https://www.bilibili.com/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><title>VidSift受控视频</title><video></video>'}));
 await context.route('https://api.bilibili.com/**',r=>{
  const u=r.request().url();const data=u.includes('/view?')?{code:0,data:{aid:123,cid:456,title:'受控视频',duration:20,pages:[{cid:456,duration:20}]}}:u.includes('/playurl?')?{code:0,data:{dash:{audio:[{bandwidth:1,baseUrl:'https://fixture.bilivideo.com/audio.m4a',backupUrl:[]}]}}}:{code:0,data:{subtitle:{subtitles:audioFlow?[]:[{lan:'zh-CN',subtitle_url:'https://aisubtitle.hdslb.com/fixture.json'}]}}};
  return r.fulfill({contentType:'application/json',body:JSON.stringify(data)});
 });
 await context.route('https://aisubtitle.hdslb.com/**',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({body:[{from:0.1,to:2.25,content:'Edge字幕发送回归验证'}]})}));
 await context.route('https://chatgpt.com/**',r=>r.fulfill({contentType:'text/html',body:process.env.VIDSIFT_FLOW_GATE==='1'?'<title>Just a moment...</title><p>Verify you are human</p>':target}));
 await context.route('https://aistudio.google.com/**',r=>r.fulfill({contentType:'text/html',body:audioTarget}));
 await context.route('https://fixture.bilivideo.com/**',r=>r.fulfill({contentType:'audio/mp4',headers:{'access-control-allow-origin':'*'},body:fs.readFileSync(path.join(root,'test/sample.m4a'))}));
 const source=await context.newPage();await source.goto(audioFlow?'https://www.bilibili.com/':'https://www.bilibili.com/video/BV1uLpn6AEtS/');
 if(audioFlow)await source.evaluate(()=>history.pushState({},'','/video/BV1uLpn6AEtS/'));
 let worker=context.serviceWorkers().find(w=>w.url().includes(id));if(!worker)worker=await context.waitForEvent('serviceworker');
 await worker.evaluate(()=>{globalThis.__flowInjections=[];const execute=chrome.scripting.executeScript.bind(chrome.scripting);chrome.scripting.executeScript=async options=>{globalThis.__flowInjections.push({world:options.world,files:options.files});return execute(options);};const create=chrome.tabs.create.bind(chrome.tabs);chrome.tabs.create=async options=>{globalThis.__flowTargetURL=options.url;return create({...options,url:'about:blank'});};});
 const popup=await context.newPage();await source.bringToFront();await popup.goto(`chrome-extension://${id}/popup.html`);
 popup.on('pageerror',e=>report.errors.push(e.message));
 await popup.waitForFunction(()=>!document.querySelector('#runBtn').disabled,{},{timeout:20000});
 report.initialStatus=await popup.locator('#statusText').textContent();
 const newPage=context.waitForEvent('page',{predicate:p=>p!==popup&&p!==source,timeout:15000});
 await popup.locator('#runBtn').click();
 const targetPage=await newPage;
 targetPage.on('pageerror',e=>report.errors.push(e.stack));
 targetPage.on('console',m=>{if(m.text().startsWith('[ext]'))console.log(m.text());});
 const targetURL=await worker.evaluate(()=>globalThis.__flowTargetURL);assert.match(targetURL,audioFlow?/^https:\/\/aistudio.google.com\//:/^https:\/\/chatgpt.com\//);
 await targetPage.goto(targetURL);report.targetURL=targetPage.url();
 report.targetState=await targetPage.evaluate(()=>({ready:document.readyState,form:!!document.querySelector('form'),fixtureScript:typeof window.sent,html:document.documentElement.outerHTML.slice(0,1800)}));
 if(process.env.VIDSIFT_FLOW_GATE==='1'){
  await popup.waitForFunction(()=>document.querySelector('#errorBox').textContent.includes('访问验证'),{},{timeout:12000});
  assert.equal(await worker.evaluate(()=>_legacyGuard.tasks.size),0);
  report.checks.push('access verification blocks upload/send and surfaces actionable message','blocked target releases source task');report.passed=true;return;
 }
 await targetPage.waitForFunction(()=>window.sent?.length===1,{},{timeout:20000});
 const result=await targetPage.evaluate(()=>({uploads:window.uploads,sent:window.sent}));
 assert.equal(result.uploads.length,1);assert.ok(result.sent[0].length>0);
 if(audioFlow){assert.equal(result.uploads[0].mime,'audio/mp4');assert.equal(result.uploads[0].size,fs.statSync(path.join(root,'test/sample.m4a')).size);report.injections=await worker.evaluate(()=>globalThis.__flowInjections);assert.deepEqual(report.injections.map(i=>i.world),process.env.VIDSIFT_FLOW_TARGET_MISSING==='1'?['MAIN','ISOLATED','ISOLATED']:['MAIN','ISOLATED']);report.checks.push('missing receiver on existing Bili page repaired without reload','one complete audio attachment uploaded before one AI Studio Run');if(process.env.VIDSIFT_FLOW_TARGET_MISSING==='1')report.checks.push('missing AI Studio receiver repaired using packaged files');}
 else{assert.match(result.uploads[0].name,/\.srt$/);assert.match(result.uploads[0].text,/00:00:00,100 --> 00:00:02,250/);assert.match(result.uploads[0].text,/Edge字幕发送回归验证/);}
 if(audioFlow){
  if(generationDelay)await popup.close();
  const forwarded=await context.waitForEvent('page',{timeout:60000});await forwarded.goto(await worker.evaluate(()=>globalThis.__flowTargetURL));await forwarded.waitForFunction(()=>window.sent?.length===1,{},{timeout:20000});
  const relay=await forwarded.evaluate(()=>({uploads:window.uploads,sent:window.sent}));assert.equal(relay.uploads.length,1);assert.match(relay.uploads[0].text,/Bili complete fixture/);assert.equal(relay.sent.length,1);report.checks.push('legacy Bili audio waits for full transcript then uploads SRT to GPT once');if(generationDelay)report.checks.push('popup closed through a 40-second generation; GPT handoff survived');
 }
 if(popup.isClosed()){const reopened=await context.newPage();await source.bringToFront();await reopened.goto(`chrome-extension://${id}/popup.html`);await reopened.waitForFunction(()=>document.querySelector('#statusText').textContent.includes('ChatGPT'));report.checks.push('reopened popup shows retained terminal result');await reopened.close();report.passed=true;return;}
 await popup.waitForTimeout(500);
 const error=await popup.locator('#errorBox').textContent();assert.equal(error,'');assert.deepEqual(report.errors,[]);
 if(!audioFlow)report.checks.push('popup extracts timestamped SRT via platform APIs','content script uploads exactly one SRT before one send');report.checks.push('real extension background opens target with valid tab identity','no popup or target JavaScript error');report.passed=true;
})().catch(e=>{report.passed=false;report.error=e.stack;process.exitCode=1;}).finally(async()=>{
 if(context)await context.close();const name=audioFlow?'edge-audio-flow-results.json':browser&&/msedge/i.test(browser)?'edge-flow-results.json':'chromium-flow-results.json';fs.writeFileSync(path.join(art,name),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
});
