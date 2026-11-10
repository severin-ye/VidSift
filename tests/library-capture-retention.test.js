const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const lib=require('../video-library.js');
function fixture(){
 let state={version:1,tasks:[],pending:[],covers:[]},message,removed;
 const chrome={runtime:{onMessage:{addListener:fn=>message=fn},onStartup:{addListener(){}},sendMessage:async()=>({})},tabs:{onRemoved:{addListener:fn=>removed=fn}},storage:{local:{get:async()=>({videoLibraryState:structuredClone(state)}),set:async x=>{state=structuredClone(x.videoLibraryState);}}}};
 const context=vm.createContext({chrome,VidSiftVideoLibrary:lib,console});vm.runInContext(fs.readFileSync('background-library.js','utf8'),context);
 return {context,get state(){return state;},removed,send:(msg,sender)=>new Promise(resolve=>message(msg,sender,resolve)),settle:()=>vm.runInContext('_videoLibrary.serial',context),register:async(taskId,sent)=>{await vm.runInContext(`_videoLibrary.register({taskId:'${taskId}',tabId:7,source:{url:'https://www.youtube.com/watch?v=nAEcMiFmqgg'}})`,context);if(sent)await vm.runInContext(`_videoLibrary.submitted('${taskId}',{tab:{id:7}})`,context);}};
}
test('closed tab retains sent unconfirmed source metadata while removing unsent tasks',async()=>{
 const f=fixture();await f.register('sent',true);await f.register('unsent',false);f.removed(7);await f.settle();
 assert.equal(f.state.tasks.length,1);assert.equal(f.state.tasks[0].taskId,'sent');assert.equal(f.state.tasks[0].captureStatus,'unconfirmed');assert.equal(f.state.tasks[0].source.videoId,'nAEcMiFmqgg');assert.match(f.state.message,/尚未入书库/);assert.equal(f.state.pending.length,0);
});
test('capture timeout persists an explicit unsaved status and rejects another tab',async()=>{
 const f=fixture();await f.register('sent',true);
 await f.send({type:'VIDSIFT_LIBRARY_UNCONFIRMED',taskId:'sent'},{tab:{id:8},url:'https://chatgpt.com/'});assert.equal(f.state.tasks[0].captureStatus,undefined);
 await f.send({type:'VIDSIFT_LIBRARY_UNCONFIRMED',taskId:'sent'},{tab:{id:7},url:'https://chatgpt.com/'});assert.equal(f.state.tasks[0].captureStatus,'unconfirmed');assert.match(f.state.message,/尚未入书库/);
 assert.equal(f.state.pending.length,0);
});
