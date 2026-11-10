// Observe only the matching new-conversation request; never retain headers,
// account state or response text. URL navigation is not conversation ownership.
(() => {
 'use strict';if(globalThis.__vidsiftLibraryCapture)return;globalThis.__vidsiftLibraryCapture=true;
 const originalFetch=window.fetch,arms=new Map(),uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
 const normalize=s=>String(s||'').replace(/\s+/g,' ').trim();
 window.addEventListener('message',event=>{
  if(event.source!==window||event.origin!==location.origin)return;const data=event.data;
  if(data?.type==='VIDSIFT_LIBRARY_ARM'&&typeof data.nonce==='string'&&typeof data.expectedText==='string'&&data.expectedText.length<=1024*1024){
   const old=arms.get(data.nonce);if(old)clearTimeout(old.timer);
   arms.set(data.nonce,{text:normalize(data.expectedText),timer:setTimeout(()=>arms.delete(data.nonce),90000)});
  }
  if(data?.type==='VIDSIFT_LIBRARY_DISARM'){const arm=arms.get(data.nonce);if(arm)clearTimeout(arm.timer);arms.delete(data.nonce);}
 });
 async function observe(response,nonce){
  let reader,timer;try{
   reader=response.clone().body?.getReader();if(!reader)return;
   let text='',size=0;const decoder=new TextDecoder();
   const expires=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('capture timeout')),85000);});
   while(arms.has(nonce)){
    const {done,value}=await Promise.race([reader.read(),expires]);if(done)break;size+=value.byteLength;if(size>2*1024*1024)break;
    text=(text+decoder.decode(value,{stream:true})).slice(-65536);
    const id=text.match(/"conversation_id"\s*:\s*"([0-9a-f-]+)"/i)?.[1];
    if(id&&uuid.test(id)){window.postMessage({type:'VIDSIFT_LIBRARY_CONVERSATION_ID',nonce,id:id.toLowerCase()},location.origin);break;}
   }
  }catch{}finally{clearTimeout(timer);if(reader)reader.cancel().catch(()=>{});const arm=arms.get(nonce);if(arm)clearTimeout(arm.timer);arms.delete(nonce);}
 }
 window.fetch=async function(input,init){
  let nonce;
  try{
   if(arms.size){const url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url,location.href);const method=String(init?.method||input?.method||'GET').toUpperCase();
    if(url.origin===location.origin&&/^\/backend-api\/(?:f\/)?conversation$/.test(url.pathname)&&method==='POST'){
     const raw=typeof init?.body==='string'?init.body:input instanceof Request?await input.clone().text():'';
     if(raw.length<1024*1024){const request=JSON.parse(raw);if(!request.conversation_id&&Array.isArray(request.messages)){
      const texts=request.messages.filter(m=>m.author?.role==='user').flatMap(m=>m.content?.parts||[]).filter(p=>typeof p==='string').map(normalize);
      nonce=[...arms].find(([,arm])=>arm.text&&texts.includes(arm.text))?.[0];
     }}
    }
   }
  }catch{}
  const response=await originalFetch.apply(this,arguments);if(nonce&&response.ok)observe(response,nonce);return response;
 };
})();
