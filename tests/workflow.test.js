const {test}=require('node:test');const assert=require('node:assert/strict');
const {VideoWorkflow}=require('../video-workflow.js');
function fixture(result){
 const sent=[],released=[];let resolveTarget;
 const client={resolve:async()=>result,readAsset:async a=>({name:a+'.jpg',mime:'image/jpeg',base64:'YWJj'}),readPcmWindow:async()=>{throw Error('unexpected PCM read in workflow orchestration test');},release:async a=>released.push(...a),close(){},cancel(){}};
 const deps={identify:require('../platforms').identify,toSrt:require('../platforms').toSrt,normalize:s=>s||{enabled:false},getTab:async()=>({url:'https://www.youtube.com/watch?v=abc123XYZ_0'}),client:()=>client,
 lock(){},unlock(){},existing:()=>null,sendChatGPT:async data=>{sent.push(data);await new Promise(r=>resolveTarget=r);},sendAIStudio:async data=>{sent.push(data);return {transcript:'1\n00:00:00,000 --> 00:00:10,000\nfixture complete'};},transcribe:async()=>'',cancelTarget(){}};
 return {workflow:new VideoWorkflow(deps),deps,client,sent,released,complete:()=>resolveTarget()};
}

test('Douyin local transcription reads bounded PCM through descriptor without reading whole audio',async()=>{
 const id='7703625319965543714',url='https://www.douyin.com/video/'+id;
 const localAudio={fingerprint:'a'.repeat(64),videoId:id,duration:301,sampleRate:16000};
 const f=fixture({platform:'douyin',videoId:id,duration:301,audio:{assetId:'aud'},audioInfo:{},localAudio,images:[]});
 f.deps.getTab=async()=>({url});let request,wholeReads=0,completed;
 f.client.resolve=async value=>{request=value;return {platform:'douyin',videoId:id,duration:301,audio:{assetId:'aud'},audioInfo:{},localAudio,images:[]};};
 f.client.readAsset=async()=>{wholeReads++;throw Error('whole audio must not be read');};
 f.client.finishLocalAudio=async(desc,status)=>{completed={desc,status};};
 f.deps.transcribe=async(audio,data)=>{assert.equal(audio,null);assert.deepEqual(data.localAudio,localAudio);return '1\n00:00:00,000 --> 00:00:01,000\n中文';};
 const running=f.workflow.start({openerTabId:1,sourceUrl:url,transcribeService:'local',localSettings:{maxDuration:3600}},()=>{});
 await new Promise(r=>setImmediate(r));if(f.sent.length)f.complete();await running;
 assert.equal(request.localTranscription,true);assert.equal(request.localSettings.maxDuration,3600);assert.equal(wholeReads,0);
 assert.equal(f.sent.length,1);assert.match(f.sent[0].file.content,/中文/);assert.equal(completed.status,'success');
});
test('Douyin Groq uses the Native descriptor and never reads whole audio into browser',async()=>{
 const id='7703625319965543714',url='https://www.douyin.com/video/'+id,localAudio={fingerprint:'a'.repeat(64),videoId:id,duration:301,sampleRate:16000};
 const result={platform:'douyin',videoId:id,duration:301,audio:{assetId:'aud'},audioInfo:{},localAudio,images:[]},f=fixture(result);f.deps.getTab=async()=>({url});
 f.client.readAsset=async()=>{throw Error('must not transfer whole audio');};let request;f.client.resolve=async value=>{request=value;return result;};
 f.deps.transcribe=async(audio,data)=>{assert.equal(audio,null);assert.equal(data.transcribeService,'groq');assert.equal(data.groqSettings.model,'whisper-large-v3-turbo');return '1\n00:00:00,000 --> 00:00:01,000\n完整文字';};
 const run=f.workflow.start({openerTabId:1,sourceUrl:url,transcribeService:'groq',groqSettings:{model:'whisper-large-v3-turbo'}});await new Promise(r=>setImmediate(r));assert.equal(request.localTranscription,true);assert.equal(f.sent.length,1);f.complete();await run;
 const failed=fixture(result);failed.deps.getTab=async()=>({url});failed.deps.transcribe=async()=>{throw Error('Groq限流，未改走其他服务');};await assert.rejects(failed.workflow.start({openerTabId:1,sourceUrl:url,transcribeService:'groq'}),/Groq限流/);assert.equal(failed.sent.length,0);assert.deepEqual(failed.released,['aud']);
});

test('failed local transcription preserves retry lease and never sends to GPT',async()=>{
 const id='7703625319965543714',url='https://www.douyin.com/video/'+id,localAudio={fingerprint:'a'.repeat(64),videoId:id,duration:5};
 const f=fixture({platform:'douyin',videoId:id,duration:5,audio:{assetId:'aud'},audioInfo:{},localAudio,images:[]});f.deps.getTab=async()=>({url});let outcome;
 f.client.finishLocalAudio=async(_,status)=>{outcome=status;};f.deps.transcribe=async()=>{throw Error('窗口转写失败');};
 await assert.rejects(f.workflow.start({openerTabId:1,sourceUrl:url,transcribeService:'local'}),/窗口转写失败/);
 assert.equal(outcome,'failed');assert.equal(f.sent.length,0);
});
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

test('workflow preserves raw title and subtitle filename while forwarding trusted platform',async()=>{
 const raw='【YouTube】原题 #学习 @作者';
 const f=fixture({subtitle:{body:[{from:0,to:1,content:'fixture'}]},images:[],videoId:'abc123XYZ_0',title:raw});
 const task=f.workflow.start({openerTabId:1,sourceUrl:'https://www.youtube.com/watch?v=abc123XYZ_0'});
 await new Promise(setImmediate);assert.equal(f.sent.length,1);
 assert.equal(f.sent[0].videoTitle,raw);assert.equal(f.sent[0].source.title,raw);
 assert.equal(f.sent[0].source.platform,'youtube');assert.equal(f.sent[0].file.name,'abc123XYZ_0_'+raw+'.srt');
 f.complete();await task;
});

const detachedURL='https://www.youtube.com/watch?v=abc123XYZ_0';
const detachedCaption=()=>({subtitle:{body:[{from:0,to:1,content:'fixture'}]},images:[],videoId:'abc123XYZ_0',platform:'youtube'});
test('source already closed before acquisition uses clicked URL and skips page access',async()=>{
 const f=fixture(detachedCaption());let request,reads=0;
 f.deps.getTab=async()=>{reads++;throw Error('unexpected lookup');};f.client.resolve=async r=>{request=r;return detachedCaption();};
 const run=f.workflow.start({openerTabId:1,sourceUrl:detachedURL,sourceClosed:true});await new Promise(setImmediate);
 assert.equal(f.sent.length,1);assert.equal(reads,0);assert.equal(request.url,detachedURL);assert.equal(f.sent[0].source.url,detachedURL);f.complete();await run;
});

test('source closes during acquisition, transcription or target upload without cancelling accepted task',async()=>{
 for(const phase of ['acquisition','transcription','upload']){
  const f=fixture(phase==='transcription'?{audio:{assetId:'aud'},images:[],videoId:'abc123XYZ_0'}:detachedCaption());
  const close=()=>{f.workflow.tasks.get(1).sourceClosed=true;f.deps.getTab=async()=>{throw Error('lookup after close');};};
  if(phase==='acquisition')f.client.resolve=async()=>{close();return detachedCaption();};
  if(phase==='transcription')f.deps.transcribe=async()=>{close();return 'complete transcript';};
  const run=f.workflow.start({openerTabId:1,sourceUrl:detachedURL,transcribeService:'selfhosted'});await new Promise(setImmediate);
  assert.equal(f.sent.length,1,phase);if(phase==='upload')close();f.complete();assert.equal((await run).ok,true);assert.equal(f.sent[0].source.url,detachedURL);
 }
});

test('modern missing-tab recognition is narrow and rechecks cancellation and task ownership after await',async()=>{
 const f=fixture(detachedCaption()),task={tabId:1,source:require('../platforms').identify(detachedURL),cancelled:false};f.workflow.tasks.set(1,task);
 f.deps.getTab=async()=>{throw Error('No tab with id: 1.');};await f.workflow.assertLive(task);assert.equal(task.sourceClosed,true);
 task.sourceClosed=false;f.deps.getTab=async()=>{throw Error('Extension context invalidated');};await assert.rejects(f.workflow.assertLive(task),/context invalidated/);assert.equal(task.sourceClosed,false);
 f.deps.getTab=async()=>{task.cancelled=true;throw Error('No tab with id: 1.');};await assert.rejects(f.workflow.assertLive(task),/取消/);
 task.cancelled=false;task.sourceClosed=true;f.workflow.tasks.set(1,{id:'replacement'});await assert.rejects(f.workflow.assertLive(task),/替代|取消/);
});

test('detached task still honors explicit cancellation and finally preserves replacement state',async()=>{
 const f=fixture(detachedCaption());let unlocks=0;f.deps.unlock=()=>unlocks++;
 const run=f.workflow.start({openerTabId:1,sourceUrl:detachedURL});await new Promise(setImmediate);
 const old=f.workflow.tasks.get(1);old.sourceClosed=true;assert.equal(f.workflow.cancel(1),true);
 const replacement={id:'newer'};f.workflow.tasks.set(1,replacement);f.complete();await assert.rejects(run,/取消/);
 assert.equal(f.workflow.tasks.get(1),replacement);assert.equal(unlocks,0);
});

test('all three platforms send full native descriptors to Groq and never fall back to AI Studio',async()=>{
 for(const [platform,id,url] of [['bilibili','BV1xyWt6JEUn','https://www.bilibili.com/video/BV1xyWt6JEUn'],['youtube','abc123XYZ_0','https://www.youtube.com/watch?v=abc123XYZ_0'],['douyin','7703625319965543714','https://www.douyin.com/video/7703625319965543714']]){
  const localAudio={fingerprint:'a'.repeat(64),videoId:id,platform,duration:200};
  const f=fixture({platform,videoId:id,title:'test',duration:200,localAudio,images:[]});f.deps.getTab=async()=>({url});let request;
  f.client.resolve=async value=>{request=value;return {platform,videoId:id,duration:200,localAudio,images:[]};};
  f.client.readAsset=async()=>{throw Error('must not read whole audio');};f.deps.sendAIStudio=async()=>{throw Error('must not call Google');};
  f.deps.transcribe=async(audio,data)=>{assert.equal(audio,null);assert.equal(data.localAudio.platform,platform);return '1\n00:00:00,000 --> 00:03:20,000\ncomplete';};
  const running=f.workflow.start({openerTabId:1,sourceUrl:url,transcribeService:'groq'});await new Promise(setImmediate);assert.equal(request.localTranscription,true);f.complete();await running;
  const failed=fixture({platform,videoId:id,duration:200,localAudio,images:[]});failed.deps.getTab=async()=>({url});failed.deps.transcribe=async()=>{throw Error('Groq限流');};let aiCalls=0;failed.deps.sendAIStudio=async()=>{aiCalls++;};
  await assert.rejects(failed.workflow.start({openerTabId:1,sourceUrl:url,transcribeService:'groq'}),/Groq限流/);assert.equal(aiCalls,0);assert.equal(failed.sent.length,0);
 }
});
