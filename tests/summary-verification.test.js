const {test}=require('node:test'),assert=require('node:assert/strict');
const {inspectSummary}=require('../summary-verification.js');
const id='11111111-2222-4333-8444-555555555555';
function fixture(){return {conversation_id:id,mapping:{root:{parent:null,message:null},request:{parent:'root',message:{id:'user-1',author:{role:'user'},content:{content_type:'text',parts:['Summarize the supplied video.']}}},reply:{parent:'request',message:{id:'assistant-1',author:{role:'assistant'},status:'finished_successfully',end_turn:true,channel:'final',content:{content_type:'text',parts:['A real, nonempty summary.']}}}}};}
test('completed proof requires a nonempty finished final reply to the saved conversation initial request',()=>{
 const result=inspectSummary(fixture(),{conversationId:id,now:123});
 assert.equal(result.status,'completed');assert.equal(result.requestMessageId,'user-1');assert.equal(result.assistantMessageId,'assistant-1');assert.equal(result.checkedAt,123);
 assert.equal(JSON.stringify(result).includes('real, nonempty'),false,'proof contains no body or prompt');
});
test('streaming, empty, analysis-only and errored responses never count as completed',()=>{
 for(const edit of [m=>m.status='in_progress',m=>m.end_turn=false,m=>m.content.parts=['  '],m=>m.channel='analysis',m=>m.status='failed',m=>m.content={content_type:'reasoning_recap',parts:['thinking']}]){
  const data=fixture();edit(data.mapping.reply.message);assert.notEqual(inspectSummary(data,{conversationId:id}).status,'completed');
 }
});
test('an older finished response cannot verify a newer requested summary',()=>{
 const data=fixture();data.mapping.later={parent:'reply',message:{id:'user-2',author:{role:'user'}}};
 assert.equal(inspectSummary(data,{conversationId:id,requestMessageId:'user-2'}).status,'unknown');
});
test('identity mismatch, broken/cyclic ancestry and absent evidence are unknown',()=>{
 const wrong=fixture();wrong.conversation_id='22222222-2222-4333-8444-555555555555';assert.equal(inspectSummary(wrong,{conversationId:id}).status,'unknown');
 const broken=fixture();broken.mapping.reply.parent='missing';assert.notEqual(inspectSummary(broken,{conversationId:id}).status,'completed');
 const cycle=fixture();cycle.mapping.reply.parent='reply';assert.notEqual(inspectSummary(cycle,{conversationId:id}).status,'completed');
 assert.equal(inspectSummary({conversation_id:id},{conversationId:id}).status,'unknown');
});
test('hidden user context is not mistaken for the initial video summary request',()=>{
 const data=fixture();data.mapping.context={parent:'root',message:{id:'hidden-context',author:{role:'user'},content:{content_type:'user_editable_context'},metadata:{is_user_system_message:true}}};data.mapping.request.parent='context';
 const result=inspectSummary(data,{conversationId:id});assert.equal(result.status,'completed');assert.equal(result.requestMessageId,'user-1');
});
test('missing usable final-reply evidence is unknown, not an assertion that generation is active',()=>{
 const data=fixture();delete data.mapping.reply;assert.equal(inspectSummary(data,{conversationId:id}).status,'unknown');
});
