const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const sourceUrl='https://www.bilibili.com/video/BV123abc';
function event(){const listeners=[];return {listeners,addListener(fn){listeners.push(fn);},removeListener(fn){const i=listeners.indexOf(fn);if(i>=0)listeners.splice(i,1);}};}
function fixture({failHandoff=false,failTarget=false,pauseReady}={}){
 const sent=[],created=[],getIds=[],messages=event(),connections=event(),updated=event(),removed=event();
 const dispatch=(msg,sender={})=>new Promise(resolve=>{let pending=false;for(const fn of messages.listeners){if(fn(msg,sender,resolve)===true)pending=true;}if(!pending)resolve();});
 const chrome={runtime:{onMessage:messages,onConnect:connections},tabs:{onUpdated:updated,onRemoved:removed,
  async get(id){getIds.push(id);assert.ok(Number.isInteger(id),'tabs.get(integer tabId): No matching signature');return {id,url:id===20?'https://chatgpt.com/':sourceUrl,index:0,windowId:1};},
  async create(options){created.push(options);setImmediate(()=>updated.listeners.slice().forEach(fn=>fn(20,{status:'complete'})));return {id:20};},
  async sendMessage(id,msg){assert.ok(Number.isInteger(id));sent.push({id,msg});if(msg.type==='VIDSIFT_CHATGPT_PING')return {ok:true,component:'chatgpt'};if(msg.type==='VIDSIFT_BILI_PING')return {ok:true,component:'bilibili',mainReady:true};if(msg.type==='VIDSIFT_CHATGPT_CHECK_READY'){if(pauseReady)await pauseReady();return {ready:true};}if(msg.type==='VIDSIFT_CHATGPT_PREPARE_PROMPT')await dispatch({type:'VIDSIFT_TARGET_DONE',taskId:msg.taskId,ok:!failTarget,error:'upload failed'},{tab:{id}});if(msg.type==='SELF_HOSTED_TRANSCRIBE'&&failHandoff)throw new Error('content script unavailable');return {ok:true};}
 }};
 const context=vm.createContext({chrome,console,URL,AbortController,performance,setInterval,clearInterval,setTimeout:(fn,ms)=>ms===1500?setTimeout(fn,0):setTimeout(fn,ms),clearTimeout});
 context.importScripts=(...files)=>files.forEach(file=>vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),context,{filename:file}));
 context.importScripts('background.js');
 async function start(extra={}){const port={name:'bilibili-subtitle',onMessage:event(),onDisconnect:event(),postMessage:msg=>notifications.push(msg)};const notifications=[];connections.listeners.forEach(fn=>fn(port));await Promise.all(port.onMessage.listeners.map(fn=>fn({type:'START_TASK',taskType:'chatgpt',sourceUrl,openerTabId:7,file:{name:'video.srt',content:'hello'},...extra})));return notifications;}
 return {start,sent,created,getIds,dispatch,context,closeTab:id=>removed.listeners.forEach(fn=>fn(id))};
}
test('real legacy START_TASK with only openerTabId opens target and sends subtitle until acknowledged',async()=>{
 const f=fixture(),notes=await f.start();assert.equal(notes.some(x=>x.type==='ERROR'),false,JSON.stringify(notes));assert.equal(f.created.length,1);assert.equal(f.created[0].openerTabId,7);assert.equal(f.sent.find(x=>x.msg.type==='VIDSIFT_CHATGPT_PREPARE_PROMPT').msg.file.content,'hello');assert.equal(notes.at(-1).type,'DONE');
});
test('missing or malformed source tab fails explicitly without invoking tabs API',async()=>{
 for(const biliTabId of [undefined,'7',-1,1.5]){const f=fixture(),notes=await f.start({openerTabId:undefined,biliTabId});assert.match(notes.at(-1).text,/来源.*标签页/);assert.equal(f.getIds.length,0);assert.equal(f.created.length,0);}
});
test('failed self-hosted handoff releases guard and audio lock for retry',async()=>{
 const f=fixture({failHandoff:true});await f.start({taskType:'selfhosted',biliTabId:7});assert.equal((await f.dispatch({type:'GET_TAB_TRANSCRIBE_STATUS',tabId:7})).active,false);const notes=await f.start({biliTabId:7});assert.equal(notes.at(-1).type,'DONE');
});
test('explicit source ID is used and target failure releases task state',async()=>{
 const f=fixture({failTarget:true}),notes=await f.start({biliTabId:8});assert.equal(f.created[0].openerTabId,8);assert.equal(notes.at(-1).type,'ERROR');assert.match(notes.at(-1).text,/upload failed/);assert.equal((await f.dispatch({type:'GET_TAB_TRANSCRIBE_STATUS',tabId:8})).active,false);
});
test('old content events and result cannot clear or attach to a new transcription',async()=>{
 const f=fixture();await f.start({taskType:'selfhosted',biliTabId:7});const first=f.sent.find(x=>x.msg.type==='SELF_HOSTED_TRANSCRIBE').msg.taskId;
 await f.dispatch({type:'TRANSCRIBE_TASK_EVENT',state:'error',taskId:first},{tab:{id:7}});
 await f.start({taskType:'selfhosted',biliTabId:7});const second=f.sent.filter(x=>x.msg.type==='SELF_HOSTED_TRANSCRIBE').at(-1).msg.taskId;assert.notEqual(first,second);
 for(const taskId of [first,undefined]){assert.equal((await f.dispatch({type:'TRANSCRIBE_TASK_EVENT',state:'error',taskId},{tab:{id:7}})).ok,false);assert.equal((await f.dispatch({type:'GET_TAB_TRANSCRIBE_STATUS',tabId:7})).active,true);}
 assert.equal((await f.dispatch({type:'SELF_HOSTED_SRT_RESULT',taskId:first,srtContent:'old'},{tab:{id:7}})).ok,false);assert.equal(f.created.length,0);
 await f.dispatch({type:'TRANSCRIBE_TASK_EVENT',state:'error',taskId:second},{tab:{id:7}});assert.equal((await f.dispatch({type:'GET_TAB_TRANSCRIBE_STATUS',tabId:7})).active,false);
});
test('subtitle replaced while target loads cannot send itself with the new task identity',async()=>{
 let release,reached;const waiting=new Promise(r=>reached=r),gate=new Promise(r=>release=r);let first=true;
 const f=fixture({pauseReady:()=>{if(first){first=false;reached();return gate;}}});
 const old=f.start();await waiting;
 await f.start({taskType:'selfhosted',biliTabId:7});release();const notes=await old;
 assert.equal(notes.at(-1).type,'ERROR');assert.equal(f.sent.filter(x=>x.msg.type==='VIDSIFT_CHATGPT_PREPARE_PROMPT').length,0);assert.equal((await f.dispatch({type:'GET_TAB_TRANSCRIBE_STATUS',tabId:7})).active,true);
 const current=f.sent.find(x=>x.msg.type==='SELF_HOSTED_TRANSCRIBE').msg.taskId;await f.dispatch({type:'TRANSCRIBE_TASK_EVENT',state:'error',taskId:current},{tab:{id:7}});
});

test('AI Studio task popup resolves progress and cancellation to its source video',async()=>{
 const f=fixture();await f.start({taskType:'selfhosted',biliTabId:7});
 vm.runInContext('waitForTarget(_legacyGuard.get(7),20).catch(()=>{});_updateActiveTranscribeTask(7,"AI Studio 已收到任务");',f.context);
 const status=await f.dispatch({type:'GET_TAB_TRANSCRIBE_STATUS',tabId:20});
 assert.equal(status.sourceTabId,7);assert.equal(status.active,true);assert.match(status.statusText,/已收到任务/);
 const cancelled=await f.dispatch({type:'CANCEL_VIDEO_TASK',tabId:20});assert.equal(cancelled.ok,true);
 const terminal=await f.dispatch({type:'GET_TAB_TRANSCRIBE_STATUS',tabId:20});assert.equal(terminal.active,false);assert.equal(terminal.sourceTabId,7);
});

test('closing the source cancels a pending legacy target and releases its task state',async()=>{
 const f=fixture();await f.start({taskType:'selfhosted',biliTabId:7});
 vm.runInContext('waitForTarget(_legacyGuard.get(7),20).catch(()=>{});',f.context);
 f.closeTab(7);
 assert.ok(f.sent.some(x=>x.id===20&&x.msg.type==='VIDSIFT_CANCEL_UPLOAD'));
 const status=await f.dispatch({type:'GET_TAB_TRANSCRIBE_STATUS',tabId:20});assert.equal(status.active,false);assert.match(status.statusText,/页面已关闭/);
 assert.equal(vm.runInContext('_targetCompletions.size',f.context),0);
});

test('delayed Douyin source-change notification cannot cancel the current matching work',async()=>{
 const f=fixture();f.context.chrome.tabs.get=async id=>({id,url:'https://www.douyin.com/video/111'});
 vm.runInContext(`globalThis.modern={id:'modern',tabId:7,source:VidSiftPlatforms.identify('https://www.douyin.com/video/111'),controller:new AbortController(),cancelled:false};_videoWorkflow.tasks.set(7,modern);`,f.context);
 await f.dispatch({type:'VIDSIFT_SOURCE_CHANGED',url:'https://www.douyin.com/video/222'},{tab:{id:7}});
 await new Promise(setImmediate);
 assert.equal(vm.runInContext('modern.cancelled',f.context),false);
 f.context.chrome.tabs.get=async id=>({id,url:'https://www.douyin.com/video/222'});
 await f.dispatch({type:'VIDSIFT_SOURCE_CHANGED',url:'https://www.douyin.com/video/222'},{tab:{id:7}});
 await new Promise(setImmediate);
 assert.equal(vm.runInContext('modern.cancelled',f.context),true);
 assert.match(vm.runInContext('modern.cancelReason',f.context),/当前作品已改变/);
 assert.equal(vm.runInContext('_targetDiagnostics.get("modern").currentSourceKey',f.context),'douyin:222');
});
