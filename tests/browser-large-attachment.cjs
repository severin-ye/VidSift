// Actual Edge extension transport to an isolated, locally fulfilled AI Studio fixture.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{chromium}=require('playwright');
(async()=>{
 const root=process.cwd(),art=path.join(root,'.task-artifacts');fs.mkdirSync(art,{recursive:true});
 const extension=fs.mkdtempSync(path.join(os.tmpdir(),'vidsift-transfer-ext-')),profile=fs.mkdtempSync(path.join(art,'large-attachment-profile-'));
 for(const name of ['attachment-transfer.js','attachment-utils.js','aistudio-transcript.js','aistudio-content.js'])fs.copyFileSync(path.join(root,name),path.join(extension,name));
 fs.writeFileSync(path.join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'VidSift isolated transfer fixture',version:'1.0',permissions:['tabs','scripting'],host_permissions:['https://aistudio.google.com/*'],background:{service_worker:'worker.js'},content_scripts:[{matches:['https://aistudio.google.com/*'],js:['attachment-transfer.js','attachment-utils.js','aistudio-transcript.js','aistudio-content.js'],run_at:'document_idle'}]}));
 fs.writeFileSync(path.join(extension,'worker.js'),"importScripts('attachment-transfer.js');");
 fs.writeFileSync(path.join(extension,'runner.html'),'<script src="attachment-transfer.js"></script>');
 let context;const report={fixture:true,privateProfileUsed:false,networkAIUsed:false,results:[]};
 try{
  context=await chromium.launchPersistentContext(profile,{headless:true,channel:'msedge',args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
  await context.route('https://aistudio.google.com/**',r=>r.fulfill({contentType:'text/html',body:`<main><textarea></textarea><button aria-label="Run" id="run">Run</button></main><script>
  window.counts={drops:0,run:0,hashes:[]};
  document.querySelector('main').addEventListener('drop',async event=>{event.preventDefault();counts.drops++;const file=event.dataTransfer.files[0];const bytes=await file.arrayBuffer();const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');counts.hashes.push({name:file.name,size:bytes.byteLength,hash});const card=document.createElement('ms-audio-chunk');card.textContent=file.name;card.setAttribute('data-state','ready');document.querySelector('main').append(card);});
  document.querySelector('#run').onclick=()=>{counts.run++;document.querySelector('main').append(document.createElement('ms-chat-turn'));};
  </script>`}));
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  report.browser=context.browser().version();
  const runner=await context.newPage();await runner.goto(worker.url().replace('worker.js','runner.html'));
  for(const size of [27,60]){
   const page=await context.newPage();await page.goto('https://aistudio.google.com/fixture-'+size);
   await page.waitForTimeout(300);
   const result=await runner.evaluate(async(size)=>{
    const tab=(await chrome.tabs.query({url:'https://aistudio.google.com/fixture-'+size}))[0];
    const bytes=new Uint8Array(size*1024*1024);bytes.fill(117);
    let data='';for(let i=0;i<bytes.length;i+=32768)data+=String.fromCharCode(...bytes.subarray(i,i+32768));
    const base64=btoa(data);let largest=0,commits=0;
    const api={tabs:{sendMessage(id,msg){largest=Math.max(largest,new TextEncoder().encode(JSON.stringify(msg)).length);if(msg.type==='VIDSIFT_ATTACHMENT_COMMIT')commits++;return chrome.tabs.sendMessage(id,msg,{frameId:0});}}};
    let oldError;try{await chrome.tabs.sendMessage(tab.id,{type:'VIDSIFT_AISTUDIO_PING',audioData:base64,attachments:[{base64}]},{frameId:0});}catch(e){oldError=e.message;}
    const response=await VidSiftAttachmentTransfer.send(api,tab.id,{type:'VIDSIFT_AISTUDIO_UPLOAD_AND_RUN',taskId:'size-'+size,attachments:[{name:'synthetic.m4a',mime:'audio/mp4',base64}],prompt:'synthetic fixture',bgOpen:false});
    return {response,largest,commits,oldError};
   },size);
   await page.waitForFunction(()=>window.counts.run===1,{},{timeout:20000});
   const counts=await page.evaluate(()=>window.counts);
   assert.equal(counts.drops,1);assert.equal(counts.run,1);assert.equal(result.commits,1);assert(result.largest<1024*1024);assert.match(result.oldError,/maximum allowed size/);
   assert.equal(counts.hashes[0].size,size*1024*1024);assert.equal(counts.hashes[0].hash,crypto.createHash('sha256').update(Buffer.alloc(size*1024*1024,117)).digest('hex'));
   report.results.push({binaryMiB:size,...result,counts});await page.close();
  }
  report.passed=true;
 }catch(error){report.error=error.stack;process.exitCode=1;}finally{if(context)await context.close();fs.writeFileSync(path.join(art,'large-attachment-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
})();
