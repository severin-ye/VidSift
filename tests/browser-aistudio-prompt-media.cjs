const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require('playwright');
const source=fs.readFileSync('aistudio-content.js','utf8').replace(/\}\)\(\);\s*$/,'globalThis.api={attachmentState,getAttachmentCards,diagnosticDOM,dropAttachment,waitForFileAttached,clickRunButton,handleUploadAndRun};})();');
// Captured component structure: ms-prompt-media > data-test-id=prompt-media-container,
// ms-prompt-video preview, scoped ms-token-status token-count and Remove media.
const modern=(name='Generated Audio',extra='',tokens='62,574 tokens',remove='false')=>`<ms-prompt-media><div data-test-id="prompt-media-container" class="prompt-media-item-container"><div class="preview-container"><ms-prompt-video></ms-prompt-video></div><div class="content-container"><span class="name">${name}</span><div class="status-and-tokens"><ms-token-status><span data-test-id="token-count">${tokens}</span></ms-token-status></div></div><div class="actions-container"><button aria-label="Edit video options" aria-disabled="false">settings</button><button aria-label="Remove media" aria-disabled="${remove}">close</button></div>${extra}</div></ms-prompt-media>`;
test('current AI Studio prompt-media DOM confirms only the unique processed drop and submits once',async t=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 async function pageWith(html=''){
  const page=await browser.newPage();await page.setContent('<main><textarea></textarea><button id="run">Run keyboard_return</button>'+html+'</main>');
  await page.evaluate(()=>{window.clicks=0;window.drops=0;window.chrome={runtime:{onMessage:{addListener(){}},sendMessage:async()=>({ok:true})}};document.querySelector('#run').onclick=()=>{window.clicks++;document.querySelector('main').append(document.createElement('ms-chat-turn'));};});
  await page.addScriptTag({content:fs.readFileSync('attachment-utils.js','utf8')});await page.addScriptTag({content:source});return page;
 }
 try{
  await t.test('current nested wrapper counts once with no legacy cards and no play button',async()=>{
   const page=await pageWith(modern());
   const result=await page.evaluate(()=>{const receipt={existing:new Set(),mime:'audio/mp4'};return {legacy:document.querySelectorAll('ms-file-chunk,ms-audio-chunk,ms-image-chunk').length,state:api.attachmentState('audio.m4a',receipt).state,summary:api.diagnosticDOM(receipt)};});
   assert.equal(result.legacy,0);assert.equal(result.state,'confirmed');assert.equal(result.summary.cardCount,1);assert.equal(result.summary.hasTokenCount,true);assert.equal(result.summary.playEnabled,false);await page.close();
  });
  await t.test('busy, failed, zero-token or disabled-remove media never becomes ready',async()=>{
   for(const [extra,tokens,disabled,state] of [['<div role="progressbar"></div>','62,574 tokens','false','pending'],['<div role="alert">Upload failed</div>','62,574 tokens','false','failed'],['','0 tokens','false','pending'],['','62,574 tokens','true','pending']]){
    const page=await pageWith(modern('Generated Audio',extra,tokens,disabled));const result=await page.evaluate(()=>api.attachmentState('audio.m4a',{existing:new Set(),mime:'audio/mp4'}).state);assert.equal(result,state);assert.equal(await page.evaluate(()=>clicks),0);await page.close();
   }
  });
  await t.test('pre-existing, unknown token-only and multiple new media do not acknowledge a drop',async()=>{
   for(const [html,preexisting] of [[modern(),true],['<div class="file-container">62,574 tokens<button aria-label="Remove media">close</button></div>',false],[modern()+modern('Another generated media'),false]]){
    const page=await pageWith(html);const result=await page.evaluate(preexisting=>{const receipt={existing:new Set(preexisting?api.getAttachmentCards():[]),mime:'audio/mp4'};return api.attachmentState('audio.m4a',receipt).state;},preexisting);assert.equal(result,'pending');await page.close();
   }
  });
  await t.test('pending renderer replacement is rebound only when uniquely compatible',async()=>{
   for(const mode of ['compatible','wrong-mime','multiple','confirmed']){
    const page=await pageWith(modern('Generated Audio',mode==='confirmed'?'':'<div role="progressbar"></div>'));
    const result=await page.evaluate(({mode,replacement})=>{const receipt={existing:new Set(),mime:mode==='wrong-mime'?'image/jpeg':'audio/mp4'};api.attachmentState('audio.m4a',receipt);const old=receipt.card;document.querySelector('ms-prompt-media').remove();document.querySelector('main').insertAdjacentHTML('beforeend',replacement+(mode==='multiple'?replacement:''));return {state:api.attachmentState('audio.m4a',receipt).state,rebound:receipt.card!==old};},{mode,replacement:modern()});
    assert.equal(result.state,mode==='compatible'?'confirmed':'pending');assert.equal(result.rebound,mode==='compatible');await page.close();
   }
  });
  await t.test('full upload flow drops exactly once and clicks actual Run label exactly once',async()=>{
   const page=await pageWith();await page.evaluate(html=>{document.querySelector('main').addEventListener('drop',e=>{e.preventDefault();window.drops++;document.querySelector('main').insertAdjacentHTML('beforeend',html);});},modern());
   await page.evaluate(async()=>api.handleUploadAndRun([{name:'audio.m4a',mime:'audio/mp4',base64:btoa('x'.repeat(1500))}],'fixture prompt',false,false,null,null,null,'fixture'));
   assert.deepEqual(await page.evaluate(()=>({drops,clicks,cards:api.getAttachmentCards().length})),{drops:1,clicks:1,cards:1});await page.close();
  });
 }finally{await browser.close();}
});
