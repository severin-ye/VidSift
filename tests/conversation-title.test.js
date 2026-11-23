const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {formatConversationTitle:format}=require('../conversation-title');
const headline='42分钟看懂冲绳岛战役始末。太平洋战场赢来终章。';
const raw='【抖音精选】'+headline+' #地图推演 #第二次世界大战 #硫磺岛战役 #vibe知识大赏 #抖音精选app征稿中 @抖音人文';
test('exact chosen Douyin headline keeps original words and punctuation',()=>{
 assert.equal(format(raw,{platform:'douyin'}),'【抖音】'+headline);
 assert.equal(format(format(raw,{platform:'douyin'}),{platform:'douyin'}),'【抖音】'+headline);
});
test('platform labels, legacy identity and unknown sources',()=>{
 assert.equal(format('原题',{platform:'bilibili'}),'【B站】原题');
 assert.equal(format('原题',{videoId:'BV123abc'}),'【B站】原题');
 assert.equal(format('【YouTube】原题',{platform:'youtube'}),'【YouTube】原题');
 assert.equal(format('原题',{platform:'unknown',videoId:'abc'}),'原题');
});
test('only terminal metadata is removed, preserving substantive symbol uses',()=>{
 for(const title of ['C# 入门','联系 me@example.com','介绍 @decorator 的作用','解释 #include 语法','C#','a@b','如何理解 #hashtag？'])assert.equal(format(title),title);
 assert.equal(format('原题。#历史#知识 @作者'),'原题。');
 assert.equal(format('原题！ #历史'),'原题！');
});
test('blank or metadata-only title uses source identity and never metadata as fallback',()=>{
 for(const title of ['', ' #知识 @作者 ', '【抖音精选】 #知识'])assert.equal(format(title,{platform:'douyin',videoId:'123'}),'【抖音】123');
 assert.equal(format('#知识'), '');
});
const content=fs.readFileSync('chatgpt-content.js','utf8');
test('manual attachment retry offers copying the prompt without writing to the composer',()=>{
 const task={taskId:'task',recoveryEditor:{},recoveryPrompt:'private prompt'};
 const shown=[];
 const c=vm.createContext({task,_lastConversationTask:task,cancelledTasks:new Set(),
  findTextarea:()=>task.recoveryEditor,inputPrompt:()=>assert.fail('manual retry must not write a draft'),
  showStatus:(text,prompt)=>shown.push(prompt)});
 const helper=content.match(/  function showManualUploadReady[\s\S]+?(?=\n  function showFailedAttachmentRetry)/)?.[0]??'';
 vm.runInContext(helper+'\nshowManualUploadReady(task);',c);
 assert.deepEqual(shown,['private prompt']);
});
async function run({source,bvid,title=raw,tempChat=false,id='owned',pending=false,uploadError,sendError,initialDraft='',draftDuringUpload,lateEditor=false,changeBeforeSend,preparePage,oldAttachment=false,promptSuffix='',attachName='original.srt',beforeSendAttachments}={}){
 let sent=0, draftAtUpload, draftWhileWaitingForSend, failure, beforeInput, sentText;const renames=[],retries=[],timers=[];
 const form={};
 let editor={text:initialDraft,closest:()=>form};
 let missing=lateEditor;
 const tile={name:attachName,querySelector:()=>null};
 const tiles=oldAttachment?[{querySelector:()=>null}]:[];
 const c={msg:{type:'VIDSIFT_CHATGPT_PREPARE_PROMPT',videoTitle:title,source,bvid,tempChat,taskId:'task',file:{name:'original.srt',content:'subtitle'}},
  VidSiftConversationTitle:{formatConversationTitle:format},_taskActive:false,globalThis:null,Date,console:{log(){},error(){},warn(){}},
  URL,getConversationIdFromUrl:()=>c.location.href.includes('/c/')?'11111111-2222-4333-8444-555555555555':null,
  sendResponse(){},document:{title:''},setInterval(fn){timers.push(fn);return 1;},clearInterval(){},
  VidSiftConversationBinding:require('../conversation-binding'),setTimeout(fn){missing=false;if(preparePage==='pending-card'&&!tiles.length)tiles.push({...tile});queueMicrotask(fn);},
  VidSiftAttachments:{normalizeMessage:m=>[m.file],contextualPrompt:prompt=>prompt+promptSuffix},showSaveButton(){},showRetryRenameButton:(id,title)=>retries.push({id,title}),showStatus(){},findTextarea:()=>missing?null:editor,inputPrompt:(text,target)=>{target.text=text;},readComposerText:target=>target?.text??'',loadPrompt:async()=>'synthetic video prompt',assertNotCancelled(){},attachFileWithRetry:async()=>{
   draftAtUpload=editor.text;
   if(draftDuringUpload!==undefined)editor.text=draftDuringUpload;
   if(uploadError)throw Error(uploadError);
   if(preparePage)c.location.href+='c/11111111-2222-4333-8444-555555555555';
   if(preparePage==='other-form')editor={...editor,closest:()=>({})};
   tiles.push(tile);
   return tile;
  },
  getVisibleFileTiles:()=>tiles,
  getFileTileName:tile=>tile.name,
  tileNameMatches:(observed,requested)=>observed===requested||observed==='original(1).srt',
  attachmentFailed:tile=>!!tile.failed,
  attachmentReady:tile=>!tile.busy,
  ATTACHMENT_TILE_SELECTOR:'[class~="group/composer-attachment"]',
  window:{addEventListener(type,handler){if(type==='beforeinput')beforeInput=handler;},removeEventListener(){}},location:{href:'https://chatgpt.com/'},
  captureSubmittedConversation:()=>{
   if(preparePage==='pending-card')tiles.length=0;
   return {ready:Promise.resolve(),promise:Promise.resolve(id),stop(){}};
  },clickSend:async(taskId,verify,prepare)=>{
   draftWhileWaitingForSend=editor.text;
   if(prepare){
    if(changeBeforeSend==='draft')editor.text='my own draft';
    if(changeBeforeSend==='navigate')c.location.href+='c/other';
    if(beforeSendAttachments)tiles.splice(0,tiles.length,...beforeSendAttachments(tiles));
    assert.notEqual(verify(editor,false),false);
    prepare(editor);
   }
   if(sendError)throw Error(sendError);
   if(changeBeforeSend==='remount')editor={...editor,text:'synthetic\u00a0video prompt'};
   if(changeBeforeSend==='draft')editor.text='my own draft';
   if(changeBeforeSend==='user-spacing'){
    beforeInput?.({isTrusted:true,target:editor});
    editor.text='synthetic  video prompt';
   }
   if(!prepare&&changeBeforeSend==='navigate')c.location.href+='c/other';
   if(!prepare&&beforeSendAttachments)tiles.splice(0,tiles.length,...beforeSendAttachments(tiles));
   assert.notEqual(verify(editor,true),false);
   sent++;sentText=editor.text;editor.text='';
  },reportTarget:(msg,ok,error)=>{if(!ok)failure=error;},hideSaveButton(){},scrollToResponseOnTabFocus(){},hideStatus(){},showError(){},hideRetryRenameButton(){},
  renameConversationViaAPI:async(id,title)=>{renames.push({id,title});return !pending;},showFailedAttachmentRetry(){},chrome:{runtime:{sendMessage:async()=>({ok:true})}}};
 c.globalThis=c;vm.createContext(c);
 const helpers=content.match(/  async function waitFor(?:Empty)?Composer[\s\S]+?(?=\n  function inputPrompt)/)?.[0]??'';
 const handler=content.slice(content.indexOf("    if (msg.type === 'VIDSIFT_CHATGPT_PREPARE_PROMPT')"),content.indexOf("    if (msg.type === 'EXT_STATUS')"));
 vm.runInContext('(function(){'+helpers+handler+'})();',c);
 for(let n=0;n<30&&c._taskActive;n++)await new Promise(setImmediate);
 assert.equal(c._taskActive,false);return {sent,sentText,renames,retries,title:c.document.title,draftAtUpload,draftWhileWaitingForSend,draft:editor.text,failure};
}
test('ChatGPT leaves the composer blank while uploading and after an upload fails',async()=>{
 const result=await run({tempChat:true,uploadError:'upload failed'});
 assert.equal(result.draftAtUpload,'');
 assert.equal(result.draft,'');
 assert.equal(result.sent,0);
 assert.equal(result.failure,'upload failed');
});
test('ChatGPT clears its own unsent prompt when submission fails',async()=>{
 const result=await run({tempChat:true,sendError:'send failed'});
 assert.equal(result.draft,'');
 assert.equal(result.sent,0);
 assert.equal(result.failure,'send failed');
});
test('ChatGPT keeps the composer blank until the single submission attempt',async()=>{
 const result=await run({tempChat:true});
 assert.equal(result.draftWhileWaitingForSend,'');
 assert.equal(result.sentText,'synthetic video prompt');
 assert.equal(result.sent,1);
});
test('ChatGPT preserves user drafts present before or written during the upload',async()=>{
 for(const options of [{initialDraft:'my own draft'},{draftDuringUpload:'my own draft'}]){
  const result=await run({tempChat:true,...options});
  assert.equal(result.draft,'my own draft');
  assert.equal(result.sent,0);
 }
});
test('ChatGPT resumes with the complete restored summary prompt and sends only new attachments',async()=>{
 const initialDraft='synthetic video prompt';
 const resumed=await run({initialDraft,tempChat:false});
 assert.equal(resumed.sent,1,resumed.failure);
 assert.equal(resumed.draftAtUpload,initialDraft);
 assert.equal(resumed.sentText,initialDraft);
 const pictured=await run({initialDraft,promptSuffix:' with current images'});
 assert.equal(pictured.sentText,initialDraft+' with current images');
 const failed=await run({initialDraft,promptSuffix:' with current images',sendError:'send failed'});
 assert.equal(failed.draft,initialDraft);
 for(const options of [{initialDraft:initialDraft+' plus private notes'},{initialDraft,oldAttachment:true}]){
  const blocked=await run(options);
  assert.equal(blocked.sent,0);
  assert.equal(blocked.draftAtUpload,undefined);
  assert.equal(blocked.draft,options.initialDraft);
 }
});
test('ChatGPT waits for the real editor when it disappears between readiness and handoff',async()=>{
 const result=await run({tempChat:true,lateEditor:true});
 assert.equal(result.sent,1,result.failure);
 assert.equal(result.draftAtUpload,'');
});
test('ChatGPT sends once when the same form remounts the editor with the same prompt',async()=>{
 const result=await run({tempChat:true,changeBeforeSend:'remount'});
 assert.equal(result.sent,1,result.failure);
});
test('ChatGPT follows a confirmed attachment when the page remounts the card with its full filename',async()=>{
 const result=await run({attachName:'original(1).srt',beforeSendAttachments:([tile])=>[{...tile}]});
 assert.equal(result.sent,1,result.failure);
});
test('ChatGPT blocks extra, duplicated, or differently renamed attachments before sending',async()=>{
 for(const beforeSendAttachments of [
  ([tile])=>[tile,{...tile,name:'unrelated.srt'}],
  ([tile])=>[tile,{...tile}],
  ([tile])=>[{...tile,name:'original(2).srt'}],
 ]){
  assert.equal((await run({attachName:'original(1).srt',beforeSendAttachments})).sent,0);
 }
});
test('ChatGPT accepts an allocated conversation URL only with the original upload form and receipt',async()=>{
 assert.equal((await run({preparePage:'same-form'})).sent,1);
 assert.equal((await run({preparePage:'pending-card'})).sent,1);
 assert.equal((await run({preparePage:'other-form'})).sent,0);
});
test('ChatGPT never sends or clears a replacement user draft or sends on a different page',async()=>{
 const drafted=await run({tempChat:true,changeBeforeSend:'draft'});
 assert.equal(drafted.sent,0);
 assert.equal(drafted.draft,'my own draft');
 assert.equal((await run({tempChat:true,changeBeforeSend:'navigate'})).sent,0);
 const edited=await run({tempChat:true,changeBeforeSend:'user-spacing'});
 assert.equal(edited.sent,0);
 assert.equal(edited.draft,'synthetic  video prompt');
});
test('actual modern GPT handler sends once and uses same formatted title for pending retry',async()=>{
 const result=await run({source:{platform:'douyin',title:raw,videoId:'123'},pending:true});
 assert.equal(result.sent,1);assert.deepEqual(result.renames,[{id:'owned',title:'【抖音】'+headline}]);
 assert.equal(result.retries.at(-1).title,'【抖音】'+headline);assert.equal(result.title,'【抖音】'+headline);
});
test('actual legacy handler labels Bilibili while temp and unconfirmed chats never rename',async()=>{
 const legacy=await run({bvid:'BV123abc',title:'B站原题 #话题'});assert.equal(legacy.renames[0].title,'【B站】B站原题');assert.equal(legacy.sent,1);
 for(const options of [{tempChat:true},{id:null}]){const result=await run({...options,source:{platform:'douyin'}});assert.equal(result.sent,1);assert.equal(result.renames.length,0);}
});

test('ChatGPT title respects the server 128 Unicode character limit without changing source metadata',()=>{
 const raw='数学原题。'.repeat(40),source={platform:'douyin',videoId:'123',title:raw};
 const title=format(raw,source);assert.equal(Array.from(title).length,128);assert(title.startsWith('【抖音】数学原题。'));assert.equal(source.title,raw);
 const emoji=format('🧮'.repeat(140),{platform:'douyin'});assert.equal(Array.from(emoji).length,128);assert.equal(emoji,'【抖音】'+'🧮'.repeat(124));assert.equal(format(emoji,{platform:'douyin'}),emoji);
});
