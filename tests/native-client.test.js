const {test}=require('node:test');
const assert=require('node:assert/strict');
const {NativeMediaClient}=require('../native-client.js');
function event(){const listeners=[];return {addListener:f=>listeners.push(f),emit:x=>listeners.forEach(f=>f(x))};}
function runtime(){const p={onMessage:event(),onDisconnect:event(),postMessage:m=>p.last=m,disconnect:()=>p.onDisconnect.emit()};return {p,connectNative:()=>p};}
test('streams base64 chunks in order and resolves only final result',async()=>{
 const r=runtime(),c=new NativeMediaClient(r);const pending=c.readAsset('asset');const id=r.p.last.id;
 r.p.onMessage.emit({id,type:'chunk',sequence:0,data:'YWJj'});
 r.p.onMessage.emit({id,type:'chunk',sequence:1,data:'ZGVm'});
 r.p.onMessage.emit({id,type:'result',result:{name:'x.jpg',mime:'image/jpeg',size:6}});
 assert.deepEqual(await pending,{name:'x.jpg',mime:'image/jpeg',base64:'YWJjZGVm'});c.close();
});
test('out of order chunks and disconnect reject pending requests',async()=>{
 const r=runtime(),c=new NativeMediaClient(r);const pending=c.readAsset('asset');
 r.p.onMessage.emit({id:r.p.last.id,type:'chunk',sequence:2,data:'YWJj'});
 await assert.rejects(pending,/顺序/);
 const other=c.request('resolve',{url:'x'});r.p.onDisconnect.emit();await assert.rejects(other,/本机/);
});
