const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('standalone page bridge ignores original extension requests and downloads its own request once',async()=>{
 let listener,downloads=0;const replies=[];
 const window={addEventListener(_type,fn){listener=fn;},postMessage(msg){replies.push(msg);}};
 const context={window,fetch:async()=>{downloads++;let consumed=false;return {ok:true,headers:{get(){return '3';}},body:{getReader(){return {async read(){if(consumed)return {done:true};consumed=true;return {done:false,value:Uint8Array.from([1,2,3])};}};}}};},btoa:s=>Buffer.from(s,'binary').toString('base64'),Uint8Array};
 vm.createContext(context);vm.runInContext(fs.readFileSync('bilibili-content-main.js','utf8'),context);
 await listener({source:window,data:{type:'BILIBILI_FETCH_AUDIO',requestId:'original',urls:['https://cdn.test/audio']}});
 assert.equal(downloads,0);assert.equal(replies.length,0);
 await listener({source:window,data:{type:'VIDSIFT_BILIBILI_FETCH_AUDIO',requestId:'old',urls:['https://cdn.test/audio']}});
 assert.equal(downloads,0);
 await listener({source:window,data:{type:'VIDSIFT_BILI_V2_FETCH_AUDIO',requestId:'standalone',urls:['https://cdn.test/audio']}});
 assert.equal(downloads,1);assert.equal(replies.at(-1).type,'VIDSIFT_BILI_V2_FETCH_RESULT');
 assert.equal(replies.at(-1).requestId,'standalone');assert.equal(replies.at(-1).result.ok,true);
});
