const {test}=require('node:test'),assert=require('node:assert/strict');
const {LocalMediaCache}=require('../local-media-cache');
test('retry reclaims verified media without download and rejects a different video or duration',async()=>{
 const db={},storage={get:async key=>({[key]:db[key]}),set:async value=>Object.assign(db,value)};
 const cache=new LocalMediaCache(storage),task={source:{key:'douyin:123',videoId:'123'},id:'task'};
 const result={platform:'douyin',videoId:'123',title:'title',duration:40,localAudio:{fingerprint:'a'.repeat(64),videoId:'123',duration:40},audioInfo:{originalBytes:50}};
 await cache.save(task,result,{failureTtlHours:24});let claims=0;
 task.client={prepareLocalAudio:async descriptor=>{claims++;return descriptor;}};
 const reused=await cache.load(task,{duration:40});assert.equal(reused.localAudio.fingerprint,result.localAudio.fingerprint);assert.equal(reused.audio,null);assert.equal(claims,1);
 assert.equal(await cache.load({...task,source:{key:'douyin:other',videoId:'other'}},null),null);
 assert.equal(await cache.load(task,{duration:90}),null);assert.equal(claims,1);
});
test('cancelled or failed tasks retain reusable audio and success zero TTL expires only that entry',async()=>{
 const db={},storage={get:async key=>({[key]:db[key]}),set:async value=>Object.assign(db,value)};
 const cache=new LocalMediaCache(storage),task={source:{key:'douyin:1',videoId:'1'},id:'t',client:{prepareLocalAudio:async d=>d}};
 await cache.save(task,{platform:'douyin',videoId:'1',duration:10,localAudio:{fingerprint:'b'.repeat(64),duration:10,videoId:'1'}},{failureTtlHours:24,successTtlHours:0});
 await cache.finish(task,'cancelled');assert.ok(await cache.load(task,null));await cache.finish(task,'success');assert.equal(await cache.load(task,null),null);
});
