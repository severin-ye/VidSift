(() => {
 'use strict';
 if(globalThis.__vidsiftSummaryVerifier)return;globalThis.__vidsiftSummaryVerifier=true;
 let tokenPromise=null;
 async function token(){
  if(!tokenPromise)tokenPromise=(async()=>{const response=await fetch('/api/auth/session',{signal:AbortSignal.timeout(8000)});if(!response.ok)throw Error('ChatGPT登录状态暂时无法读取');let value;try{value=await response.json();}catch{throw Error('ChatGPT登录状态响应无效');}if(!value.accessToken)throw Error('请先登录ChatGPT以核验已完成总结');return value.accessToken;})().catch(error=>{tokenPromise=null;throw error;});
  return tokenPromise;
 }
 async function read(id){
  const response=await fetch('/backend-api/conversation/'+id,{headers:{Authorization:'Bearer '+await token()},signal:AbortSignal.timeout(8000)});
  if(!response.ok){if([401,403].includes(response.status))tokenPromise=null;throw Error('对应总结对话暂时无法核验（HTTP '+response.status+'）');}
  const max=6*1024*1024;if(Number(response.headers.get('content-length'))>max)throw Error('总结对话超过本次只读核验上限');
  const reader=response.body?.getReader();let text='';
  if(reader){let size=0;const decoder=new TextDecoder();try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max)throw Error('总结对话超过本次只读核验上限');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}finally{await reader.cancel().catch(()=>{});}}
  else {text=await response.text();if(text.length>max)throw Error('总结对话超过本次只读核验上限');}
  let data;try{data=JSON.parse(text);}catch{throw Error('ChatGPT对话响应无法解析');}
  return VidSiftSummaryVerification.inspectSummary(data,{conversationId:id});
 }
 chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message.type==='VIDSIFT_SUMMARY_READER_PING'){reply({ok:true,protocol:1});return false;}
  if(message.type!=='VIDSIFT_VERIFY_SAVED_SUMMARY')return;
  if(sender.id!==chrome.runtime.id||sender.tab||!/^https:\/\/chatgpt\.com\//.test(location.href)||new URL(location.href).searchParams.get('temporary-chat')==='true'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(message.id||'')){reply({ok:false,status:'unknown',error:'核验来源或对话身份无效'});return false;}
  read(message.id.toLowerCase()).then(proof=>reply({ok:true,...proof}),error=>reply({ok:false,status:'unknown',conversationId:message.id,error:error.message}));return true;
 });
})();
