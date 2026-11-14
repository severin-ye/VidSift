const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const library=require('../video-library.js');
const first='11111111-1111-1111-1111-111111111111',second='22222222-2222-2222-2222-222222222222';
const url=id=>'https://chatgpt.com/c/'+id;
const row=id=>({id,chatgptUrl:url(id),videoUrl:'https://www.youtube.com/watch?v=abcdefghijk',title:'视频',createdAt:'2026-11-14T00:00:00Z'});
function fixture({external,initialUrl=url(first),enabled=true}={}){
 let handler,current={id:7,url:initialUrl},active=7,score=6;const calls=[],updates=[];
 const context=vm.createContext({URL,console,VidSiftVideoLibrary:library,_videoLibrary:{getSettings:async()=>({extensionId:'library',enabled,reminderEnabled:false})},summaryDeadline:p=>p,
 chrome:{tabs:{get:async()=>({...current}),query:async()=>[{id:active}],update:async(id,args)=>{updates.push(args.url);current.url=args.url;}},runtime:{id:'self',getURL:p=>'chrome-extension://self/'+p,onMessage:{addListener:fn=>handler=fn},sendMessage:async(id,msg)=>{
  calls.push(msg);if(external){const replacement=await external(msg,{setUrl:u=>current.url=u,setActive:id=>active=id});if(replacement!==undefined)return replacement;}
  if(msg.type==='ZHIXING_VIDSIFT_HELLO')return {ok:true,capabilities:['summary-context-v1','rate-video-v1']};
  if(msg.type==='ZHIXING_VIDSIFT_SET_VIDEO_RATING'){score=msg.score;return {ok:true,id:first,score};}
  return {ok:true,current:row(first),rating:score,records:[row(msg.cursor?second:first)],total:2,nextCursor:msg.cursor?null:'page2'};
 }}}});
 vm.runInContext(fs.readFileSync('background-summary-popup.js','utf8'),context);
 return {calls,updates,send:(extra={},sender={id:'self',url:'chrome-extension://self/popup.html'})=>new Promise(resolve=>handler({type:'VIDSIFT_POPUP_SUMMARY_CONTEXT',tabId:7,expectedUrl:initialUrl,...extra},sender,resolve))};
}
test('normal and custom GPT routes qualify, private credentials and unrelated URLs do not',()=>{
 const c={URL};vm.runInNewContext(fs.readFileSync('popup-summary.js','utf8'),c);const accepts=c.VidSiftSummaryPopup.conversationUrl;
 assert.ok(accepts(url(first)));assert.ok(accepts('https://chatgpt.com/g/g-abc/c/'+first));
 for(const bad of ['https://chatgpt.com/','https://evil.com/c/'+first,'https://me:secret@chatgpt.com/c/'+first,url(first)+'?temporary-chat=true'])assert.equal(accepts(bad),false);
});
test('context reads authoritative rating and forwards bounded pagination',async()=>{
 const f=fixture();const a=await f.send();assert.equal(a.rating,6);assert.equal(a.nextCursor,'page2');
 const b=await f.send({cursor:'page2'});assert.equal(b.records[0].id,second);assert.equal(b.nextCursor,null);assert.equal(f.calls.at(-1).limit,10);
});
test('rating and clear write through library without any local duplicate',async()=>{
 const f=fixture();assert.equal((await f.send({type:'VIDSIFT_POPUP_SUMMARY_RATE',score:9})).score,9);
 assert.equal((await f.send()).rating,9);assert.equal((await f.send({type:'VIDSIFT_POPUP_SUMMARY_RATE',score:null})).score,null);
 assert.equal((await f.send({type:'VIDSIFT_POPUP_SUMMARY_RATE',score:0})).ok,false);
});
test('equivalent GPT routes and query/hash keep the same conversation; linkage disabled is explicit',async()=>{
 for(const initialUrl of [url(first)+'/?model=x#tail','https://chatgpt.com/g/g-custom/c/'+first+'?model=x#tail'])assert.equal((await fixture({initialUrl}).send()).ok,true);
 const f=fixture({enabled:false});assert.equal((await f.send()).code,'LIBRARY_DISABLED');assert.equal(f.calls.length,0);
});
test('page senders and forged extension URLs are rejected without external calls',async()=>{
 const f=fixture();for(const sender of [{id:'self',url:'https://chatgpt.com/',tab:{id:7}},{id:'self',url:'chrome-extension://self/options.html'},{id:'other',url:'chrome-extension://self/popup.html'}])assert.equal((await f.send({},sender)).code,'FORBIDDEN');assert.equal(f.calls.length,0);
});
test('unknown member rejected; valid paginated member navigates same tab',async()=>{
 const f=fixture();assert.equal((await f.send({type:'VIDSIFT_POPUP_SUMMARY_OPEN',recordId:second})).ok,false);assert.equal(f.updates.length,0);
 assert.equal((await f.send({type:'VIDSIFT_POPUP_SUMMARY_OPEN',recordId:second,cursor:'page2'})).ok,true);assert.deepEqual(f.updates,[url(second)]);
});
for(const mode of ['SPA','active'])test(mode+' changes while query awaits reject delayed reads and writes',async()=>{
 const f=fixture({external:async(msg,state)=>{if(msg.type==='ZHIXING_VIDSIFT_SUMMARY_CONTEXT'){if(mode==='SPA')state.setUrl(url(second));else state.setActive(8);}}});
 assert.equal((await f.send({type:'VIDSIFT_POPUP_SUMMARY_RATE',score:10})).code,'STALE_TAB');assert.ok(!f.calls.some(m=>m.type==='ZHIXING_VIDSIFT_SET_VIDEO_RATING'));
});
test('old library, absent record and transport failure remain explicit unknowns',async()=>{
 for(const [type,result,pattern] of [['ZHIXING_VIDSIFT_HELLO',{ok:true,capabilities:[]},/版本/],['ZHIXING_VIDSIFT_SUMMARY_CONTEXT',{ok:false,code:'NOT_FOUND'},/尚未收录/]]){
  const f=fixture({external:async msg=>msg.type===type?result:undefined});const r=await f.send();assert.equal(r.ok,false);assert.match(r.error,pattern);assert.equal(r.rating,undefined);
 }
 const f=fixture({external:async()=>{throw Error('书库连接失败');}});assert.match((await f.send()).error,/连接失败/);
});
