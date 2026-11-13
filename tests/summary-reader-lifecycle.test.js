const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function event(){const listeners=new Set();return {addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f),fire:(...args)=>{for(const f of [...listeners])f(...args);}};}
function fixture(){let id=54;const removed=[],tabs=new Map(),onActivated=event(),onUpdated=event(),onRemoved=event();const chrome={runtime:{onMessage:event()},tabs:{onActivated,onUpdated,onRemoved,query:async()=>[],create:async()=>{const tab={id:++id,url:'https://chatgpt.com/',active:false,status:'complete'};tabs.set(tab.id,tab);return tab;},get:async id=>tabs.get(id),remove:async id=>{removed.push(id);tabs.delete(id);},sendMessage:async()=>({ok:true})},scripting:{executeScript:async()=>[]}};const ctx=vm.createContext({chrome,setTimeout,clearTimeout,URL,console,VidSiftPlatforms:{identify:()=>null}});vm.runInContext(fs.readFileSync('background-summary-reminder.js','utf8'),ctx);return {ctx,chrome,tabs,removed,onActivated,onUpdated};}
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
 f.chrome.tabs.get=async id=>f.tabs.get(id);releaseGet();await closing;await acquiring;assert.notEqual(second.tabId,first.tabId);assert.deepEqual(f.removed,[first.tabId]);await f.ctx.releaseSummaryReader(second);
});

test('reader works while unrelated page resources are still loading',async()=>{
 const f=fixture();f.chrome.tabs.create=async()=>{const tab={id:55,url:'https://chatgpt.com/',active:false,status:'loading'};f.tabs.set(55,tab);return tab;};
 let options;f.chrome.scripting.executeScript=async value=>{options=value;return [];};
 const result=await Promise.race([f.ctx.acquireSummaryReader(),new Promise(resolve=>setTimeout(()=>resolve(null),100))]);
 if(!result){f.tabs.get(55).status='complete';f.onUpdated.fire(55,{status:'complete'});}
 assert.ok(result,'API reader must not wait for whole-page load');assert.equal(options.injectImmediately,true);
 await f.ctx.releaseSummaryReader(result);
});

test('reader skips discarded or frozen tabs and prefers a recently used healthy page',async()=>{
 const f=fixture();const tabs=[{id:1,url:'https://chatgpt.com/c/old',status:'unloaded',discarded:true},{id:2,url:'https://chatgpt.com/c/frozen',status:'complete',frozen:true},{id:3,url:'https://chatgpt.com/c/ready',status:'complete',lastAccessed:20},{id:4,url:'https://chatgpt.com/c/recent',status:'complete',lastAccessed:30}];
 tabs.forEach(t=>f.tabs.set(t.id,t));f.chrome.tabs.query=async()=>tabs;
 const reader=await f.ctx.acquireSummaryReader();assert.equal(reader.tabId,4);await f.ctx.releaseSummaryReader(reader);assert.deepEqual(f.removed,[]);
});

test('failed existing reader falls back once to an owned page without changing user tabs',async()=>{
 const f=fixture();const old={id:1,url:'https://chatgpt.com/c/old',status:'complete'};f.tabs.set(1,old);f.chrome.tabs.query=async()=>[old];
 f.chrome.scripting.executeScript=async options=>{if(options.target.tabId===1)throw Error('unavailable old renderer');return [];};
 const reader=await f.ctx.acquireSummaryReader();assert.equal(reader.tabId,55);assert.equal(reader.owned,true);await f.ctx.releaseSummaryReader(reader);assert.deepEqual(f.removed,[55]);assert.equal(f.tabs.get(1),old);
});
