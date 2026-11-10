// Real DOM regression in an isolated browser; never opens a signed-in profile.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
const content=fs.readFileSync('chatgpt-content.js','utf8');
const helpers=content.slice(content.indexOf('  function readComposerText('),content.indexOf('  let _lastFile'));
const id='11111111-2222-4333-8444-555555555555';
(async()=>{
 const browser=await chromium.launch({headless:true,channel:process.env.VIDSIFT_BROWSER_CHANNEL||'msedge'});
 try{
  const page=await browser.newPage();await page.route('https://chatgpt.com/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><form><div id="prompt-textarea" class="ProseMirror" contenteditable="true"><p>First paragraph</p><p>Second paragraph</p><p>Third paragraph</p></div><button type="button">Send</button></form>'}));await page.goto('https://chatgpt.com/');
  await page.evaluate(({helpers,id})=>{
   window.diagnostics=[];window.chrome={runtime:{sendMessage:async msg=>diagnostics.push(msg)}};
   window.findTextarea=()=>document.querySelector('#prompt-textarea');
   window.fetch=async()=>new Response('data: '+JSON.stringify({conversation_id:id})+'\n\n');
   window.eval(helpers+';window.captureSubmittedConversation=captureSubmittedConversation;window.readComposerText=readComposerText;');
  },{helpers,id});
  const dom=await page.evaluate(()=>({text:findTextarea().textContent,rendered:readComposerText()}));
  assert.equal(dom.text,'First paragraphSecond paragraphThird paragraph');assert.match(dom.rendered,/First paragraph\n+Second paragraph\n+Third paragraph/);
  await page.addScriptTag({path:'chatgpt-library-main.js'});
  const result=await page.evaluate(async()=>{
   const post=window.postMessage.bind(window);window.postMessage=(data,origin)=>data.type==='VIDSIFT_LIBRARY_ARM'?setTimeout(()=>post(data,origin),100):post(data,origin);
   const binding=captureSubmittedConversation(readComposerText(),'fixture'),start=performance.now();
   const ready=await binding.ready,elapsed=performance.now()-start;
   await fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({messages:[{author:{role:'user'},content:{parts:[findTextarea().innerText]}}]})});
   return {ready,elapsed,id:await binding.promise,diagnostics};
  });assert(result.ready);assert(result.elapsed>=80);assert.equal(result.id,id);assert.deepEqual(result.diagnostics.map(x=>x.stage),['library.armed','library.request_match','library.response_id']);
  await page.evaluate(()=>{const area=document.createElement('textarea');area.id='prompt-textarea';area.value='one\ntwo';findTextarea().replaceWith(area);});assert.equal(await page.evaluate(()=>readComposerText()),'one\ntwo');
  // Fresh page without main-world capture: bounded failure still allows Send.
  const absent=await browser.newPage();await absent.route('https://chatgpt.com/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><button>Send</button>'}));await absent.goto('https://chatgpt.com/');
  const unavailable=await absent.evaluate(async helpers=>{
   window.chrome={runtime:{sendMessage:async()=>{}}};window.eval(helpers+';window.captureSubmittedConversation=captureSubmittedConversation;');
   let clicks=0;document.querySelector('button').onclick=()=>clicks++;
   const binding=captureSubmittedConversation('test','missing');const ready=await binding.ready;document.querySelector('button').click();return {ready,clicks,id:await binding.promise};
  },helpers);assert.deepEqual(unavailable,{ready:false,clicks:1,id:null});
  assert.match(content,/await libraryBinding\.ready;[\s\S]*?await clickSend/);
  console.log('PASS real ProseMirror paragraph mismatch reproduced; rendered text capture binds ID; delayed ACK precedes Send; textarea works; absent capture permits Send.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
