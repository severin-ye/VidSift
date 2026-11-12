const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('chatgpt-content.js','utf8');
const context=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('  function hasFinishedTaskResponse('),source.indexOf('  async function waitForSummaryGeneration(')),context);
const user=id=>({message:{id,author:{role:'user'}}});
const assistant=(parent,status='finished_successfully',end_turn=true)=>({parent,message:{author:{role:'assistant'},status,end_turn}});
test('queue completion belongs to this user message, never an old reply or title',()=>{
 assert.equal(context.hasFinishedTaskResponse({title:'generated',mapping:{old:user('old'),done:assistant('old'),current:user('current'),thinking:assistant('current','in_progress',false)}},'current'),false);
 assert.equal(context.hasFinishedTaskResponse({mapping:{u:user('current'),thinking:{parent:'u',message:{author:{role:'assistant'},status:'finished_successfully',end_turn:false}},final:assistant('thinking')}},'current'),true);
 assert.equal(context.hasFinishedTaskResponse({mapping:{u:user('other'),done:assistant('u')}},'current'),false);
});
test('broken or cyclic message ancestry cannot complete a queued summary',()=>{
 assert.equal(context.hasFinishedTaskResponse({mapping:{a:assistant('b'),b:{parent:'a'}}},'current'),false);
 assert.equal(context.hasFinishedTaskResponse({mapping:{done:assistant('missing')}},'current'),false);
});
