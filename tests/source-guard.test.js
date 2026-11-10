const {test}=require('node:test'),assert=require('node:assert/strict');
const {SourceGuard}=require('../source-guard');const P=require('../platforms');
test('legacy Bili pending transcription cannot send after BV or part changes',async()=>{
 let url='https://www.bilibili.com/video/BV123abc?p=1',sent=0;
 const guard=new SourceGuard(async()=>({url}),P.identify),task=guard.begin(7,url);
 let finish;const pending=new Promise(r=>finish=r).then(async()=>{await guard.check(task);sent++;});
 url='https://www.bilibili.com/video/BV123abc?p=2';finish();await assert.rejects(pending,/切换/);assert.equal(sent,0);
});
test('late self-hosted result cannot attach itself to a newer task',()=>{
 const guard=new SourceGuard(async()=>({}),P.identify),first=guard.begin(1,'https://www.bilibili.com/video/BV123abc'),second=guard.begin(1,'https://www.bilibili.com/video/BVother123');
 assert.notEqual(first.id,second.id);assert.throws(()=>guard.get(1,first.id),/任务/);
});
