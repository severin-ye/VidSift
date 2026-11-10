const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function harness({diagnosticFailure=false}={}){
 let clock=0,listener,clicks=0;const messages=[],cards=[],turns=[];
 class Textarea{get value(){return this.v||'';}set value(v){this.v=v;}focus(){}dispatchEvent(){}getAttribute(){return null;}closest(){return null;}}
 const textarea=new Textarea();
 const run={textContent:'Run ↵',disabled:false,getAttribute(){return null;},click(){clicks++;turns.push({});}};
 const play={textContent:'play_arrow',disabled:false,getAttribute(){return null;}};
 const tile={textContent:'PRIVATE_FILE.mp4 57,186 tokens',getAttribute(k){return k==='data-state'?'ready':null;},matches(s){return s==='ms-audio-chunk';},querySelector(){return null;},querySelectorAll(){return [play];}};
 const parent={appendChild(el){el.parentNode=this;},dispatchEvent(e){if(e.type==='drop')cards.push(tile);}};
 const document={body:parent,documentElement:parent,createElement(){return {style:{},remove(){},addEventListener(){}};},querySelectorAll(s){if(s==='button')return [run];if(s==='textarea')return [textarea];if(s==='ms-chat-turn')return turns;return cards;},querySelector(s){return s==='main'?parent:null;}};
 const chrome={runtime:{onMessage:{addListener(fn){listener=fn;}},sendMessage(msg){messages.push(msg);if(msg.type==='VIDSIFT_DIAGNOSTIC'&&diagnosticFailure){if(diagnosticFailure==='throw')throw Error('transport failure');return Promise.reject(Error('transport failure'));}return Promise.resolve({ok:true});}}};
 const context={document,chrome,window:{HTMLTextAreaElement:Textarea},console:{log(){},warn(){},error(){}},Event,Date:{now:()=>clock},setTimeout(fn,ms){clock+=ms;queueMicrotask(fn);return 1;},clearTimeout(){},DataTransfer:class{constructor(){this.items={add(){}};}},DragEvent:class{constructor(type){this.type=type;}},VidSiftAttachments:{normalizeMessage(msg){return msg.attachments;},contextualPrompt(prompt){return prompt;},toFile(){return {size:1500};}}};
 vm.createContext(context);
 const source=fs.readFileSync('aistudio-content.js','utf8').replace(/\}\)\(\);\s*$/,'globalThis.api={diagnostic,diagnosticWait,diagnosticDOM,diagnosticError,diagnosticLabels,clickRunButton};})();');
 vm.runInContext(source,context);
 return {api:context.api,messages,cards,tile,run,textarea,get clicks(){return clicks;},tick(ms){clock+=ms;},receive(msg){listener(msg,{},()=>{});},diagnostics(){return messages.filter(m=>m.type==='VIDSIFT_DIAGNOSTIC');},async start(){listener({type:'VIDSIFT_AISTUDIO_UPLOAD_AND_RUN',taskId:'task',prompt:'PRIVATE_PROMPT',attachments:[{name:'PRIVATE_FILE.mp4',mime:'audio/mp4',base64:'PRIVATE_BASE64',content:'PRIVATE_TRANSCRIPT'}]}, {},()=>{});await new Promise(setImmediate);}};
}
test('AI Studio task stages store structural receipts without prompt, filename or file content',async()=>{
 const h=harness();await h.start();const logs=h.diagnostics(),json=JSON.stringify(logs);
 for(const secret of ['PRIVATE_PROMPT','PRIVATE_FILE','PRIVATE_BASE64','PRIVATE_TRANSCRIPT'])assert.equal(json.includes(secret),false);
 for(const stage of ['task_received','input_ready','prompt_filled','attachment_drop','attachment_ready','run_search','run_click','run_accepted','completed'])assert.equal(logs.filter(m=>m.stage==='aistudio.'+stage).length,1,stage);
 assert.equal(h.clicks,1);assert.equal(h.textarea.value,'PRIVATE_PROMPT');assert.ok(logs.every(m=>Number.isFinite(m.details.elapsedMs)));
});
test('cancellation records a fixed cause category and prevents Run',async()=>{
 const h=harness();h.receive({type:'VIDSIFT_CANCEL_UPLOAD',taskId:'task',reason:'原视频页当前作品已改变 PRIVATE_FILE'});
 await assert.rejects(h.api.clickRunButton(100,'task'),/停止|改变/);assert.equal(h.clicks,0);
 const entry=h.diagnostics()[0];assert.equal(entry.stage,'aistudio.cancelled');assert.equal(entry.details.reasonCategory,'source_changed');assert.equal(JSON.stringify(entry).includes('PRIVATE'),false);
});
test('diagnostic rejection or synchronous failure cannot change a successful single submission',async()=>{
 for(const mode of [true,'throw']){const h=harness({diagnosticFailure:mode});await h.start();assert.equal(h.clicks,1);assert.equal(h.messages.find(m=>m.type==='VIDSIFT_TARGET_DONE').ok,true);assert.equal(h.diagnostics().filter(m=>m.stage==='aistudio.run_click').length,1);}
});
test('wait receipts are change-driven or ten-second heartbeats and retain bounded terminal receipt',()=>{
 const h=harness();h.api.diagnostic('task','task_received');for(let i=0;i<50;i++)h.api.diagnosticWait('task','run_wait',{runEnabled:false});assert.equal(h.diagnostics().length,2);
 h.tick(10000);h.api.diagnosticWait('task','run_wait',{runEnabled:false});assert.equal(h.diagnostics().length,3);
 for(let i=0;i<200;i++)h.api.diagnosticWait('task','run_wait',{cardCount:i});h.api.diagnostic('task','failed',{category:'run_not_found'},true);h.api.diagnostic('task','completed',{},true);
 assert.ok(h.diagnostics().length<=100);assert.equal(h.diagnostics().at(-1).stage,'aistudio.failed');
});
test('DOM read errors degrade safely and control labels use a closed vocabulary',()=>{
 const h=harness();h.cards.push(h.tile);const labels=h.api.diagnosticLabels([{textContent:'Play audio file',getAttribute(){return null;}},{textContent:'Run PRIVATE_FILE',getAttribute(){return null;}}],'play');assert.equal(JSON.stringify(labels),'["Play audio file"]');
 h.tile.querySelector=()=>{throw Error('PRIVATE_DOM');};assert.equal(JSON.stringify(h.api.diagnosticDOM({card:h.tile,existing:new Set()})),'{}');
 const error=h.api.diagnosticError(Error('附件 PRIVATE_FILE 上传状态未确认'));assert.equal(error.category,'upload_timeout');assert.equal(JSON.stringify(error).includes('PRIVATE'),false);
});
