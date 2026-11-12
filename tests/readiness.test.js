const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function readyContext(response){let now=0,index=0;const c=vm.createContext({chrome:{tabs:{sendMessage:async()=>Array.isArray(response)?response[Math.min(index++,response.length-1)]:response}},performance:{now:()=>++now},overlayMsg(){},setTimeout:fn=>fn()});const source=fs.readFileSync('background.js','utf8').split('async function ensureChatGPTReady')[1].split('// Send a message')[0];vm.runInContext('async function ensureChatGPTReady'+source+';globalThis.check=ensureChatGPTReady;',c);return c;}
test('verified access gate reports actionable error instead of waiting silently',async()=>{const c=readyContext({ready:false,error:'ChatGPT页面需要人工访问验证，请在Edge完成验证后重试'});await assert.rejects(c.check(1,5),/人工访问验证/);});
test('hydrating page can still wait and ready composer continues',async()=>{assert.equal(await readyContext({ready:true}).check(1,5),'ready');assert.equal(await readyContext({ready:false}).check(1,5),'timeout');});
test('content readiness distinguishes access verification from a ready composer',()=>{
 const document={title:'Just a moment...',body:{innerText:'Verify you are human'},querySelector(){return null;}};let composer=null;
 const c=vm.createContext({document,findTextarea:()=>composer});const source=fs.readFileSync('chatgpt-content.js','utf8').split('function checkReady()')[1].split('function inputPrompt')[0];vm.runInContext('function checkReady()'+source+';globalThis.check=checkReady;',c);
 assert.match(c.check().error,/手动完成验证/);composer={};assert.equal(c.check().ready,true);composer=null;document.title='ChatGPT';document.body.innerText='Loading';assert.equal(c.check().ready,false);assert.equal(c.check().error,undefined);
});
test('missing background reply surfaces a connection error instead of silently enabling tasks',async()=>{
 const c=vm.createContext({chrome:{runtime:{sendMessage:async()=>undefined}}});const source=fs.readFileSync('popup.js','utf8').split('async function getActiveTranscribeTask')[1].split('function applyActiveTranscribeTask')[0];vm.runInContext('async function getActiveTranscribeTask'+source+';globalThis.check=getActiveTranscribeTask;',c);await assert.rejects(c.check(1),/后台未响应/);
});

test('access verification holds the accepted job and resumes without another submission',async()=>{
 const c=readyContext([{ready:false,waitingForVerification:true,error:'人工访问验证'},{ready:true}]);
 assert.equal(await c.check(1,10),'ready');
 let checked=0;await assert.rejects(c.check(1,10,()=>{checked++;throw Error('已取消');}),/已取消/);assert.equal(checked,1);
});
