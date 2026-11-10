const {test}=require('node:test');const assert=require('node:assert/strict');
const lib=require('../video-library.js');
const ID='11111111-2222-4333-8444-555555555555';
const source={url:'https://www.bilibili.com/video/BV1xx411c7mD/?p=2&spm_id_from=share',title:'视频',coverUrl:'https://i0.hdslb.com/test.jpg',platform:'bilibili',videoId:'BV1xx411c7mD'};
function fixture(){let values={};const sent=[];return {sent,values,api:{runtime:{sendMessage:async(id,msg)=>{sent.push({id,msg});return msg.type==='ZHIXING_VIDSIFT_HELLO'?{ok:true,protocol:'zhixing-video-library',version:1}:{ok:true,id:msg.record.id};}},storage:{local:{get:async(keys)=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,values[k]])),set:async(v)=>Object.assign(values,structuredClone(v))}},tabs:{get:async id=>({id,url:`https://chatgpt.com/c/${ID}`})}}};}
test('stable conversation identity rejects temporary, foreign and credential URLs',()=>{
 assert.equal(lib.conversationUrl(`https://chatgpt.com/c/${ID}?x=1`),`https://chatgpt.com/c/${ID}`);
 for(const x of ['https://evil.com/c/'+ID,'https://user@chatgpt.com/c/'+ID,'https://chatgpt.com/?temporary-chat=true','http://chatgpt.com/c/'+ID])assert.equal(lib.conversationUrl(x),null);
});
test('source canonicalization preserves part and removes tracking',()=>{
 const r=lib.makeRecord(source,`https://chatgpt.com/c/${ID}`,{now:()=>0});
 assert.equal(r.id,ID);assert.equal(r.videoUrl,'https://www.bilibili.com/video/BV1xx411c7mD?p=2');assert.equal(r.title,'视频');
 assert.equal('body' in r,false);
});
test('temporary tasks neither register nor queue nor contact the library',async()=>{
 const f=fixture(),bridge=new lib.VideoLibraryBridge(f.api);
 await bridge.register({taskId:'temp',tabId:1,source,tempChat:true});await bridge.submitted('temp',{tab:{id:1}},`https://chatgpt.com/c/${ID}`);
 assert.equal(f.sent.length,0);assert.equal((await bridge.status()).pending,0);
});
test('persistent send is durably queued, correct ack removes it, replays are idempotent',async()=>{
 const f=fixture(),bridge=new lib.VideoLibraryBridge(f.api,{cover:async()=>'data:image/png;base64,aGVsbG8='});
 await bridge.register({taskId:'a',tabId:1,source,tempChat:false});
 await bridge.submitted('a',{tab:{id:2}},`https://chatgpt.com/c/${ID}`);assert.equal(f.sent.length,0);
 await bridge.submitted('a',{tab:{id:1}});await bridge.confirmed('a',{tab:{id:1}},`https://chatgpt.com/c/${ID}`);
 assert.equal((await bridge.status()).pending,1);assert.equal(f.sent.length,0);
 await bridge.drain();assert.equal((await bridge.status()).pending,0);assert.equal(f.sent.at(-1).msg.record.id,ID);
});
test('failed external handoff survives worker restart and never sends summary again',async()=>{
 const f=fixture();f.api.runtime.sendMessage=async()=>{throw Error('receiver unavailable');};
 let bridge=new lib.VideoLibraryBridge(f.api,{cover:async()=>'data:image/png;base64,aGVsbG8='});await bridge.register({taskId:'a',tabId:1,source,tempChat:false});
 await bridge.submitted('a',{tab:{id:1}});await bridge.confirmed('a',{tab:{id:1}},`https://chatgpt.com/c/${ID}`);await bridge.drain();assert.equal((await bridge.status()).pending,1);
 bridge=new lib.VideoLibraryBridge(f.api,{cover:async()=>'data:image/png;base64,aGVsbG8='});assert.equal((await bridge.status()).pending,1);
 f.api.runtime.sendMessage=async(_id,msg)=>msg.type==='ZHIXING_VIDSIFT_HELLO'?{ok:true,protocol:'zhixing-video-library',version:1}:{ok:true,id:msg.record.id};
 await bridge.drain();assert.equal((await bridge.status()).pending,0);
});
test('arbitrary URL changes cannot bind a submitted task to an old conversation',async()=>{
 const f=fixture(),bridge=new lib.VideoLibraryBridge(f.api,{cover:async()=>'data:image/png;base64,aGVsbG8='});
 await bridge.register({taskId:'a',tabId:1,source,tempChat:false});
 await bridge.submitted('a',{tab:{id:1}},`https://chatgpt.com/c/${ID}`);assert.equal((await bridge.status()).pending,0);
 await bridge.confirmed('a',{tab:{id:2}},`https://chatgpt.com/c/${ID}`);assert.equal((await bridge.status()).pending,0);
 await bridge.confirmed('a',{tab:{id:1}},`https://chatgpt.com/c/${ID}`);assert.equal((await bridge.status()).pending,1);
});
test('unconfirmed receiver ack and disabled linkage retain pending record',async()=>{
 const f=fixture(),bridge=new lib.VideoLibraryBridge(f.api,{cover:async()=>'data:image/png;base64,aGVsbG8='});await bridge.register({taskId:'a',tabId:1,source,tempChat:false});await bridge.submitted('a',{tab:{id:1}});await bridge.confirmed('a',{tab:{id:1}},`https://chatgpt.com/c/${ID}`);
 f.api.runtime.sendMessage=async(_id,msg)=>msg.type==='ZHIXING_VIDSIFT_HELLO'?{ok:true,protocol:'zhixing-video-library',version:1}:{ok:true,id:'wrong'};await bridge.drain();assert.equal((await bridge.status()).pending,1);
 f.values.videoLibrarySettings={enabled:false};await bridge.drain();assert.equal((await bridge.status()).pending,1);
});
test('cover download refuses off-platform, svg, oversized and redirects',async()=>{
 let calls=0;const fetcher=async()=>{calls++;return {ok:true,url:'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg',headers:new Headers({'content-type':'image/svg+xml'}),arrayBuffer:async()=>new ArrayBuffer(4)};};
 await assert.rejects(()=>lib.downloadCover('https://evil.test/x.jpg',fetcher));assert.equal(calls,0);
 await assert.rejects(()=>lib.downloadCover('https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg',fetcher));
});

test('missing covers rotate fairly instead of starving the sixth saved card',async()=>{
 const f=fixture(),bridge=new lib.VideoLibraryBridge(f.api,{cover:async()=>''});
 for(let i=0;i<6;i++){const id=String(i)+'1111111-2222-4333-8444-555555555555';await bridge.register({taskId:String(i),tabId:i,source,tempChat:false});await bridge.submitted(String(i),{tab:{id:i}});await bridge.confirmed(String(i),{tab:{id:i}},'https://chatgpt.com/c/'+id);}
 await bridge.drain();await bridge.drain();const ids=new Set(f.sent.filter(x=>x.msg.record).map(x=>x.msg.record.id));assert.equal(ids.size,6);
});

test('twenty acknowledged cover failures never consume unsaved capacity',async()=>{
 const f=fixture(),bridge=new lib.VideoLibraryBridge(f.api,{cover:async()=>''});
 for(let i=0;i<25;i++){const id=String(i).padStart(8,'0')+'-2222-4333-8444-555555555555';await bridge.register({taskId:String(i),tabId:i,source,tempChat:false});await bridge.submitted(String(i),{tab:{id:i}});await bridge.confirmed(String(i),{tab:{id:i}},'https://chatgpt.com/c/'+id);await bridge.drain();}
 const ids=new Set(f.sent.filter(x=>x.msg.record).map(x=>x.msg.record.id));assert.equal(ids.size,25);const status=await bridge.status();assert.equal(status.unsaved,0);assert.equal(status.coverPending,20);
});
