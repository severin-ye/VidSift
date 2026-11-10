const {test}=require('node:test'),assert=require('node:assert/strict');
const {GroqCredentialPrompt}=require('../groq-credential-prompt');
function fixture(configured=false){
 let handler,opened=0,stored=0,removed=[];
 const api={runtime:{id:'extension',getURL:p=>'chrome-extension://extension/'+p},windows:{create:async()=>{opened++;return{id:9,tabs:[{id:20}]};},remove:async id=>{removed.push(id);},onRemoved:{addListener:fn=>{handler=fn;}}}};
 const prompt=new GroqCredentialPrompt(api),controller=new AbortController(),task={id:'task',controller};
 const client={groqStatus:async()=>({configured}),storeGroqKey:async()=>{stored++;return{configured:true};}};
 const sender=()=>({id:'extension',url:api.runtime.getURL('groq-key.html')+'#'+[...prompt.entries.keys()][0],tab:{id:20}});
 return {prompt,client,task,signal:controller.signal,controller,sender,closed:()=>handler(9),opened:()=>opened,stored:()=>stored,removed};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('existing credentials skip the prompt entirely',async()=>{const f=fixture(true);assert.equal(await f.prompt.ensure(f),true);assert.equal(f.opened(),0);});
test('save from the owned extension window resumes exactly the waiting task',async()=>{
 const f=fixture(),wait=f.prompt.ensure(f);await tick();assert.equal(f.opened(),1);
 const token=[...f.prompt.entries.keys()][0];assert.equal((await f.prompt.handle({type:'VIDSIFT_GROQ_KEY_SAVE',apiKey:'synthetic'},f.sender())).ok,true);
 assert.equal(await wait,true);assert.equal(f.stored(),1);assert.equal(f.prompt.entries.size,0);
 assert.equal((await f.prompt.handle({type:'VIDSIFT_GROQ_KEY_SAVE',apiKey:'synthetic'},{...f.sender(),url:'chrome-extension://extension/groq-key.html#'+token})).ok,false);
});
test('websites, another extension page and a different window cannot save',async()=>{
 const f=fixture(),wait=f.prompt.ensure(f);await tick();const s=f.sender();
 for(const sender of [{...s,url:'https://example.test/'},{...s,url:s.url.replace('groq-key','options')},{...s,tab:{id:99}},{...s,id:'other'}])assert.equal((await f.prompt.handle({type:'VIDSIFT_GROQ_KEY_SAVE',apiKey:'synthetic'},sender)).ok,false);
 assert.equal(f.stored(),0);f.closed();await assert.rejects(wait,/取消/);
});
test('closing or cancelling clears the wait and cannot resume on a late save',async()=>{
 const f=fixture(),wait=f.prompt.ensure(f);await tick();const s=f.sender();f.controller.abort();await assert.rejects(wait,/取消/);
 assert.equal((await f.prompt.handle({type:'VIDSIFT_GROQ_KEY_SAVE',apiKey:'synthetic'},s)).ok,false);assert.equal(f.stored(),0);assert.equal(f.prompt.entries.size,0);
});
test('invalid credentials keep the same dialog available for correction',async()=>{
 const f=fixture(),wait=f.prompt.ensure(f);f.client.storeGroqKey=async()=>{throw Error('Groq拒绝了密钥');};await tick();
 assert.equal((await f.prompt.handle({type:'VIDSIFT_GROQ_KEY_SAVE',apiKey:'synthetic'},f.sender())).ok,false);assert.equal(f.prompt.entries.size,1);f.closed();await assert.rejects(wait,/取消/);
});
test('changed source blocks save and does not reach transcription',async()=>{
 const f=fixture();let current=true;f.assertLive=async()=>{if(!current)throw Error('源视频已切换');};
 const wait=f.prompt.ensure(f);await tick();current=false;
 const response=await f.prompt.handle({type:'VIDSIFT_GROQ_KEY_SAVE',apiKey:'synthetic'},f.sender());assert.equal(response.ok,false);assert.equal(f.stored(),0);
 f.closed();await assert.rejects(wait,/源视频已切换/);
});
