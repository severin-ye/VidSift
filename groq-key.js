'use strict';
const keyInput=document.getElementById('apiKey'),save=document.getElementById('save'),status=document.getElementById('status');
document.getElementById('cancel').addEventListener('click',()=>window.close());
document.getElementById('signup').addEventListener('click',()=>chrome.tabs.create({url:'https://console.groq.com/keys',active:true}).catch(()=>{status.textContent='无法打开申请页面，请访问 https://console.groq.com/keys';}));
document.getElementById('keyForm').addEventListener('submit',async event=>{
 event.preventDefault();const apiKey=keyInput.value.trim();if(!apiKey){status.textContent='请先填写 Groq API Key';keyInput.focus();return;}
 keyInput.value='';keyInput.disabled=true;save.disabled=true;status.textContent='正在验证并加密保存，请稍候…';
 try{const response=await chrome.runtime.sendMessage({type:'VIDSIFT_GROQ_KEY_SAVE',apiKey});if(!response?.ok)throw new Error(response?.error||'本机程序未确认保存');status.textContent='密钥已保存，正在继续原任务';window.close();}
 catch(error){status.textContent=error.message;keyInput.disabled=false;save.disabled=false;keyInput.focus();}
});
chrome.runtime.sendMessage({type:'VIDSIFT_GROQ_KEY_READY'}).then(response=>{
 if(!response?.ok)throw new Error(response?.error||'配置窗口未就绪');keyInput.disabled=false;save.disabled=false;status.textContent='';keyInput.focus();
}).catch(error=>{status.textContent=error.message;});
window.addEventListener('pagehide',()=>{keyInput.value='';});
