// Isolated Edge fixture: no login, live site, extension profile, or user content.
const {chromium}=require('playwright'),fs=require('node:fs'),assert=require('node:assert/strict');
const source=fs.readFileSync('aistudio-content.js','utf8').replace(/\}\)\(\);\s*$/, 'window.api={handleUploadAndRun,clickRunButton,dropAttachment,waitForFileAttached,attachmentState};})();');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
  const page=await browser.newPage();
  await page.setContent('<main><textarea aria-label="Prompt"></textarea><button id="settings">Run settings</button><button id="run" aria-label="Run"><span>arrow_upward</span></button><button aria-label="Edit prompt title and description" id="edit">Edit</button></main>');
  await page.evaluate(()=>{
   window.counts={settings:0,run:0,edit:0};window.messages=[];
   window.chrome={runtime:{onMessage:{addListener(){}},sendMessage:async m=>window.messages.push(m)}};
   const textarea=document.querySelector('textarea');
   Object.defineProperty(textarea,'value',{get(){return Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').get.call(this);},set(){throw Error('framework instance setter');}});
   document.querySelector('#settings').onclick=()=>window.counts.settings++;
   document.querySelector('#run').onclick=()=>{window.counts.run++;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea,'');const turn=document.createElement('ms-chat-turn');document.querySelector('main').append(turn);};
   document.querySelector('#edit').click=()=>{window.counts.edit++;throw Error('synthetic optional title failure');};
  });
  await page.addScriptTag({content:source});
  await page.evaluate(()=>window.api.handleUploadAndRun([],'synthetic fixture prompt',false,false,'synthetic title',null,1,'fixture'));
  assert.deepEqual(await page.evaluate(()=>window.counts),{settings:0,run:1,edit:1});
  assert.equal(await page.evaluate(()=>window.messages.filter(m=>m.state==='done').length),1);
  // An enabled action that ignores a click must not be retried or acknowledged.
  await page.evaluate(()=>{document.querySelector('#run').onclick=()=>window.counts.run++;document.querySelector('textarea')._ignore=true;});
  const uncertain=await page.evaluate(async()=>{try{await window.api.clickRunButton(1000,'uncertain',undefined,600);return false;}catch(e){return /是否接受尚未确认/.test(e.message);}});
  assert.equal(uncertain,true);assert.equal(await page.evaluate(()=>window.counts.run),2);
  const audioPage=await browser.newPage();
  await audioPage.setContent(`<main><textarea></textarea><button id="settings">Run settings</button><button id="run">Run <span>↵</span></button><ms-audio-chunk id="old">audio.m4a <span>10,380 tokens</span><button aria-label="Play audio">▶</button></ms-audio-chunk></main>`);
  await audioPage.evaluate(()=>{
    window.runCount=0;window.dropCount=0;window.taskMessages=[];window.dropMode='ready';
    window.chrome={runtime:{onMessage:{addListener(fn){window.receive=fn;}},sendMessage:async m=>window.taskMessages.push(m)}};
    document.querySelector('main').addEventListener('drop',event=>{
      event.preventDefault();window.dropCount++;
      const wrapper=document.createElement('div');wrapper.className='attachment-container';
      const card=document.createElement('ms-audio-chunk');card.innerHTML='<span>Generated Audio November '+window.dropCount+'</span><span>10,380 tokens</span><button aria-label="Play audio">▶</button><button aria-label="Delete">×</button>';
      if(window.dropMode==='busy')card.insertAdjacentHTML('beforeend','<div role="progressbar"></div>');
      if(window.dropMode==='error')card.insertAdjacentHTML('beforeend','<div role="alert">Upload failed</div>');
      wrapper.append(card);document.querySelector('main').append(wrapper);
    });
    document.querySelector('#run').onclick=()=>{window.runCount++;document.querySelector('main').append(document.createElement('ms-chat-turn'));};
  });
  await audioPage.addScriptTag({content:fs.readFileSync('attachment-utils.js','utf8')});
  await audioPage.addScriptTag({content:fs.readFileSync('aistudio-transcript.js','utf8')});
  await audioPage.addScriptTag({content:source});
  const attachment={name:'audio.m4a',mime:'audio/mp4',base64:Buffer.alloc(1500).toString('base64')};
  await audioPage.evaluate(async attachment=>{
    await window.api.handleUploadAndRun([attachment,{...attachment,name:'second.m4a'}],'synthetic fixture prompt',false,false,null,null,1,'renamed');
  },attachment);
  assert.equal(await audioPage.evaluate(()=>window.runCount),1);
  assert.equal(await audioPage.locator('ms-audio-chunk').count(),3);
  for(const mode of ['busy','error','cancel']){
    const result=await audioPage.evaluate(async({mode,attachment})=>{
      window.dropMode=mode==='cancel'?'busy':mode;
      const receipt=await window.api.dropAttachment(attachment);
      if(mode==='cancel')window.receive({type:'VIDSIFT_CANCEL_UPLOAD',taskId:'cancel-fixture'}, {},()=>{});
      try{await window.api.waitForFileAttached(attachment.name,receipt,mode==='cancel'?'cancel-fixture':mode,600);return 'unexpected-ready';}
      catch(e){return mode==='cancel'?/取消/.test(e.message):mode==='error'?/上传失败/.test(e.message):/状态未确认/.test(e.message);}
    },{mode,attachment});
    assert.equal(result,true);
  }
  assert.equal(await audioPage.evaluate(()=>window.runCount),1);
  // The real message entry point must carry its task identity on progress events.
  await audioPage.evaluate(attachment=>{
    window.dropMode='ready';window.taskMessages=[];
    window.receive({type:'VIDSIFT_AISTUDIO_UPLOAD_AND_RUN',attachments:[attachment],prompt:'synthetic fixture prompt',biliTabId:9,taskId:'identity-fixture'}, {},()=>{});
  },attachment);
  await audioPage.waitForFunction(()=>window.taskMessages.some(message=>message.type==='VIDSIFT_TARGET_DONE'&&message.taskId==='identity-fixture'));
  assert.equal(await audioPage.evaluate(()=>window.taskMessages.filter(message=>message.type==='TRANSCRIBE_TASK_EVENT').every(message=>message.taskId==='identity-fixture')),true);
  assert.equal(await audioPage.evaluate(()=>window.taskMessages.some(message=>message.type==='VIDSIFT_TARGET_DONE'&&message.ok)),true);
  const fullSRT='1\n00:00:00,000 --> 00:00:10,000\n完整测试字幕。';
  await audioPage.evaluate(fullSRT=>{
    window.fullSRT=fullSRT;window.relayMode='complete';
    const old=document.createElement('ms-chat-turn');old.innerHTML='<div class="chat-turn-container model"><ms-text-chunk></ms-text-chunk></div>';
    old.querySelector('ms-text-chunk').textContent=fullSRT+'\n[转写完成 00:00:10]';document.querySelector('main').append(old);
    document.querySelector('#run').onclick=()=>{
      window.runCount++;document.querySelector('#run').disabled=true;
      const stop=document.createElement('button');stop.setAttribute('aria-label','Stop generating');document.querySelector('main').append(stop);
      const user=document.createElement('ms-chat-turn');user.textContent=window.fullSRT+'\n[转写完成 00:00:10]';document.querySelector('main').append(user);
      const model=document.createElement('ms-chat-turn');model.innerHTML='<div class="chat-turn-container model"><ms-thought-chunk><ms-text-chunk>Do not relay these private thoughts</ms-text-chunk></ms-thought-chunk><ms-text-chunk class="answer"><pre><code></code></pre></ms-text-chunk></div>';
      const code=model.querySelector('.answer code');code.textContent='1\n00:00:00,000 --> 00:00:02,000\n残稿';document.querySelector('main').append(model);
      setTimeout(()=>{
        if(window.relayMode==='complete')code.textContent=window.fullSRT+'\n[转写完成 00:00:10]';
        stop.remove();document.querySelector('#run').disabled=false;
      },250);
    };
  },fullSRT);
  for(const mode of ['complete','partial','cancel']){
    await audioPage.evaluate(({mode,attachment})=>{
      window.relayMode=mode;window.taskMessages=[];
      window.receive({type:'VIDSIFT_AISTUDIO_UPLOAD_AND_RUN',attachments:[attachment],prompt:'synthetic fixture prompt',biliTabId:9,taskId:'relay-'+mode,relayToChatGPT:true,duration:10}, {},()=>{});
    },{mode,attachment});
    // Upload typing and streaming must not prematurely unlock the source task.
    await audioPage.waitForTimeout(500);
    assert.equal(await audioPage.evaluate(()=>window.taskMessages.some(message=>message.type==='VIDSIFT_TARGET_DONE')),false);
    assert.equal(await audioPage.evaluate(()=>window.taskMessages.some(message=>message.state==='done')),false);
    if(mode==='cancel')await audioPage.evaluate(()=>window.receive({type:'VIDSIFT_CANCEL_UPLOAD',taskId:'relay-cancel'}, {},()=>{}));
    await audioPage.waitForFunction(()=>window.taskMessages.some(message=>message.type==='VIDSIFT_TARGET_DONE'));
    const receipt=await audioPage.evaluate(()=>window.taskMessages.find(message=>message.type==='VIDSIFT_TARGET_DONE'));
    assert.equal(receipt.ok,mode==='complete');
    if(mode==='complete')assert.equal(receipt.transcript,fullSRT);else assert.equal(receipt.transcript,undefined);
  }
  console.log(JSON.stringify({passed:true,isolatedEdgeFixture:true,realAIStudioVerified:false,checks:['native setter and aria icon run','Run settings excluded','one accepted submission','optional title failure cannot block send','uncertain click never retried','screenshot renamed token-and-player cards without HTML audio','Run return-key shortcut','two distinct uploads with a pre-existing same-name card','nested attachment wrapper deduplicated','loading/error/cancel block submission','async relay waits for complete new model answer and strips thoughts/marker','old model and user SRT do not replace current answer','partial and cancellation never emit transcript','relay never prematurely emits done']}));

 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
