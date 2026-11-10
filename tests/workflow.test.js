const {test}=require('node:test');const assert=require('node:assert/strict');
const {VideoWorkflow}=require('../video-workflow.js');
function fixture(result){
 const sent=[],released=[];let resolveTarget;
 const client={resolve:async()=>result,readAsset:async a=>({name:a+'.jpg',mime:'image/jpeg',base64:'YWJj'}),release:async a=>released.push(...a),close(){},cancel(){}};
 const deps={identify:require('../platforms').identify,toSrt:require('../platforms').toSrt,normalize:s=>s||{enabled:false},getTab:async()=>({url:'https://www.youtube.com/watch?v=abc123XYZ_0'}),client:()=>client,
 lock(){},unlock(){},existing:()=>null,sendChatGPT:async data=>{sent.push(data);await new Promise(r=>resolveTarget=r);},sendAIStudio:async data=>{sent.push(data);return {transcript:'1\n00:00:00,000 --> 00:00:10,000\nfixture complete'};},transcribe:async()=>'',cancelTarget(){}};
 return {workflow:new VideoWorkflow(deps),deps,client,sent,released,complete:()=>resolveTarget()};
}
test('Douyin passes only current browser original-video snapshot into native acquisition',async()=>{
 const id='7695816752525053222',url='https://www.douyin.com/jingxuan/knowledge?modal_id='+id;
 const result={platform:'douyin',videoId:id,title:'current',duration:10,audio:{assetId:'aud'},images:[]};const f=fixture(result);let request;
 f.deps.getTab=async()=>({url});f.deps.snapshot=async()=>({platform:'douyin',videoId:id,title:'current',duration:10,douyin:{videoId:id,videoUrl:'https://v9.douyinvod.com/current.mp4'}});f.client.resolve=async r=>{request=r;return result;};
 const task=f.workflow.start({openerTabId:1,sourceUrl:url,source:{platform:'douyin',videoId:id}},()=>{});
 await new Promise(r=>setImmediate(r));f.complete();await task;
 assert.equal(request.source.douyin.videoUrl,'https://v9.douyinvod.com/current.mp4');assert.equal(f.sent.length,2);assert.match(f.sent[1].file.content,/fixture complete/);assert.deepEqual(f.released,['aud']);
});
test('switching work during browser snapshot prevents native download and send',async()=>{
 let current='https://www.douyin.com/video/111',release,reached;const gate=new Promise(r=>release=r),waiting=new Promise(r=>reached=r);const f=fixture({images:[]});let downloads=0;
 f.deps.getTab=async()=>({url:current});f.deps.snapshot=async()=>{reached();await gate;return null;};f.client.resolve=async()=>{downloads++;return {images:[]};};
 const running=f.workflow.start({openerTabId:1,sourceUrl:current},()=>{});await waiting;current='https://www.douyin.com/video/222';release();await assert.rejects(running,/源视频已切换/);assert.equal(downloads,0);assert.equal(f.sent.length,0);
});
test('captions and pictures use ChatGPT; assets remain until upload acknowledged',async()=>{
 const f=fixture({subtitle:{body:[{from:0,to:1,content:'hi'}]},images:[{assetId:'img'}],videoId:'abc123XYZ_0',title:'title',platform:'youtube'});
 const task=f.workflow.start({openerTabId:1,sourceUrl:'https://www.youtube.com/watch?v=abc123XYZ_0'},()=>{});
 await new Promise(r=>setImmediate(r));assert.equal(f.sent.length,1);assert.equal(f.sent[0].attachments.length,2);assert.deepEqual(f.released,[]);
 f.complete();await task;assert.deepEqual(f.released,['img']);
});
test('source changes abort before sending old content',async()=>{
 const f=fixture({subtitle:{body:[{from:0,to:1,content:'hi'}]},images:[],videoId:'abc123XYZ_0',platform:'youtube'});
 f.workflow.deps.getTab=async()=>({url:'https://www.youtube.com/watch?v=NEW123XYZ_0'});
 await assert.rejects(()=>f.workflow.start({openerTabId:1,sourceUrl:'https://www.youtube.com/watch?v=abc123XYZ_0'},()=>{}),/视频已切换/);assert.equal(f.sent.length,0);
});
test('empty transcription does not send and always releases assets',async()=>{
 const f=fixture({subtitle:null,audio:{assetId:'aud'},images:[],videoId:'abc123XYZ_0',platform:'youtube'});
 await assert.rejects(()=>f.workflow.start({openerTabId:1,sourceUrl:'https://www.youtube.com/watch?v=abc123XYZ_0',transcribeService:'local'},()=>{}),/转写结果为空/);
 assert.equal(f.sent.length,0);assert.deepEqual(f.released,['aud']);
});

test('AI Studio failure or missing transcript never reaches ChatGPT',async()=>{
 for(const response of [null,{}]){
  const f=fixture({audio:{assetId:'aud'},images:[],videoId:'abc123XYZ_0',platform:'youtube'});
  f.deps.sendAIStudio=async()=>response;
  await assert.rejects(f.workflow.start({openerTabId:1,sourceUrl:'https://www.youtube.com/watch?v=abc123XYZ_0'}),/未返回完整逐字稿/);
  assert.equal(f.sent.length,0);assert.deepEqual(f.released,['aud']);
 }
});
test('switching video while AI Studio generates prevents forwarding its transcript',async()=>{
 const url='https://www.youtube.com/watch?v=abc123XYZ_0';let current=url;
 const f=fixture({audio:{assetId:'aud'},images:[],videoId:'abc123XYZ_0',platform:'youtube'});
 f.deps.getTab=async()=>({url:current});
 f.deps.sendAIStudio=async()=>{current='https://www.youtube.com/watch?v=NEW123XYZ_0';return {transcript:'some SRT'};};
 await assert.rejects(f.workflow.start({openerTabId:1,sourceUrl:url}),/源视频已切换/);
 assert.equal(f.sent.length,0);assert.deepEqual(f.released,['aud']);
});
