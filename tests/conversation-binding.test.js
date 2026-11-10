const test=require('node:test'),assert=require('node:assert/strict');
const {verify}=require('../conversation-binding');
const id='11111111-2222-4333-8444-555555555555',startedAt=1700000000000;
const proof={id,messageId:'message-one',expectedText:'first paragraph second paragraph',startedAt,now:startedAt+60000};
const conversation=()=>({conversation_id:id,create_time:startedAt/1000+10,mapping:{one:{message:{id:'message-one',author:{role:'user'},content:{parts:['first paragraph','second paragraph']}}}}});
test('preallocated conversation needs matching creation, message identity and text',()=>{assert.deepEqual(verify(conversation(),proof),{ok:true,reason:'ownership_verified'});});
test('same text in an old conversation cannot be claimed',()=>{const d=conversation();d.create_time-=86400;assert.equal(verify(d,proof).reason,'conversation_predates_task');});
test('other message, multiple user turns, old route and different identity are rejected',()=>{
 const d=conversation();d.mapping.one.message.id='different';assert.equal(verify(d,proof).ok,false);
 const e=conversation();e.mapping.two={message:{id:'previous',author:{role:'user'},content:{parts:['earlier']}}};assert.equal(verify(e,proof).reason,'not_first_user_message');
 assert.equal(verify(conversation(),{...proof,initialId:id}).reason,'existing_page');
 assert.equal(verify({...conversation(),conversation_id:'different'},proof).reason,'conversation_id_mismatch');
});
test('missing creation metadata or changed prompt fails closed',()=>{
 const d=conversation();delete d.create_time;assert.equal(verify(d,proof).ok,false);
 const e=conversation();e.mapping.one.message.content.parts=['other prompt'];assert.equal(verify(e,proof).reason,'prompt_mismatch');
 assert.equal(verify(conversation(),{...proof,startedAt:undefined}).ok,false);
});
