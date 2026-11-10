const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
  let clock = 0, sends = 0, listener;
  const state = {buttons:[], turns:[], cards:[], dialog:null};
  class Textarea { constructor() { this._value='prompt'; } get value(){return this._value;} set value(value){this._value=value;} focus(){} dispatchEvent(){} getAttribute(){return null;} closest(){return null;} }
  const textarea = new Textarea();
  const document = {
    querySelectorAll(selector) {
      if(selector==='button')return state.buttons;
      if(selector==='textarea')return [textarea];
      if(selector==='ms-chat-turn')return state.turns;
      return state.cards;
    },
    querySelector(selector){return selector.includes('dialog')?state.dialog:null;}
  };
  const context = {document, window:{HTMLTextAreaElement:Textarea}, console:{log(){},warn(){},error(){}}, Event,
    Date:{now:()=>clock}, setTimeout(fn,ms){clock+=ms;queueMicrotask(()=>{state.onTick?.();fn();});}, clearTimeout(){},
    chrome:{runtime:{onMessage:{addListener(fn){listener=fn;}}}}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('aistudio-transcript.js','utf8'),context);
  const source=fs.readFileSync('aistudio-content.js','utf8').replace(/\}\)\(\);\s*$/, 'globalThis.api={findRunButton,attachmentState,typePrompt,clickRunButton,getPromptTextarea,waitForTranscript};})();');
  vm.runInContext(source,context);
  function button(label, options={}) {
    return {...options,textContent:options.text??label, disabled:options.disabled??false,
      getAttribute(key){return key==='aria-label'&&options.aria?label:null;},
      click(){sends++;options.click?.();}};
  }
  return {api:context.api,state,textarea,button,get sends(){return sends;},cancel(){listener({type:'VIDSIFT_CANCEL_UPLOAD',taskId:'task'}, {},()=>{});}};
}

test('Run settings does not intercept the actual aria-labeled icon Run button',()=>{
  const h=harness(),settings=h.button('Run settings'),run=h.button('Run',{aria:true,text:'arrow_upward'});
  h.state.buttons=[settings,run];assert.equal(h.api.findRunButton(),run);
});

test('localized run action is supported but ambiguous controls are rejected',()=>{
  const h=harness(),run=h.button('运行',{aria:true,text:'play_arrow'});
  h.state.buttons=[run];assert.equal(h.api.findRunButton(),run);
  h.state.buttons.push(h.button('Run'));assert.equal(h.api.findRunButton(),null);
});

test('native textarea setter bypasses framework-owned instance value setter',async()=>{
  const h=harness();let events=0;
  Object.defineProperty(h.textarea,'value',{get(){return this._value;},set(){throw Error('instance setter must not be used');}});
  h.textarea.dispatchEvent=()=>events++;
  await h.api.typePrompt('synthetic prompt');assert.equal(h.textarea.value,'synthetic prompt');assert.equal(events,2);
});

test('loaded media confirms upload independently of the disabled run control',()=>{
  const h=harness();h.state.buttons=[h.button('Run',{disabled:true})];
  const image={complete:true,naturalWidth:200};
  const card={textContent:'sample.jpg',getAttribute(){return null;},querySelector(s){return s==='img'?image:null;}};
  h.state.cards=[card];assert.equal(h.api.attachmentState('sample.jpg').state,'confirmed');
  card.querySelector=s=>s.includes('progressbar')?{}:s==='img'?image:null;
  assert.equal(h.api.attachmentState('sample.jpg').state,'pending');
});

test('single click waits for observable acceptance and does not retry an ignored click',async()=>{
  const h=harness();h.state.buttons=[h.button('Run')];
  await assert.rejects(h.api.clickRunButton(900,'task',undefined,600),/是否接受尚未确认/);
  assert.equal(h.sends,1);
});

test('new response turn confirms a single submission',async()=>{
  const h=harness();h.state.buttons=[h.button('Run',{click(){h.state.turns.push({});}})];
  await h.api.clickRunButton(900,'task',undefined,600);assert.equal(h.sends,1);
});

test('composer clearing alone is not a submission receipt',async()=>{
  const h=harness();h.state.buttons=[h.button('Run',{click(){h.textarea.value='';}})];
  await assert.rejects(h.api.clickRunButton(900,'task',undefined,600),/是否接受尚未确认/);assert.equal(h.sends,1);
});

test('only a newly visible stop control confirms generation',async()=>{
  const h=harness();h.state.buttons=[h.button('Run',{click(){h.state.buttons.push(h.button('Stop generating'));}})];
  await h.api.clickRunButton(900,'task',undefined,600);assert.equal(h.sends,1);
});

test('existing stop button alone cannot acknowledge an ignored new submission',async()=>{
  const h=harness();h.state.buttons=[h.button('Run'),h.button('Stop generating')];
  await assert.rejects(h.api.clickRunButton(900,'task',undefined,600),/是否接受尚未确认/);assert.equal(h.sends,1);
});

test('cancel, a changed prior receipt, or an open modal prevents submission',async()=>{
  for(const cause of ['cancel','receipt','modal']){
    const h=harness();h.state.buttons=[h.button('Run')];
    if(cause==='cancel')h.cancel();
    if(cause==='modal')h.state.dialog={};
    await assert.rejects(h.api.clickRunButton(900,'task',cause==='receipt'?()=>{throw Error('attachment changed');}:undefined,600));
    assert.equal(h.sends,0);
  }
});

test('post-click cancellation never produces a second click',async()=>{
  const h=harness();h.state.buttons=[h.button('Run',{click(){h.cancel();}})];
  await assert.rejects(h.api.clickRunButton(900,'task',undefined,600),/取消/);assert.equal(h.sends,1);
});

function audioCard({name='Generated Audio November 9',tokens=true,play=true,busy=false,error=false}={}) {
  const player={textContent:'play_arrow',disabled:false,getAttribute(){return null;}};
  return {textContent:name+(tokens?' 10,380 tokens':''),getAttribute(){return null;},
    matches(selector){return selector==='ms-audio-chunk';},
    querySelector(selector){if(error&&selector.includes('role="alert"'))return {};if(busy&&selector.includes('progressbar'))return {};return null;},
    querySelectorAll(){return play?[player]:[];}};
}

test('screenshot Run return-key shortcut matches but Run settings does not',()=>{
  const h=harness();for(const text of ['Run ↵','Run keyboard_return','play_arrow Run ↵']){
    const run=h.button(text);h.state.buttons=[h.button('Run settings'),run];assert.equal(h.api.findRunButton(),run);
  }
});

test('drop receipt follows a renamed generated audio player with tokens and no HTML audio',()=>{
  const h=harness(),old=audioCard({name:'audio.m4a'}),fresh=audioCard();
  const receipt={existing:new Set([old]),card:null,mime:'audio/mp4'};h.state.cards=[old,fresh];
  assert.equal(h.api.attachmentState('audio.m4a',receipt).state,'confirmed');assert.equal(receipt.card,fresh);
  fresh.textContent='Another website-generated name 10,380 tokens';
  assert.equal(h.api.attachmentState('audio.m4a',receipt).state,'confirmed');
});

test('old same-name ready card, token-only, filename-only and loading/error cannot confirm',()=>{
  const h=harness(),old=audioCard({name:'audio.m4a'});
  for(const options of [{tokens:false,play:false},{play:false},{busy:true},{error:true}]){
    const fresh=audioCard(options),receipt={existing:new Set([old]),card:null,mime:'audio/mp4'};h.state.cards=[old,fresh];
    assert.equal(h.api.attachmentState('audio.m4a',receipt).state,options.error?'failed':'pending');
  }
  h.state.cards=[old];assert.equal(h.api.attachmentState('audio.m4a',{existing:new Set([old]),mime:'audio/mp4'}).state,'pending');
});

test('multiple attachments keep distinct receipts and recheck the earlier card',async()=>{
  const h=harness(),first=audioCard(),second=audioCard();h.state.cards=[first];
  const one={existing:new Set(),mime:'audio/mp4'};
  assert.equal(h.api.attachmentState('one.m4a',one).state,'confirmed');
  const two={existing:new Set([first]),mime:'audio/mp4'};h.state.cards.push(second);
  assert.equal(h.api.attachmentState('two.m4a',two).state,'confirmed');assert.notEqual(one.card,two.card);
  first.querySelector=s=>s.includes('progressbar')?{}:null;h.state.buttons=[h.button('Run ↵')];
  await assert.rejects(h.api.clickRunButton(900,'task',()=>{
    for(const receipt of [one,two])if(h.api.attachmentState('',receipt).state!=='confirmed')throw Error('prior attachment is processing');
  },600),/prior attachment/);assert.equal(h.sends,0);
});

test('nested renderer and attachment wrapper count as one new card; ambiguous peers do not',()=>{
  const h=harness(),card=audioCard(),wrapper={contains(other){return other===card;}};
  h.state.cards=[wrapper,card];const receipt={existing:new Set(),mime:'audio/mp4'};
  assert.equal(h.api.attachmentState('audio.m4a',receipt).state,'confirmed');assert.equal(receipt.card,card);
  h.state.cards=[audioCard(),audioCard()];assert.equal(h.api.attachmentState('audio.m4a',{existing:new Set(),mime:'audio/mp4'}).state,'pending');
});

test('bound receipt never switches to a different later card if its own card disappears',()=>{
  const h=harness(),first=audioCard(),receipt={existing:new Set(),mime:'audio/mp4'};h.state.cards=[first];
  assert.equal(h.api.attachmentState('audio.m4a',receipt).state,'confirmed');h.state.cards=[audioCard()];
  assert.equal(h.api.attachmentState('audio.m4a',receipt).state,'pending');
});

const completeSRT='1\n00:00:00,000 --> 00:00:10,000\n完整测试字幕。\n[转写完成 00:00:10]';
function modelTurn(text,{thought=false,error=false}={}) {
 return {textContent:text,querySelector(selector){
  if(selector==='.chat-turn-container.model')return {};
  if(selector==='ms-thought-chunk')return thought?{}:null;
  if(selector.includes('role="alert"'))return error?{}:null;
  return null;
 },querySelectorAll(){return [];}};
}
test('relay waits for a new model response to finish and stabilize; old responses and thoughts excluded',async()=>{
 const h=harness(),old=modelTurn(completeSRT),thought=modelTurn('internal notes',{thought:true});
 const fresh=modelTurn(completeSRT);h.state.turns=[old,thought,fresh];
 h.state.buttons=[h.button('Run',{disabled:true}),h.button('Stop generating')];
 let ticks=0;h.state.onTick=()=>{if(++ticks===3)h.state.buttons=[h.button('Run')];};
 const transcript=await h.api.waitForTranscript(new Set([old]),'task',10,5000);
 assert.match(transcript,/完整测试字幕/);assert.equal(transcript.includes('转写完成'),false);assert.ok(ticks>=6);
});
test('relay ignores a newly created user turn even if it contains valid SRT',async()=>{
 const h=harness();h.state.buttons=[h.button('Run')];
 h.state.turns=[{textContent:completeSRT,querySelector(){return null;},querySelectorAll(){return [];}}];
 await assert.rejects(h.api.waitForTranscript(new Set(),'task',10,1000),/超时/);
});
test('relay rejects explicit generation errors, incomplete output and cancellation',async()=>{
 for(const mode of ['error','incomplete','cancel']){
  const h=harness();h.state.buttons=[h.button('Run')];h.state.turns=[modelTurn(mode==='incomplete'?'1\n00:00:00,000 --> 00:00:02,000\n残稿':completeSRT,{error:mode==='error'})];
  if(mode==='cancel')h.cancel();
  await assert.rejects(h.api.waitForTranscript(new Set(),'task',10,3000),mode==='error'?/生成失败/:mode==='cancel'?/取消/:/完成标记/);
  assert.equal(h.sends,0);
 }
});
