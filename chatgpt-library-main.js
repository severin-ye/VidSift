// Observe matching task requests. Never retain headers, account state or response text.
(() => {
 'use strict';const protocol=2;if(globalThis.__vidsiftLibraryCapture?.protocol===protocol)return;
 globalThis.__vidsiftLibraryCapture?.dispose?.();
 const originalFetch=window.fetch,arms=new Map(),uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
 const normalize=s=>String(s||'').replace(/\s+/g,' ').trim();
 function stage(nonce,name,reason){const arm=arms.get(nonce),key=name+':'+(reason||'');if(!arm||arm.stages.has(key))return;arm.stages.add(key);window.postMessage({type:'VIDSIFT_LIBRARY_STAGE',nonce,protocol,stage:name,...(reason?{reason}:{})},location.origin);}
 function disarm(nonce){const arm=arms.get(nonce);if(arm)clearTimeout(arm.timer);arms.delete(nonce);}
 const receive=event=>{
  if(event.source!==window||event.origin!==location.origin)return;const data=event.data;
  if(data?.type==='VIDSIFT_LIBRARY_ARM'&&data.protocol===protocol&&typeof data.nonce==='string'&&typeof data.expectedText==='string'&&data.expectedText.length<=1024*1024){
   disarm(data.nonce);
   arms.set(data.nonce,{text:normalize(data.expectedText),allowPrepared:data.allowPrepared===true,stages:new Set(),matched:false,timer:setTimeout(()=>{stage(data.nonce,'timeout','response_timeout');disarm(data.nonce);},90000)});
   window.postMessage({type:'VIDSIFT_LIBRARY_READY',nonce:data.nonce,protocol},location.origin);
  }
  if(data?.type==='VIDSIFT_LIBRARY_DISARM')disarm(data.nonce);
 };
 window.addEventListener('message',receive);
 async function observe(response,nonce,messageId){
  let reader,timer;try{
   reader=response.clone().body?.getReader();if(!reader){stage(nonce,'rejected_shape','missing_response_body');return;}
   let text='',size=0;const decoder=new TextDecoder();
   const expires=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('capture timeout')),85000);});
   while(arms.has(nonce)){
    const {done,value}=await Promise.race([reader.read(),expires]);if(done)break;size+=value.byteLength;if(size>2*1024*1024){stage(nonce,'rejected_shape','response_size_limit');return;}
    text=(text+decoder.decode(value,{stream:true})).slice(-65536);
    const id=text.match(/"conversation_id"\s*:\s*"([0-9a-f-]+)"/i)?.[1];
    if(id&&uuid.test(id)&&arms.has(nonce)){stage(nonce,'response_id');window.postMessage({type:'VIDSIFT_LIBRARY_CONVERSATION_ID',nonce,protocol,id:id.toLowerCase(),...(messageId?{messageId}:{})},location.origin);return;}
   }
   stage(nonce,'rejected_shape','missing_response_id');
  }catch{stage(nonce,'timeout','response_read_failed');}finally{clearTimeout(timer);if(reader)reader.cancel().catch(()=>{});disarm(nonce);}
 }
 const wrappedFetch=async function(input,init){
  let nonce,preparedId,messageId;
  try{
   if(arms.size){const url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url,location.href);const method=String(init?.method||input?.method||'GET').toUpperCase();
    if(url.origin===location.origin&&/^\/backend-api\/(?:f\/)?conversation$/.test(url.pathname)&&method==='POST'){
     const raw=typeof init?.body==='string'?init.body:input instanceof Request?await input.clone().text():'';
     if(raw.length>=1024*1024){for(const [key]of arms)stage(key,'rejected_shape','request_size_limit');}
     else{
      const request=JSON.parse(raw),messages=Array.isArray(request.messages)?request.messages.filter(m=>m.author?.role==='user'):[];
      const matching=[...arms].find(([,arm])=>!arm.matched&&arm.text&&messages.some(m=>normalize((m.content?.parts||[]).filter(p=>typeof p==='string').join(' '))===arm.text));
      if(!matching){for(const [key]of arms)stage(key,'rejected_shape',messages.length?'prompt_mismatch':'missing_user_message');}
      else{
       const [key,arm]=matching,message=messages.find(m=>normalize((m.content?.parts||[]).filter(p=>typeof p==='string').join(' '))===arm.text);
       if(request.conversation_id){
        if(!arm.allowPrepared)stage(key,'rejected_shape','existing_conversation');
        else if(!uuid.test(request.conversation_id)||!message.id||!/^[\w-]{1,100}$/.test(message.id))stage(key,'rejected_shape','missing_prepared_proof');
        else{nonce=key;preparedId=request.conversation_id.toLowerCase();messageId=message.id;}
       }else{nonce=key;messageId=message.id;}
       if(nonce){arm.matched=true;stage(nonce,'request_match',preparedId?'preallocated_conversation':'new_conversation');}
      }
     }
    }
   }
  }catch{for(const [key]of arms)stage(key,'rejected_shape','request_parse_failed');}
  let response;
  try{response=await originalFetch.apply(this,arguments);}catch(error){if(nonce)stage(nonce,'rejected_shape','request_failed');throw error;}
  if(nonce&&response.ok&&arms.has(nonce)){
   if(preparedId){stage(nonce,'candidate_id','preallocated_conversation');window.postMessage({type:'VIDSIFT_LIBRARY_CONVERSATION_CANDIDATE',nonce,protocol,id:preparedId,messageId},location.origin);}
   else observe(response,nonce,messageId);
  }else if(nonce)stage(nonce,'rejected_shape','http_'+response.status);
  return response;
 };
 window.fetch=wrappedFetch;
 globalThis.__vidsiftLibraryCapture={protocol,dispose(){window.removeEventListener('message',receive);for(const [nonce]of arms)disarm(nonce);if(window.fetch===wrappedFetch)window.fetch=originalFetch;}};
})();
