(function(root){
 'use strict';
 const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
 // Return evidence only. Conversation bodies and credentials never leave the reader.
 function inspectSummary(data,{conversationId,requestMessageId,now=Date.now()}={}){
  const unknown=reason=>({status:'unknown',reason});
  if(!UUID.test(conversationId||'')||String(data?.conversation_id||data?.id||'').toLowerCase()!==conversationId.toLowerCase())return unknown('对话编号未确认');
  const mapping=data?.mapping;
  if(!mapping||typeof mapping!=='object'||Array.isArray(mapping)||Object.keys(mapping).length>10000)return unknown('没有可核验的回复记录');
  const entries=Object.entries(mapping),nodes=new Map(entries);
  const isRequest=m=>m?.author?.role==='user'&&m.content?.content_type!=='user_editable_context'&&!m.metadata?.is_user_system_message&&!m.metadata?.is_visually_hidden_from_conversation;
  function nearestUser(parent){const seen=new Set();while(parent&&nodes.has(parent)&&!seen.has(parent)){seen.add(parent);const node=nodes.get(parent);if(isRequest(node?.message))return node.message.id;parent=node?.parent;}return null;}
  let request=requestMessageId;
  if(request&&!entries.some(([,node])=>isRequest(node?.message)&&node.message.id===request))return unknown('对应请求未找到');
  if(!request){
   const initial=entries.filter(([,node])=>isRequest(node?.message)&&node.message.id&&!nearestUser(node.parent));
   if(initial.length!==1)return unknown('无法唯一确定视频总结请求');
   request=initial[0][1].message.id;
  }
  let generating=false;
  for(const [,node] of entries){
   const m=node?.message;
   if(m?.author?.role==='assistant'&&nearestUser(node.parent)===request&&(m.status==='in_progress'||m.status==='finished_successfully'&&m.end_turn===false))generating=true;
   if(m?.author?.role!=='assistant'||m.status!=='finished_successfully'||m.end_turn!==true||(m.channel&&m.channel!=='final'))continue;
   if(m.content?.content_type!=='text'||!Array.isArray(m.content.parts)||!m.content.parts.some(p=>typeof p==='string'&&p.trim()))continue;
   if(!m.id||nearestUser(node.parent)!==request)continue;
   return {status:'completed',conversationId:conversationId.toLowerCase(),requestMessageId:request,assistantMessageId:m.id,checkedAt:now};
  }
  return generating?{status:'pending',conversationId:conversationId.toLowerCase()}:unknown('对应总结的完成状态暂时无法确认');
 }
 const api={inspectSummary};root.VidSiftSummaryVerification=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
