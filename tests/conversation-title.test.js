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
async function run({source,bvid,title=raw,tempChat=false,id='owned',pending=false}={}){
 let sent=0;const renames=[],retries=[],timers=[];
 const c={msg:{type:'VIDSIFT_CHATGPT_PREPARE_PROMPT',videoTitle:title,source,bvid,tempChat,taskId:'task',file:{name:'original.srt',content:'subtitle'}},
  VidSiftConversationTitle:{formatConversationTitle:format},_taskActive:false,globalThis:null,Date,console:{log(){},error(){},warn(){}},
  getConversationIdFromUrl:()=>null,sendResponse(){},document:{title:''},setInterval(fn){timers.push(fn);return 1;},clearInterval(){},
  VidSiftAttachments:{normalizeMessage:m=>[m.file],contextualPrompt:()=>''},showSaveButton(){},showRetryRenameButton:(id,title)=>retries.push({id,title}),showStatus(){},inputPrompt(){},readComposerText:()=>'',loadPrompt:async()=>'',assertNotCancelled(){},attachFileWithRetry:async()=>({}),
  captureSubmittedConversation:()=>({ready:Promise.resolve(),promise:Promise.resolve(id),stop(){}}),clickSend:async()=>{sent++;},reportTarget(){},hideSaveButton(){},scrollToResponseOnTabFocus(){},hideStatus(){},showError(){},hideRetryRenameButton(){},
  renameConversationViaAPI:async(id,title)=>{renames.push({id,title});return !pending;},showFailedAttachmentRetry(){},chrome:{runtime:{sendMessage:async()=>({ok:true})}}};
 c.globalThis=c;vm.createContext(c);
 const handler=content.slice(content.indexOf("    if (msg.type === 'VIDSIFT_CHATGPT_PREPARE_PROMPT')"),content.indexOf("    if (msg.type === 'EXT_STATUS')"));
 vm.runInContext('(function(){'+handler+'})();',c);
 for(let n=0;n<30&&c._taskActive;n++)await new Promise(setImmediate);
 assert.equal(c._taskActive,false);return {sent,renames,retries,title:c.document.title};
}
test('actual modern GPT handler sends once and uses same formatted title for pending retry',async()=>{
 const result=await run({source:{platform:'douyin',title:raw,videoId:'123'},pending:true});
 assert.equal(result.sent,1);assert.deepEqual(result.renames,[{id:'owned',title:'【抖音】'+headline}]);
 assert.equal(result.retries.at(-1).title,'【抖音】'+headline);assert.equal(result.title,'【抖音】'+headline);
});
test('actual legacy handler labels Bilibili while temp and unconfirmed chats never rename',async()=>{
 const legacy=await run({bvid:'BV123abc',title:'B站原题 #话题'});assert.equal(legacy.renames[0].title,'【B站】B站原题');assert.equal(legacy.sent,1);
 for(const options of [{tempChat:true},{id:null}]){const result=await run({...options,source:{platform:'douyin'}});assert.equal(result.sent,1);assert.equal(result.renames.length,0);}
});
