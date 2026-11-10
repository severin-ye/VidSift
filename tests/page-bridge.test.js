const test=require('node:test'),assert=require('node:assert/strict');
const {PageBridge}=require('../page-bridge.js');
function fixture(kind='bilibili',ready=false){const calls=[],injections=[];let installed=ready;const api={tabs:{get:async()=>({url:kind==='bilibili'?'https://www.bilibili.com/video/BV1uLpn6AEtS/':'https://aistudio.google.com/prompts/new_chat'}),sendMessage:async(id,msg)=>{calls.push(msg.type);if(!installed)throw Error('Could not establish connection. Receiving end does not exist.');return {ok:true,component:kind,mainReady:true,attachmentTransfer:true};}},scripting:{executeScript:async o=>{injections.push(o);if(o.world==='ISOLATED')installed=true;}}};return {api,calls,injections,bridge:new PageBridge(api)};}
test('missing Bili receiver repairs MAIN before isolated and rechecks handshake',async()=>{const f=fixture();await f.bridge.ensure(7,'bilibili');assert.deepEqual(f.injections.map(x=>x.world),['MAIN','ISOLATED']);assert.deepEqual(f.calls,['VIDSIFT_BILI_PING','VIDSIFT_BILI_PING']);});
test('existing receiver and concurrent repairs never reinject twice',async()=>{const f=fixture();await Promise.all([f.bridge.ensure(7,'bilibili'),f.bridge.ensure(7,'bilibili')]);assert.equal(f.injections.length,2);await f.bridge.ensure(7,'bilibili');assert.equal(f.injections.length,2);});
test('target recovery only installs its expected content files',async()=>{const f=fixture('aistudio');await f.bridge.ensure(8,'aistudio');assert.equal(f.injections.length,1);assert.deepEqual(f.injections[0].files,['task-diagnostics.js','error-reporter.js','attachment-utils.js','aistudio-transcript.js','attachment-transfer.js','aistudio-content.js']);});
test('wrong page and invalid tab cannot trigger injection',async()=>{const f=fixture();f.api.tabs.get=async()=>({url:'https://accounts.google.com/login'});await assert.rejects(f.bridge.ensure(7,'aistudio'),/AI Studio.*登录|页面/);await assert.rejects(f.bridge.ensure(undefined,'bilibili'),/标签页/);assert.equal(f.injections.length,0);});
test('denied script permission identifies affected endpoint without hiding browser error',async()=>{const f=fixture();f.api.scripting.executeScript=async()=>{throw Error('Cannot access contents of url');};await assert.rejects(f.bridge.ensure(7,'bilibili'),/B站.*Cannot access contents/);});

test('AI Studio connects while tab load is still waiting on unrelated resources',async()=>{
 const f=fixture('aistudio',true);f.api.tabs.get=async()=>({url:'https://aistudio.google.com/prompts/new_chat',status:'loading'});
 await f.bridge.waitFor(8,'aistudio',{timeout:200});assert.equal(f.injections.length,0);
});
test('connecting a target checks cancellation and rejects a login redirect',async()=>{
 const f=fixture('aistudio',true);
 await assert.rejects(f.bridge.waitFor(8,'aistudio',{assertLive:async()=>{throw Error('cancelled');}}),/cancelled/);
 f.api.tabs.get=async()=>({url:'https://accounts.google.com/login',status:'complete'});
 await assert.rejects(f.bridge.waitFor(8,'aistudio',{timeout:200}),/登录/);
});

test('old AI Studio bridge is rejected without hot-injecting a second listener',async()=>{
 const f=fixture('aistudio',true);f.api.tabs.sendMessage=async()=>({ok:true,component:'aistudio'});
 await assert.rejects(f.bridge.ensure(8,'aistudio'),/旧版上传脚本/);assert.equal(f.injections.length,0);
});

test('old ChatGPT protocol is rejected rather than silently retaining its old capture logic',async()=>{
 const f=fixture('chatgpt',true);f.api.tabs.get=async()=>({url:'https://chatgpt.com/'});f.api.tabs.sendMessage=async()=>({ok:true,component:'chatgpt'});
 await assert.rejects(f.bridge.ensure(8,'chatgpt'),/旧版.*ChatGPT|ChatGPT.*旧版/);assert.equal(f.injections.length,0);
});
