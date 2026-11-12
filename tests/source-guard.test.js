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

test('closed legacy source retains fixed identity without tab lookup, but cancel and replacement still reject',async()=>{
 let reads=0;const guard=new SourceGuard(async()=>{reads++;throw Error('unexpected lookup');},P.identify);
 const task=guard.begin(7,'https://www.bilibili.com/video/BV123abc?p=2');task.sourceClosed=true;
 await guard.check(task);assert.equal(reads,0);assert.equal(task.source.part,2);
 guard.cancel(7);await assert.rejects(guard.check(task),/取消/);
 const newer=guard.begin(7,'https://www.bilibili.com/video/BVother123');newer.sourceClosed=true;
 await assert.rejects(guard.check(task),/取消|替代/);await guard.check(newer);
});

test('legacy missing tab detaches while API failures and cancellation during lookup do not pass',async()=>{
 for(const message of ['No tab with id: 7.','标签页不存在']){
  const guard=new SourceGuard(async()=>{throw Error(message);},P.identify),task=guard.begin(7,'https://www.bilibili.com/video/BV123abc');
  await guard.check(task);assert.equal(task.sourceClosed,true);
 }
 const guard=new SourceGuard(async()=>{throw Error('Permission denied');},P.identify),task=guard.begin(7,'https://www.bilibili.com/video/BV123abc');
 await assert.rejects(guard.check(task),/Permission denied/);assert.equal(task.sourceClosed,undefined);
 guard.getTab=async()=>{guard.cancel(7);throw Error('No tab with id: 7.');};await assert.rejects(guard.check(task),/取消/);
});
