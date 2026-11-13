const {test}=require('node:test');
const assert=require('node:assert/strict');
const BiliCompanion=require('../bili-companion.js');

test('Chrome can resolve navigation while live URL remains about:blank until commit',async()=>{
 const f=fakeChrome(),b=new BiliCompanion(f.chrome);await b.enqueue(source());
 const current=(await b.status()).current;
 const tab=f.tabs.get(current.tabId),destination=tab.url;
 tab.url='about:blank';tab.pendingUrl=destination;
 await b.onUpdated(tab.id,{status:'complete',url:'about:blank'},{...tab});
 assert.equal((await b.status()).current.tabId,tab.id);
 assert.equal((await b.handleMessage({type:'VIDSIFT_COMPANION_CLAIM'},sender(f,tab.id))).ok,false);
 tab.url=destination;delete tab.pendingUrl;await b.onUpdated(tab.id,{url:destination},{...tab});
 assert.equal((await b.handleMessage({type:'VIDSIFT_COMPANION_CLAIM'},sender(f,tab.id))).ok,true);
 tab.url='about:blank';await b.onUpdated(tab.id,{url:'about:blank'},{...tab});
 assert.equal((await b.status()).current,null);
});

test('official simplified/traditional locale redirect retains the same video and part',async()=>{
 const f=fakeChrome(),b=new BiliCompanion(f.chrome);await b.enqueue(source('BVlocale',2));
 const tab=f.tabs.get((await b.status()).current.tabId);
 for(const locale of ['zh-Hans','zh-Hant']){
  tab.url=`https://www.bilibili.com/${locale}/video/BVlocale/?p=2`;
  await b.onUpdated(tab.id,{url:tab.url},{...tab});
  assert.equal((await b.handleMessage({type:'VIDSIFT_COMPANION_CLAIM'},sender(f,tab.id))).ok,true);
 }
 await b.handleMessage({type:'VIDSIFT_COMPANION_EVENT',event:'progress',position:0,url:tab.url},sender(f,tab.id));
 assert.equal((await b.status()).current.state,'loading','zero position cannot claim playback is advancing');
});
const source=(id='BV123abc',part=1)=>({platform:'bilibili',videoId:id,part,title:'test'});
function fakeChrome(){
 const local={},session={},tabs=new Map(),calls=[];let seq=10;
 const area=data=>({get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,structuredClone(data[key])])),set:async values=>Object.assign(data,structuredClone(values))});
 const chrome={runtime:{id:'extension'},storage:{local:area(local),session:area(session)},alarms:{create:async(...args)=>calls.push(['alarm',...args]),clear:async()=>{}},tabs:{
  create:async options=>{calls.push(['create',options]);const tab={...options,id:++seq};tabs.set(tab.id,tab);return {...tab};},
  update:async(id,options)=>{calls.push(['update',id,options]);if(!tabs.has(id))throw Error('no tab');Object.assign(tabs.get(id),options);return {...tabs.get(id)};},
  get:async id=>{if(!tabs.has(id))throw Error('missing');return {...tabs.get(id)};},
  remove:async id=>{calls.push(['remove',id]);tabs.delete(id);}
 }};
 return {chrome,local,session,tabs,calls};
}
function sender(f,id){const tab=f.tabs.get(id);return {id:'extension',frameId:0,url:tab.url,tab:{...tab}};}
async function event(b,f,name,extra={}){const current=(await b.status()).current;return b.handleMessage({type:'VIDSIFT_COMPANION_EVENT',event:name,url:current.source.url,...extra},sender(f,current.tabId));}
test('background tab is muted before navigation and only one official page plays',async()=>{
 const f=fakeChrome(),b=new BiliCompanion(f.chrome);await b.enqueue(source());await b.enqueue(source('BVother'));
 const calls=f.calls.filter(x=>['create','update'].includes(x[0]));
 assert.deepEqual(calls[0],['create',{url:'about:blank',active:false}]);
 assert.deepEqual(calls[1][2],{muted:true,autoDiscardable:false});assert.match(calls[2][2].url,/BV123abc/);
 assert.equal(f.tabs.size,1);assert.equal((await b.status()).queued,1);
});
test('deduplicates active and queued parts and reports queue capacity',async()=>{
 const f=fakeChrome(),b=new BiliCompanion(f.chrome);
 await b.enqueue(source());assert.equal((await b.enqueue(source())).duplicate,true);
 await b.enqueue(source('BVnext'));assert.equal((await b.enqueue(source('BVnext'))).duplicate,true);
 for(let i=0;i<48;i++)await b.enqueue(source(`BVitem${i}`));
 assert.equal((await b.enqueue(source('BVfull'))).ok,false);assert.equal((await b.status()).queued,49);
});
test('only own tab, extension, main frame and exact BVID/part can claim or finish',async()=>{
 const f=fakeChrome(),b=new BiliCompanion(f.chrome);await b.enqueue(source());const current=(await b.status()).current;
 const valid=sender(f,current.tabId);
 assert.equal((await b.handleMessage({type:'VIDSIFT_COMPANION_CLAIM'},valid)).ok,true);
 for(const wrong of [{...valid,id:'foreign'},{...valid,frameId:1},{...valid,url:'https://www.bilibili.com/video/BVother'},{...valid,tab:{...valid.tab,id:999}},{...valid,url:valid.url.replace('p=1','p=2')}])assert.equal((await b.handleMessage({type:'VIDSIFT_COMPANION_CLAIM'},wrong)).ok,false);
 assert.equal((await event(b,f,'ended',{duration:100,position:5})).ok,false);assert.equal(f.tabs.size,1);
});
test('ended advances queue and distinguishes playback from history confirmation',async()=>{
 const f=fakeChrome(),b=new BiliCompanion(f.chrome);await b.enqueue(source());await b.enqueue(source('BVnext'));
 const old=(await b.status()).current.tabId;await event(b,f,'ended',{duration:100,position:100});
 const status=await b.status();assert.equal(status.last.state,'player-ended');assert.equal(status.last.historyConfirmed,false);
 assert.equal(status.current.source.videoId,'BVnext');assert.equal(f.tabs.has(old),false);assert.equal(f.tabs.size,1);
});
test('disable and stop serialize with enqueues without reopening a tab',async()=>{
 const f=fakeChrome(),b=new BiliCompanion(f.chrome);
 await Promise.all([b.enqueue(source()),b.enqueue(source('BVnext')),b.setEnabled(false)]);
 assert.equal(f.tabs.size,0);assert.equal((await b.status()).queued,0);assert.equal((await b.enqueue(source('BVdisabled'))).ok,false);
 await b.setEnabled(true);await Promise.all([b.enqueue(source()),b.stopAll()]);assert.equal(f.tabs.size,0);
});
test('worker reconstruction restores identity and queue without creating another page',async()=>{
 const f=fakeChrome(),b=new BiliCompanion(f.chrome);await b.enqueue(source());await b.enqueue(source('BVnext'),{tempChat:true});
 const id=(await b.status()).current.tabId;const restored=new BiliCompanion(f.chrome);await restored.ready;
 assert.equal((await restored.status()).current.tabId,id);assert.equal((await restored.status()).queued,1);assert.equal(f.tabs.size,1);
 assert.equal(JSON.stringify(f.local).includes('BVnext'),false);
 await event(restored,f,'ended',{duration:10,position:10});assert.equal((await restored.status()).current.source.videoId,'BVnext');
});
test('user close, navigation and activation stop item without reopening or controlling ordinary pages',async()=>{
 for(const action of ['close','navigate','activate']){
  const f=fakeChrome(),b=new BiliCompanion(f.chrome);await b.enqueue(source());const id=(await b.status()).current.tabId;
  await b.onRemoved(999);await b.onActivated({tabId:999});await b.onUpdated(999,{url:'https://example.com'},{});assert.equal((await b.status()).current.tabId,id);
  if(action==='close'){f.tabs.delete(id);await b.onRemoved(id);}
  if(action==='navigate'){f.tabs.get(id).url='https://example.com';await b.onUpdated(id,{url:'https://example.com'},f.tabs.get(id));}
  if(action==='activate'){f.tabs.get(id).active=true;await b.onActivated({tabId:id});}
  assert.equal((await b.status()).current,null);assert.equal(f.calls.filter(x=>x[0]==='create').length,1);
  if(action!=='close')assert.equal(f.tabs.has(id),true);
 }
});
test('creation and playback failures are not completion and advance the next item',async()=>{
 const f=fakeChrome(),b=new BiliCompanion(f.chrome);f.chrome.tabs.create=async()=>{throw Error('blocked');};
 await b.enqueue(source());assert.equal((await b.status()).last.state,'failed');assert.equal((await b.status()).current,null);
 const g=fakeChrome(),c=new BiliCompanion(g.chrome);await c.enqueue(source());await c.enqueue(source('BVnext'));await event(c,g,'failed',{reason:'play rejected'});
 assert.equal((await c.status()).last.state,'failed');assert.equal((await c.status()).current.source.videoId,'BVnext');
});
test('bounded alarm failure expires loading/stalled item, progress extends deadline',async()=>{
 const f=fakeChrome(),b=new BiliCompanion(f.chrome);await b.enqueue(source());
 b.current.deadline=0;await event(b,f,'progress',{position:1});assert.ok(b.current.deadline>Date.now());
 b.current.deadline=0;await b.onAlarm({name:'vidsift-bili-companion'});assert.equal((await b.status()).last.state,'failed');assert.equal(f.tabs.size,0);
});
test('manual pause releases page and never forces playback resume',async()=>{
 const f=fakeChrome(),b=new BiliCompanion(f.chrome);await b.enqueue(source());await event(b,f,'paused');
 assert.equal((await b.status()).current,null);assert.equal(f.tabs.size,1);
});
test('stale about:blank update cannot stop a page already navigated',async()=>{
 const f=fakeChrome(),b=new BiliCompanion(f.chrome);await b.enqueue(source());const id=(await b.status()).current.tabId;
 await b.onUpdated(id,{url:'about:blank'},{id,url:'about:blank'});assert.equal((await b.status()).current.tabId,id);
});
const vm=require('node:vm'),fs=require('node:fs');
async function contentHarness({owned=true,rejectPlay=false,rejectProgress=false,disconnect=false}={}){
 class Target{constructor(){this.handlers={};}addEventListener(n,h){(this.handlers[n]??=[]).push(h);}removeEventListener(n,h){this.handlers[n]=(this.handlers[n]||[]).filter(x=>x!==h);}emit(n){for(const h of [...(this.handlers[n]||[])])h({target:this});}}
 const video=new Target();Object.assign(video,{muted:false,playbackRate:2,currentTime:7,duration:10,readyState:1,ended:false,plays:0,pauses:0,play(){this.plays++;return rejectPlay?Promise.reject(Error('autoplay blocked')):Promise.resolve();},pause(){this.pauses++;}});
 const window=new Target();window.top=window;let tick;const messages=[],runtimeListeners=[];
 const context={window,document:Object.assign(new Target(),{querySelector:()=>video}),location:{href:'https://www.bilibili.com/video/BV123abc?p=1'},URL,Date,setTimeout,clearTimeout,setInterval:fn=>(tick=fn,1),clearInterval:()=>{},chrome:{runtime:{onMessage:{addListener:fn=>runtimeListeners.push(fn),removeListener:()=>{}},sendMessage:async message=>{messages.push(message);if(message.event==='progress'&&disconnect)throw Error('Extension context invalidated');return message.type==='VIDSIFT_COMPANION_CLAIM'?{ok:owned,source:source()}:{ok:!(message.event==='progress'&&rejectProgress)};}}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../bili-companion-content.js'),'utf8'),context);await new Promise(resolve=>setImmediate(resolve));
 return {video,messages,context,release:()=>runtimeListeners.forEach(fn=>fn({type:'VIDSIFT_COMPANION_RELEASE'})),tick:async()=>{await tick?.();await new Promise(resolve=>setImmediate(resolve));}};
}
test('content does nothing on ordinary page; claimed page plays muted at 1x from start',async()=>{
 const ordinary=await contentHarness({owned:false});await ordinary.tick();assert.equal(ordinary.video.plays,0);assert.equal(ordinary.video.muted,false);
 const own=await contentHarness();await own.tick();assert.equal(own.video.plays,1);assert.equal(own.video.muted,true);assert.equal(own.video.playbackRate,1);assert.equal(own.video.currentTime,0);
 own.release();await own.tick();assert.equal(own.video.pauses,0);
});
test('content reports rejected playback honestly and pauses ended player immediately',async()=>{
 const bad=await contentHarness({rejectPlay:true});await bad.tick();assert.equal(bad.messages.at(-1).event,'failed');
 const own=await contentHarness();await own.tick();own.video.currentTime=10;own.video.ended=true;own.video.emit('ended');await new Promise(resolve=>setImmediate(resolve));
 assert.equal(own.messages.at(-1).event,'ended');assert.equal(own.video.pauses,1);
});
test('content pauses on rejected or disconnected progress response and throttles reporting',async()=>{
 for(const options of [{rejectProgress:true},{disconnect:true}]){
  const own=await contentHarness(options);await own.tick();assert.equal(own.video.pauses,1);
 }
 const own=await contentHarness();await own.tick();for(let i=0;i<5;i++)await own.tick();
 assert.equal(own.messages.filter(x=>x.event==='progress').length,1);
});
test('ended keeps official page alive for reporting and pending stop prevents next tab',async()=>{
 const f=fakeChrome(),b=new BiliCompanion(f.chrome);await b.enqueue(source());await b.enqueue(source('BVnext'));
 const current=(await b.status()).current;const ending=b.handleMessage({type:'VIDSIFT_COMPANION_EVENT',event:'ended',url:current.source.url,duration:10,position:10},sender(f,current.tabId));
 await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.tabs.has(current.tabId),true);
 const stopping=b.stopAll();await Promise.all([ending,stopping]);assert.equal(f.tabs.size,0);assert.equal(f.calls.filter(x=>x[0]==='create').length,1);
 assert.equal(JSON.stringify(f.local).includes('BV123abc'),false);assert.equal(JSON.stringify(f.local).includes('sourceKey'),false);
});
test('tab unmute restores silence and releases the owned page without restarting',async()=>{
 const f=fakeChrome(),b=new BiliCompanion(f.chrome);await b.enqueue(source());const id=(await b.status()).current.tabId;
 await b.onUpdated(id,{mutedInfo:{muted:false}},f.tabs.get(id));assert.equal((await b.status()).current,null);assert.equal(f.tabs.has(id),true);
 assert.deepEqual(f.calls.filter(x=>x[0]==='update').at(-1)[2],{muted:true});
});
