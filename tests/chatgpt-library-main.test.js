const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const id='11111111-2222-4333-8444-555555555555';
function fixture({legacy=false}={}){const listeners=[],posts=[];const window={fetch:async()=>new Response('data: '+JSON.stringify({conversation_id:id})+'\n\n',{headers:{'content-type':'text/event-stream'}}),addEventListener:(type,fn)=>listeners.push(fn),removeEventListener:(type,fn)=>{const i=listeners.indexOf(fn);if(i>=0)listeners.splice(i,1);},postMessage:data=>posts.push(data)};
 const location={origin:'https://chatgpt.com',href:'https://chatgpt.com/c/aaaaaaaa-2222-4333-8444-555555555555'};
 const context=vm.createContext({window,location,URL,Request,TextDecoder,console,__vidsiftLibraryCapture:legacy?true:undefined,setTimeout:(fn,ms)=>{const t=setTimeout(fn,ms);t.unref();return t;},clearTimeout});vm.runInContext(fs.readFileSync('chatgpt-library-main.js','utf-8'),context);
 const message=data=>listeners.forEach(fn=>fn({source:window,origin:location.origin,data:{protocol:2,...data}}));
 return {window,posts,message};}
test('matching new-conversation response binds its own ID, independent of current route',async()=>{
 const f=fixture();f.message({type:'VIDSIFT_LIBRARY_ARM',nonce:'n',expectedText:'video summary prompt'});
 const response=await f.window.fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({messages:[{author:{role:'user'},content:{parts:['video summary prompt']}}]})});
 assert.match(await response.text(),/conversation_id/);for(let n=0;n<20&&!f.posts.some(p=>p.type==='VIDSIFT_LIBRARY_CONVERSATION_ID');n++)await new Promise(r=>setTimeout(r,5));
 assert.deepEqual(f.posts.filter(p=>p.type==='VIDSIFT_LIBRARY_CONVERSATION_ID').map(p=>({type:p.type,id:p.id,nonce:p.nonce})),[{type:'VIDSIFT_LIBRARY_CONVERSATION_ID',id,nonce:'n'}]);
});

test('old MAIN marker cannot block the current capture protocol on an open page',async()=>{
 const f=fixture({legacy:true});f.message({type:'VIDSIFT_LIBRARY_ARM',nonce:'n',expectedText:'expected prompt',allowPrepared:true});
 assert.ok(f.posts.some(p=>p.type==='VIDSIFT_LIBRARY_READY'&&p.protocol===2));
 await f.window.fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({conversation_id:id,messages:[{id:'message-one',author:{role:'user'},content:{parts:['expected prompt']}}]})});
 assert.ok(f.posts.some(p=>p.type==='VIDSIFT_LIBRARY_CONVERSATION_CANDIDATE'));
});
test('unrelated prompt or existing conversation cannot claim a task',async()=>{
 const f=fixture();f.message({type:'VIDSIFT_LIBRARY_ARM',nonce:'n',expectedText:'expected prompt'});
 for(const body of [{messages:[{author:{role:'user'},content:{parts:['other text']}}]},{conversation_id:id,messages:[{author:{role:'user'},content:{parts:['expected prompt']}}]}])await f.window.fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify(body)});
 await new Promise(r=>setTimeout(r,15));assert.equal(f.posts.filter(p=>p.type==='VIDSIFT_LIBRARY_CONVERSATION_ID').length,0);f.message({type:'VIDSIFT_LIBRARY_DISARM',nonce:'n'});
});

test('preallocated conversation yields an untrusted candidate requiring server proof',async()=>{
 const f=fixture();f.message({type:'VIDSIFT_LIBRARY_ARM',nonce:'n',expectedText:'expected prompt',allowPrepared:true});
 await f.window.fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({conversation_id:id,messages:[{id:'message-one',author:{role:'user'},content:{parts:['expected prompt']}}]})});
 await new Promise(r=>setTimeout(r,20));
 const candidate=f.posts.find(p=>p.type==='VIDSIFT_LIBRARY_CONVERSATION_CANDIDATE');assert.ok(candidate,'preallocated ID must reach ownership verification');assert.equal(candidate.id,id);assert.equal(candidate.messageId,'message-one');assert.equal(f.posts.some(p=>p.type==='VIDSIFT_LIBRARY_CONVERSATION_ID'),false);
});

test('split user text is matched as one message and reports a specific mismatch reason',async()=>{
 const f=fixture();f.message({type:'VIDSIFT_LIBRARY_ARM',nonce:'n',expectedText:'first paragraph second paragraph'});
 await f.window.fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({messages:[{author:{role:'user'},content:{parts:['unrelated']}}]})});
 assert.ok(f.posts.some(p=>p.stage==='rejected_shape'&&p.reason==='prompt_mismatch'));
 await f.window.fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({messages:[{author:{role:'user'},content:{parts:['first paragraph','second paragraph']}}]})});
 for(let n=0;n<20&&!f.posts.some(p=>p.type==='VIDSIFT_LIBRARY_CONVERSATION_ID');n++)await new Promise(r=>setTimeout(r,5));
 assert.ok(f.posts.some(p=>p.type==='VIDSIFT_LIBRARY_CONVERSATION_ID'));
});
