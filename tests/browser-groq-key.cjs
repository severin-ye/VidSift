// Actual MV3 pages/windows and workflow, synthetic Native and GPT (no real key/network).
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),art=path.join(root,'.task-artifacts/key-prompt'),id='kggdkncbamdlhhihfkeldbbkppkgihad',sourceUrl='https://www.douyin.com/video/7703625319965543714';
fs.mkdirSync(art,{recursive:true});const profile=fs.mkdtempSync(path.join(art,'profile-'));
const report={isolated:true,syntheticNative:true,syntheticGPT:true,dailyProfileUsed:false,checks:[]};let context;
async function until(read,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(await read())return;await new Promise(r=>setTimeout(r,100));}throw Error('Expected state did not arrive');}
(async()=>{try{
 context=await chromium.launchPersistentContext(profile,{headless:true,viewport:null,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--disable-extensions-except='+root,'--load-extension='+root]});
 await context.route(/^https:\/\/(www\.douyin\.com|console\.groq\.com)\//,r=>r.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><title>Synthetic source</title><main>Isolated fixture</main>'}));
 const control=await context.newPage();await control.goto('chrome-extension://'+id+'/options.html');
 const worker=context.serviceWorkers().find(w=>w.url().includes(id))||await context.waitForEvent('serviceworker');
 if(process.env.VIDSIFT_REAL_NATIVE_CHECK==='1'){
  report.realNative=await worker.evaluate(async()=>{const client=new NativeMediaClient();try{return{diagnostics:(await client.request('diagnostics')).result,groq:await client.groqStatus()};}finally{client.close();}});
  assert.equal(report.realNative.diagnostics.version,'5.5.0');assert.equal(report.realNative.groq.configured,true);report.checks.push('installed real Native 5.5 handshake and existing key presence');
 }
 await worker.evaluate(()=>{
  globalThis._keyTest={configured:false,subtitle:false,stores:0,transcribes:0,sends:0};
  globalThis.NativeMediaClient=class{
   async request(){return{result:{version:'synthetic-5.5.0'}};}
   async groqStatus(){return{configured:_keyTest.configured};}
   async storeGroqKey(value){if(value.includes('invalid'))throw Error('Groq API Key 无效，未保存');_keyTest.stores++;_keyTest.configured=true;return{configured:true};}
   async resolve(){return{platform:'douyin',videoId:'7703625319965543714',title:'Fixture',duration:5,localAudio:{fingerprint:'a'.repeat(64),videoId:'7703625319965543714',duration:5},audioInfo:{},images:[],subtitle:_keyTest.subtitle?{body:[{from:0,to:5,content:'字幕路径'}]}:null};}
   async transcribeGroq(){_keyTest.transcribes++;return{srt:'1\n00:00:00,000 --> 00:00:05,000\n测试音频'};}
   async finishLocalAudio(){} async release(){} close(){} cancel(){}
  };
  _videoWorkflow.deps.sendChatGPT=async()=>{_keyTest.sends++;};
 });
 const source=await context.newPage();await source.goto(sourceUrl);const tabId=await worker.evaluate(async url=>(await chrome.tabs.query({url}))[0].id,sourceUrl);
 const start=()=>worker.evaluate(async({tabId,sourceUrl})=>{try{return await _videoWorkflow.start({openerTabId:tabId,sourceUrl,transcribeService:'groq',screenshotSettings:{enabled:false}});}catch(error){return{ok:false,error:error.message};}},{tabId,sourceUrl});
 const dialog=async()=>{let page;await until(()=>{page=context.pages().find(p=>p.url().startsWith('chrome-extension://'+id+'/groq-key.html#'));return !!page;});await page.locator('#apiKey').waitFor({state:'visible'});await until(()=>page.locator('#apiKey').isEnabled());return page;};
 const running=start();let page=await dialog();assert.equal(await page.locator('#apiKey').getAttribute('type'),'password');
 await page.screenshot({path:path.join(art,'key-dialog.png')});
 report.geometry=await page.evaluate(()=>({height:innerHeight,bottom:document.querySelector('#signup').getBoundingClientRect().bottom}));
 assert(report.geometry.bottom<=report.geometry.height-12,'申请按钮必须完整显示在弹窗内');
 const website=context.waitForEvent('page');await page.locator('#signup').click();const signup=await website;await signup.waitForLoadState();assert.equal(signup.url(),'https://console.groq.com/keys');await signup.close();report.checks.push('real extension popup and official application URL button');
 await page.locator('#apiKey').fill('gsk_invalid_synthetic_1234567890');await page.locator('#save').click();await page.locator('#status').getByText('Groq API Key 无效，未保存').waitFor();assert.equal(await page.locator('#apiKey').inputValue(),'');assert.equal(await worker.evaluate(()=>_keyTest.transcribes),0);
 const dummy='gsk_valid_synthetic_1234567890';await page.locator('#apiKey').fill(dummy);await page.locator('#save').click();assert.equal((await running).ok,true);
 assert.deepEqual(await worker.evaluate(()=>({s:_keyTest.stores,t:_keyTest.transcribes,g:_keyTest.sends})),{s:1,t:1,g:1});
 const storage=await control.evaluate(()=>chrome.storage.local.get(null));assert(!JSON.stringify(storage).includes(dummy));report.checks.push('invalid key stays in same dialog; valid save resumes original task once; no key in browser storage');
 const reused=await start();assert(reused.ok);assert(!context.pages().some(p=>p.url().includes('/groq-key.html')));report.checks.push('configured key skips prompt');
 await worker.evaluate(()=>{_keyTest.configured=false;});const cancelled=start();page=await dialog();await page.locator('#cancel').click();assert.equal((await cancelled).ok,false);assert.equal(await worker.evaluate(()=>_keyTest.sends),2);report.checks.push('cancel stops without transcription or GPT');
 const changed=start();page=await dialog();await source.goto('https://www.douyin.com/video/7705654749961489664');await until(()=>page.isClosed());
 assert.equal((await changed).ok,false);assert.equal(await worker.evaluate(()=>_keyTest.sends),2);report.checks.push('source switch while awaiting key never sends old video');
 await source.goto(sourceUrl);await worker.evaluate(()=>{_keyTest.subtitle=true;});assert((await start()).ok);assert.equal(await worker.evaluate(()=>_keyTest.transcribes),2);report.checks.push('existing subtitles bypass key prompt and audio transcription');
 await control.locator('#groqConfigure').click();page=await dialog();assert.equal(await page.locator('#save').innerText(),'验证并保存');await page.locator('#cancel').click();report.checks.push('settings reuse has correct save-only copy');
 report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}finally{
 if(context)await context.close();report.contextClosed=true;
 assert(path.dirname(path.resolve(profile))===path.resolve(art));fs.rmSync(profile,{recursive:true,force:true});report.profileRemoved=!fs.existsSync(profile);
 fs.writeFileSync(path.join(art,'browser-receipt.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}})();
