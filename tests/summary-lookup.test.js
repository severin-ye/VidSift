const {test}=require('node:test'),assert=require('node:assert/strict');
const {completedPage}=require('../summary-lookup.js');
const base='11111111-2222-4333-8444-55555555555',source={url:'https://www.bilibili.com/video/BV1xx411c7mD?p=2'};
const row=n=>({id:base+n,title:'视频',videoUrl:source.url,chatgptUrl:'https://chatgpt.com/c/'+base+n,createdAt:'2026-11-13T01:00:00Z',updatedAt:'2026-11-13T01:00:00Z'});
function fixture(){const calls=[];return {calls,config:{enabled:true,extensionId:'ajjcbhalcgpmelnmlnheefbfikdgmjdp'},external:async(_id,msg)=>{calls.push(msg);return msg.type==='ZHIXING_VIDSIFT_HELLO'?{ok:true,capabilities:['list-video-v1']}:{ok:true,records:[row(1),row(2),row(3)],total:3,nextCursor:null,basis:'local-projection'};},verify:async ids=>ids.map((id,i)=>({conversationId:id,status:['completed','pending','unknown'][i]}))};}
test('only verified complete records appear; unfinished and unknown counts stay distinct',async()=>{
 const f=fixture(),result=await completedPage({...f,source});assert.equal(result.records.length,1);assert.equal(result.records[0].id,row(1).id);assert.equal(result.pending,1);assert.equal(result.unknown,1);assert.equal(result.totalCandidates,3);assert.equal(result.nextCursor,null);
 assert.equal(f.calls[1].videoUrl,source.url);assert.equal(f.calls[1].limit,10);
});
test('old library cannot silently turn unsupported lookup into zero completed summaries',async()=>{
 const f=fixture();f.external=async()=>({ok:true,version:1});await assert.rejects(()=>completedPage({...f,source}),/更新.*书库/);
});
test('a record for another video or B站分P never enters verification or the list',async()=>{
 const f=fixture();let verified=false;f.external=async()=>({ok:true,capabilities:['list-video-v1'],records:[{...row(1),videoUrl:'https://www.bilibili.com/video/BV1xx411c7mD'}],total:1,nextCursor:null});f.verify=async()=>{verified=true;return [];};
 await assert.rejects(()=>completedPage({...f,source}),/视频.*不匹配/);assert.equal(verified,false);
});
test('cursor invalidation propagates and failed proof reader does not claim confirmed zero',async()=>{
 const f=fixture();f.external=async(_id,msg)=>msg.type==='ZHIXING_VIDSIFT_HELLO'?{ok:true,capabilities:['list-video-v1']}:{ok:false,code:'LIST_CHANGED',error:'列表已变化'};
 await assert.rejects(()=>completedPage({...f,source}),e=>e.code==='LIST_CHANGED');
 const g=fixture();g.verify=async()=>{throw Error('需要登录ChatGPT');};await assert.rejects(()=>completedPage({...g,source}),/登录/);
});
test('lookup off performs no external request; verified conversation identity must match',async()=>{
 const f=fixture();assert.equal((await completedPage({...f,source,config:{...f.config,reminderEnabled:false}})).disabled,true);assert.equal(f.calls.length,0);
 const g=fixture();g.verify=async()=>[{conversationId:'wrong',status:'completed'}];const result=await completedPage({...g,source});assert.equal(result.records.length,0);assert.equal(result.unknown,3);
});
