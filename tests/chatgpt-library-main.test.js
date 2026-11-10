const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const id='11111111-2222-4333-8444-555555555555';
function fixture(){const listeners=[],posts=[];const window={fetch:async()=>new Response('data: '+JSON.stringify({conversation_id:id})+'\n\n',{headers:{'content-type':'text/event-stream'}}),addEventListener:(type,fn)=>listeners.push(fn),postMessage:data=>posts.push(data)};
 const location={origin:'https://chatgpt.com',href:'https://chatgpt.com/c/aaaaaaaa-2222-4333-8444-555555555555'};
 const context=vm.createContext({window,location,URL,Request,TextDecoder,console,setTimeout:(fn,ms)=>{const t=setTimeout(fn,ms);t.unref();return t;},clearTimeout});vm.runInContext(fs.readFileSync('chatgpt-library-main.js','utf-8'),context);
 const message=data=>listeners.forEach(fn=>fn({source:window,origin:location.origin,data}));
 return {window,posts,message};}
test('matching new-conversation response binds its own ID, independent of current route',async()=>{
 const f=fixture();f.message({type:'VIDSIFT_LIBRARY_ARM',nonce:'n',expectedText:'video summary prompt'});
 const response=await f.window.fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({messages:[{author:{role:'user'},content:{parts:['video summary prompt']}}]})});
 assert.match(await response.text(),/conversation_id/);for(let n=0;n<20&&!f.posts.length;n++)await new Promise(r=>setTimeout(r,5));
 assert.deepEqual(f.posts.map(p=>({type:p.type,id:p.id,nonce:p.nonce})),[{type:'VIDSIFT_LIBRARY_CONVERSATION_ID',id,nonce:'n'}]);
});
test('unrelated prompt or existing conversation cannot claim a task',async()=>{
 const f=fixture();f.message({type:'VIDSIFT_LIBRARY_ARM',nonce:'n',expectedText:'expected prompt'});
 for(const body of [{messages:[{author:{role:'user'},content:{parts:['other text']}}]},{conversation_id:id,messages:[{author:{role:'user'},content:{parts:['expected prompt']}}]}])await f.window.fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify(body)});
 await new Promise(r=>setTimeout(r,15));assert.equal(f.posts.length,0);f.message({type:'VIDSIFT_LIBRARY_DISARM',nonce:'n'});
});
