const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function event(){const listeners=new Set();return {addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f),fire:(...args)=>{for(const f of [...listeners])f(...args);}};}
function fixture(){let id=54;const removed=[],tabs=new Map(),onActivated=event(),onUpdated=event(),onRemoved=event();const chrome={runtime:{onMessage:event()},tabs:{onActivated,onUpdated,onRemoved,query:async()=>[],create:async()=>{const tab={id:++id,url:'https://chatgpt.com/',active:false,status:'complete'};tabs.set(tab.id,tab);return tab;},get:async id=>tabs.get(id),remove:async id=>{removed.push(id);tabs.delete(id);},sendMessage:async()=>({ok:true})},scripting:{executeScript:async()=>[]}};const ctx=vm.createContext({chrome,setTimeout,clearTimeout,URL,console});vm.runInContext(fs.readFileSync('background-summary-reminder.js','utf8'),ctx);return {ctx,chrome,tabs,removed,onActivated,onUpdated};}
test('failed injection never closes a helper the user has already taken over',async()=>{
 const f=fixture();f.chrome.scripting.executeScript=async()=>{const tab=f.tabs.get(55);tab.active=true;tab.url='https://chatgpt.com/c/11111111-2222-4333-8444-555555555555';f.onActivated.fire({tabId:55});f.onUpdated.fire(55,{url:tab.url});throw Error('injection failed after navigation');};
 await assert.rejects(()=>f.ctx.acquireSummaryReader());assert.deepEqual(f.removed,[]);
});
test('a helper once activated remains user-owned after switching back to the video',async()=>{
 const f=fixture(),reader=await f.ctx.acquireSummaryReader();f.onActivated.fire({tabId:reader.tabId});f.tabs.get(reader.tabId).active=false;await f.ctx.releaseSummaryReader(reader);assert.deepEqual(f.removed,[]);
});
test('a new borrower waits for closing helper and cannot borrow the old tab',async()=>{
 const f=fixture(),first=await f.ctx.acquireSummaryReader();let releaseGet;f.chrome.tabs.get=()=>new Promise(resolve=>releaseGet=()=>resolve(f.tabs.get(first.tabId)));
 const closing=f.ctx.releaseSummaryReader(first);let second;const acquiring=f.ctx.acquireSummaryReader().then(value=>second=value);await new Promise(r=>setTimeout(r,0));assert.equal(second,undefined);
 releaseGet();await closing;await acquiring;assert.notEqual(second.tabId,first.tabId);assert.deepEqual(f.removed,[first.tabId]);f.chrome.tabs.get=async id=>f.tabs.get(id);await f.ctx.releaseSummaryReader(second);
});
