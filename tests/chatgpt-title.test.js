const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('chatgpt-content.js','utf8');
function fixture(read,{status=200}={}){
  let now=0,reads=0;
  const context=vm.createContext({Date:{now:()=>now},console:{log(){},warn(){}},AbortSignal,
    fetch:async()=>({ok:status===200,status,json:async()=>read(now,++reads)}),setTimeout:(fn,ms)=>{now+=ms;fn();}});
  vm.runInContext(source.slice(source.indexOf("  const DEFAULT_TITLE ="),source.indexOf('  // Rename the conversation via')),context);
  return {wait:()=>context.waitForTitleGeneration('owned-conversation','synthetic'),elapsed:()=>now};
}
test('a healthy long thinking reply can receive its automatic title after 90 seconds',async()=>{
  const f=fixture(now=>({title:now<130000?'New chat':'generated title',mapping:{}}));
  assert.equal(await f.wait(),true);assert(f.elapsed()>=130000);
});
test('a still pending title reaches a bounded non-error state instead of failing the summary',async()=>{
  const f=fixture(()=>({title:'New chat',mapping:{}}));
  assert.equal(await f.wait(),false);assert(f.elapsed()>=900000);assert(f.elapsed()<920000);
});
test('a completed reply with no automatic title receives a finite grace period',async()=>{
  const f=fixture(()=>({title:'New chat',mapping:{one:{message:{author:{role:'assistant'},status:'finished_successfully',end_turn:true}}}}));
  assert.equal(await f.wait(),true);assert(f.elapsed()>0);assert(f.elapsed()<30000);
});
test('an actual authentication failure remains an error rather than a pending title',async()=>{
  const f=fixture(()=>({}),{status:401});await assert.rejects(f.wait(),/HTTP 401/);assert.equal(f.elapsed(),0);
});
test('waiting for a pending title never PATCHes or sends the summary again',async()=>{
  let now=0;const writes=[];
  const context=vm.createContext({Date:{now:()=>now},console:{log(){},warn(){}},AbortSignal,
    setTimeout:(fn,ms)=>{now+=ms;fn();},fetch:async(url,options)=>{
      if(options?.method)writes.push(options.method);
      return {ok:true,json:async()=>({title:'New chat',mapping:{}})};
    }});
  vm.runInContext(source.slice(source.indexOf('  const DEFAULT_TITLE ='),source.indexOf('  // After clicking send,')),context);
  context.getAccessToken=async()=>'synthetic';
  assert.equal(await context.renameConversationViaAPI('owned-conversation','video title'),false);
  assert.deepEqual(writes,[]);
});
