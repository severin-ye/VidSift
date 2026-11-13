'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function setup(){
 const listeners={},calls=[];
 const event=name=>({addListener(fn){listeners[name]=fn;}});
 class Companion{
  ready=Promise.resolve();
  async status(){return {enabled:true,queued:0};}
  async setEnabled(value){calls.push(['enabled',value]);return {enabled:value};}
  async stopAll(){calls.push(['stop']);return {enabled:true,queued:0};}
  async handleMessage(message,sender){calls.push(['content',message.type,sender.tab.id]);return {ok:true};}
  onRemoved(id){calls.push(['removed',id]);}
  onUpdated(...args){calls.push(['updated',...args]);}
  onActivated(info){calls.push(['activated',info.tabId]);}
  onAlarm(alarm){calls.push(['alarm',alarm.name]);}
 }
 const chrome={runtime:{id:'extension',getURL:path=>'chrome-extension://extension/'+path,onMessage:event('message')},tabs:{onRemoved:event('removed'),onUpdated:event('updated'),onActivated:event('activated')},alarms:{onAlarm:event('alarm')},storage:{onChanged:event('storage')}};
 const context={chrome,BiliCompanion:Companion,console};context.globalThis=context;
 vm.runInNewContext(fs.readFileSync('background-bili-companion.js','utf8'),context);
 async function message(msg,sender){let response;const pending=listeners.message(msg,sender,x=>{response=x;});if(pending)await new Promise(resolve=>setImmediate(resolve));return response;}
 return {listeners,calls,message};
}
test('companion controls only accept exact extension settings/popup pages',async()=>{
 const {message,calls}=setup();
 assert.equal((await message({type:'VIDSIFT_COMPANION_SET_ENABLED',enabled:false},{id:'extension',url:'https://www.bilibili.com/video/BV1LtWT66EMR',tab:{id:1}})).ok,false);
 assert.equal((await message({type:'VIDSIFT_COMPANION_STOP'},{id:'foreign',url:'chrome-extension://extension/options.html'})).ok,false);
 assert.equal((await message({type:'VIDSIFT_COMPANION_SET_ENABLED',enabled:'false'},{id:'extension',url:'chrome-extension://extension/options.html'})).ok,false);
 assert.equal(calls.length,0);
 const result=await message({type:'VIDSIFT_COMPANION_SET_ENABLED',enabled:false},{id:'extension',url:'chrome-extension://extension/options.html',tab:{id:5}});
 assert.equal(result.ok,true);assert.deepEqual(calls,[['enabled',false]]);
});
test('content identity is delegated to controller and unrelated messages are ignored',async()=>{
 const {message,calls}=setup();
 assert.equal((await message({type:'VIDSIFT_COMPANION_CLAIM'},{id:'extension',url:'https://www.bilibili.com/video/BV1LtWT66EMR',tab:{id:3}})).ok,true);
 assert.deepEqual(calls,[['content','VIDSIFT_COMPANION_CLAIM',3]]);
 assert.equal(await message({type:'UNRELATED'},{id:'extension'}),undefined);
});
test('tab and alarm lifecycle events reach companion without changing summary state',async()=>{
 const {listeners,calls}=setup();
 listeners.removed(3);listeners.updated(3,{url:'https://example.com/'},{id:3});listeners.activated({tabId:3});listeners.alarm({name:'vidsift-bili-companion'});
 assert.deepEqual(calls.map(row=>row[0]),['removed','updated','activated','alarm']);
});

test('accepting a Bilibili summary starts independent playback once; playback failure cannot fail summary',async()=>{
 const enqueued=[],accepted=[],errors=[];
 const source={platform:'bilibili',videoId:'BV123abc',part:2,url:'https://www.bilibili.com/video/BV123abc?p=2'};
 const context={console,globalThis:null,VidSiftPlatforms:{identify:()=>source},_videoWorkflow:{tasks:new Map()},_getActiveTranscribeTask(){},_setActiveTranscribeTask(){},diagnoseTask(){},finishLegacyTask(){},
  _legacyGuard:{get(){},begin:()=>({id:'task-1',source,tabId:4})},
  DouyinLocalSettings:{migrate:async()=>{}},chrome:{storage:{local:{get:async()=>({})}}},
  captureTaskSource:async()=>({source}),prepareBilibiliSource:async()=>source,
  runSummaryJob:()=>Promise.resolve('summary-completed'),
  VidSiftCompanion:{enqueue:async(value,options)=>{enqueued.push({value,options});throw Error('playback fixture failed');}},
  VidSiftErrors:{report:message=>errors.push(message)}};
 context.globalThis=context;
 const script=fs.readFileSync('background-video.js','utf8');
 vm.runInNewContext(script.slice(script.indexOf('async function startVideoSummary'),script.indexOf('chrome.runtime.onConnect')),context);
 const result=await context.startVideoSummary({sourceUrl:source.url,openerTabId:4,tempChat:true},(type,text)=>accepted.push({type,text}));
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(result,'summary-completed');assert.equal(accepted[0].type,'ACCEPTED');assert.equal(enqueued.length,1);
 assert.equal(enqueued[0].value.part,2);assert.equal(enqueued[0].options.tempChat,true);assert.equal(enqueued[0].options.taskId,'task-1');
 assert.match(errors[0],/总结伴播未加入/);
});
