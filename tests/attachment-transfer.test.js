const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const T=require('../attachment-transfer');
const baseMessage=attachments=>({type:'VIDSIFT_AISTUDIO_UPLOAD_AND_RUN',taskId:'task',source:{url:'fixture'},duration:12,prompt:'synthetic',attachments});
function fixture(){let busy=false,accepted=[],messages=[];const receiver=T.createReceiver({reserve(){if(busy)return false;busy=true;return true;},release(){busy=false;},accept(m){accepted.push(m);busy=false;}});return {receiver,accepted,messages,api:{tabs:{async sendMessage(tab,msg){messages.push(structuredClone(msg));return receiver.handle(structuredClone(msg))||{ok:true};}}}};}
const hash=s=>crypto.createHash('sha256').update(Buffer.from(s,'base64')).digest('hex');
for(const size of [27,60])test(`${size} MiB binary crosses small messages with one exact-byte acceptance`,async()=>{
 const h=fixture(),bytes=Buffer.alloc(size*1024*1024,117),base64=bytes.toString('base64');
 await T.send(h.api,1,baseMessage([{name:'audio.m4a',mime:'audio/mp4',base64}]));
 assert.equal(h.accepted.length,1);assert.equal(hash(h.accepted[0].attachments[0].base64),crypto.createHash('sha256').update(bytes).digest('hex'));
 assert.equal(h.messages.filter(m=>m.type.endsWith('COMMIT')).length,1);assert(h.messages.every(m=>Buffer.byteLength(JSON.stringify(m))<1024*1024));h.receiver.dispose();
});
test('small direct path preserves identity, source, duration and strips duplicate',async()=>{let observed;const m=baseMessage([{name:'a.m4a',mime:'audio/mp4',base64:'YQ=='}]);m.audioData='YQ==';await T.send({tabs:{async sendMessage(_,msg){observed=msg;return {ok:true};}}},1,m,{forceChunk:false});assert.deepEqual(observed.attachments,m.attachments);assert.equal(observed.audioData,undefined);assert.equal(observed.duration,12);assert.equal(observed.taskId,'task');assert.deepEqual(observed.source,m.source);});
test('multiple images and arbitrary unicode/control text reassemble exactly',async()=>{const h=fixture(),attachments=[{name:'1.jpg',mime:'image/jpeg',base64:Buffer.alloc(800000,1).toString('base64')},{name:'2.jpg',mime:'image/jpeg',base64:Buffer.alloc(800000,2).toString('base64')},{name:'s.srt',mime:'application/x-subrip',content:'汉🙂\u0001'.repeat(150000)}];await T.send(h.api,1,baseMessage(attachments));assert.deepEqual(h.accepted[0].attachments,attachments);assert(h.messages.every(m=>Buffer.byteLength(JSON.stringify(m))<1024*1024));h.receiver.dispose();});
test('cancel halfway drops buffer and never commits',async()=>{const h=fixture();let cancel=false;await assert.rejects(T.send(h.api,1,baseMessage([{name:'a',mime:'audio/mp4',base64:'A'.repeat(2*1024*1024)}]),{assertLive(){if(cancel)throw Error('cancelled');},onProgress(){cancel=true;h.receiver.cancel('task');}}),/cancelled/);assert.equal(h.accepted.length,0);assert.equal(h.messages.filter(m=>m.type.endsWith('COMMIT')).length,0);});
for(const failure of ['missing','out of order','duplicate','wrong task','wrong transfer','wrong receiver','unknown commit'])test(failure+' aborts without acceptance',async()=>{const h=fixture();const base64='A'.repeat(2*1024*1024);let touched=false;const send=h.api.tabs.sendMessage;h.api.tabs.sendMessage=async(_,msg)=>{if(msg.type.endsWith('CHUNK')&&!touched){touched=true;if(failure==='missing')return {ok:true,receiverId:msg.receiverId};if(failure==='out of order')msg.sequence++;if(failure==='duplicate'){await send(_,msg);}if(failure==='wrong task')msg.taskId='other';if(failure==='wrong transfer')msg.transferId='other';if(failure==='wrong receiver')msg.receiverId='other';if(failure==='unknown commit'){h.receiver.dispose();return {ok:true,receiverId:msg.receiverId};}}return send(_,msg);};await assert.rejects(T.send(h.api,1,baseMessage([{name:'a',mime:'audio/mp4',base64}])));assert.equal(h.accepted.length,0);h.receiver.dispose();});
test('lost commit acknowledgement never resends commit',async()=>{const h=fixture(),send=h.api.tabs.sendMessage;let commits=0;h.api.tabs.sendMessage=async(_,m)=>{const response=await send(_,m);if(m.type.endsWith('COMMIT')){commits++;throw Error('closed');}return response;};await assert.rejects(T.send(h.api,1,baseMessage([{name:'a',mime:'audio/mp4',base64:'A'.repeat(2*1024*1024)}])));assert.equal(commits,1);assert.equal(h.accepted.length,1);h.receiver.dispose();});
test('sender pins data and abort messages to the top frame',async()=>{const calls=[];await assert.rejects(T.send({tabs:{async sendMessage(id,msg,options){calls.push(options);if(msg.type.endsWith('BEGIN'))return {ok:true,receiverId:'r'};throw Error('gone');}}},1,baseMessage([{name:'a',mime:'audio/mp4',base64:'A'.repeat(1024*1024)}])));assert(calls.length>=3);assert(calls.every(options=>options.frameId===0));});
test('timeout releases task reservation and rejects late commit',async()=>{let busy=false;const r=T.createReceiver({reserve(){busy=true;return true;},release(){busy=false;},accept(){throw Error('must not run');},timeout:10});const response=r.handle({type:'VIDSIFT_ATTACHMENT_BEGIN',taskId:'task',transferId:'x',metadata:baseMessage([]),fields:[]});assert(response.ok);await new Promise(resolve=>setTimeout(resolve,25));assert.equal(busy,false);assert.equal(r.handle({type:'VIDSIFT_ATTACHMENT_COMMIT',taskId:'task',transferId:'x',receiverId:response.receiverId}).ok,false);});

test('stale abort or competing begin cannot discard the current transfer',async()=>{
 for(const staleType of ['VIDSIFT_ATTACHMENT_ABORT','VIDSIFT_ATTACHMENT_BEGIN']){
  const h=fixture(),oldSend=h.api.tabs.sendMessage;let interleaved=false;
  h.api.tabs.sendMessage=async(tab,msg)=>{
   const reply=await oldSend(tab,msg);
   if(msg.type.endsWith('BEGIN')&&!interleaved){interleaved=true;
    const stale={...msg,type:staleType,taskId:'stale',transferId:'stale',metadata:{...msg.metadata,taskId:'stale'}};
    assert.equal(h.receiver.handle(stale).ok,false);
   }return reply;
  };
  await T.send(h.api,1,baseMessage([{name:'small.m4a',mime:'audio/mp4',base64:'YQ=='}]));
  assert.equal(h.accepted.length,1);assert.equal(h.accepted[0].attachments[0].base64,'YQ==');h.receiver.dispose();
 }
});
