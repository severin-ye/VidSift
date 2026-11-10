const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function fixture(){
 const listeners=new Set(),runtimeListeners=[],timers=new Map(),posts=[],forwarded=[];let downloads=0,nextId=0;
 const window={addEventListener(type,fn){assert.equal(type,'message');listeners.add(fn);},removeEventListener(type,fn){listeners.delete(fn);},postMessage(data){posts.push(data);queueMicrotask(()=>{for(const fn of [...listeners])Promise.resolve(fn({source:window,data})).catch(e=>{throw e;});});}};
 const clock={setTimeout(fn,ms){assert.ok(ms>=1000&&ms<=1500);const id=++nextId;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);}};
 const isolated=vm.createContext({window,...clock,crypto:{randomUUID:()=>`request-${++nextId}`},chrome:{runtime:{onMessage:{addListener:fn=>runtimeListeners.push(fn)},sendMessage:async msg=>{forwarded.push(msg);}}}});
 const main=vm.createContext({window,URL,Uint8Array,btoa:s=>Buffer.from(s,'binary').toString('base64'),fetch:async()=>{downloads++;let consumed=false;return {ok:true,headers:{get:()=> '3'},body:{getReader:()=>({read:async()=>consumed?{done:true}:(consumed=true,{done:false,value:Uint8Array.from([1,2,3])})})}};}});
 const inject=(file,context)=>vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),context);
 const dispatch=msg=>new Promise(resolve=>{let async=false;for(const fn of runtimeListeners)if(fn(msg,{},resolve)===true)async=true;if(!async)resolve(undefined);});
 return {listeners,runtimeListeners,timers,posts,forwarded,isolated,main,window,dispatch,get downloads(){return downloads;},injectIsolated:()=>inject('bilibili-content.js',isolated),injectMain:()=>inject('bilibili-content-main.js',main)};
}
const flush=()=>new Promise(r=>setImmediate(r));
test('reinjecting both source worlds is safe with legacy global lets and downloads once using V2 protocol',async()=>{
 const f=fixture();vm.runInContext('let _activeRequestId=null; let _overlay=null; let _overlayText=null; let _overlayClose=null;',f.isolated);
 f.injectIsolated();f.injectMain();f.injectIsolated();f.injectMain();assert.equal(f.runtimeListeners.length,1);assert.equal(f.listeners.size,2);
 const result=await f.dispatch({type:'VIDSIFT_BILI_V2_FETCH_AUDIO',urls:['https://cdn.test/audio']});
 assert.equal(result.ok,true);assert.equal(result.data,'AQID');assert.equal(f.downloads,1);assert.equal(f.forwarded.length,1);assert.equal(f.forwarded[0].type,'VIDSIFT_BILI_V2_FETCH_PROGRESS');assert.equal(f.listeners.size,2);
});
test('new MAIN and isolated bridges ignore original and old VidSift audio messages',async()=>{
 const f=fixture();f.injectIsolated();f.injectMain();
 for(const type of ['BILIBILI_FETCH_AUDIO','VIDSIFT_BILIBILI_FETCH_AUDIO']){assert.equal(await f.dispatch({type,urls:['https://cdn.test/audio']}),undefined);f.window.postMessage({type,urls:['https://cdn.test/audio'],requestId:'old'});}
 await flush();assert.equal(f.downloads,0);assert.equal(f.posts.filter(x=>x.type.endsWith('FETCH_RESULT')).length,0);
});
test('MAIN readiness ping returns matching acknowledgement without downloading and clears timeout/listener',async()=>{
 const f=fixture();f.injectIsolated();f.injectMain();const base=f.listeners.size;
 const result=await f.dispatch({type:'VIDSIFT_BILI_PING'});assert.equal(result.ok,true);assert.equal(result.component,'bilibili');assert.equal(result.mainReady,true);assert.equal(f.downloads,0);assert.equal(f.timers.size,0);assert.equal(f.listeners.size,base);
});
test('missing MAIN yields actionable error and clears timer/listener; unrelated acknowledgements do not satisfy ping',async()=>{
 const f=fixture();f.injectIsolated();const base=f.listeners.size,pending=f.dispatch({type:'VIDSIFT_BILI_PING'});
 f.window.postMessage({type:'VIDSIFT_BILI_MAIN_READY',requestId:'unrelated'});await flush();assert.equal(f.timers.size,1);assert.equal(f.listeners.size,base+1);
 for(const fn of [...f.timers.values()])fn();const result=await pending;assert.equal(result.ok,false);assert.equal(result.component,'bilibili');assert.match(result.error,/桥接脚本未就绪.*刷新/);assert.equal(f.timers.size,0);assert.equal(f.listeners.size,base);assert.equal(f.downloads,0);
});
