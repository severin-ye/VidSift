(function(root){
 'use strict';
 const normalize=value=>String(value||'').replace(/\s+/g,' ').trim();
 function verify(data,proof={}){
  const fail=reason=>({ok:false,reason});
  if(proof.initialId)return fail('existing_page');
  if(!Number.isFinite(proof.startedAt)||!proof.messageId||!normalize(proof.expectedText))return fail('missing_ownership_proof');
  if((data?.conversation_id||data?.id)!==proof.id)return fail('conversation_id_mismatch');
  const created=Number(data?.create_time)*1000;
  if(!Number.isFinite(created)||created<=0)return fail('missing_creation_time');
  if(created<proof.startedAt-2000)return fail('conversation_predates_task');
  if(created>(proof.now??Date.now())+10000)return fail('invalid_creation_time');
  const users=Object.values(data.mapping||{}).map(node=>node?.message).filter(message=>message?.author?.role==='user');
  if(users.length!==1)return fail('not_first_user_message');
  if(users[0].id!==proof.messageId)return fail('message_id_mismatch');
  const text=(users[0].content?.parts||[]).filter(part=>typeof part==='string').join(' ');
  if(normalize(text)!==normalize(proof.expectedText))return fail('prompt_mismatch');
  return {ok:true,reason:'ownership_verified'};
 }
 const api={verify,normalize};root.VidSiftConversationBinding=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
