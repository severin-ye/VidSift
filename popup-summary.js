(function(root){
 'use strict';
 const conversationUrl=value=>{try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='chatgpt.com'&&!u.username&&!u.password&&!u.port&&u.searchParams.get('temporary-chat')!=='true'&&/^\/(?:g\/[^/]+\/)?c\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/?$/i.test(u.pathname);}catch{return false;}};
 async function open(tab){
  document.body.classList.add('summary-mode');
  const panel=document.getElementById('summaryPanel'),select=document.getElementById('summaryRating'),state=document.getElementById('summaryState'),list=document.getElementById('summaryList'),next=document.getElementById('summaryNext'),retry=document.getElementById('summaryRetry');
  panel.hidden=false;document.getElementById('runBtn').style.display='none';document.getElementById('statusText').style.display='none';
  let confirmed=null,cursor=null,nextCursor=null,busy=false,ready=false;
  const request=async(type,extra={})=>{
   const result=await chrome.runtime.sendMessage({type,tabId:tab.id,expectedUrl:tab.url,...extra});
   if(!result?.ok)throw Error(result?.error||'书库未响应，请重试');return result;
  };
  const lock=value=>{busy=value;select.disabled=value||!ready;next.disabled=value;retry.disabled=value;for(const button of list.querySelectorAll('button'))button.disabled=value;};
  async function load(page=null){
   if(busy)return;ready=false;select.value='unknown';lock(true);state.textContent='正在读取书库评分和已保存的总结对话…';
   try{
    const result=await request('VIDSIFT_POPUP_SUMMARY_CONTEXT',{cursor:page});
    confirmed=result.rating;select.value=confirmed===null?'':String(confirmed);ready=true;cursor=page;nextCursor=result.nextCursor;
    document.getElementById('summaryTitle').textContent=result.current.title;
    document.getElementById('summaryCurrent').textContent='当前总结 · '+date(result.current.createdAt);
    list.replaceChildren();
    for(const record of result.records){
     const li=document.createElement('li'),button=document.createElement('button');button.type='button';
     button.textContent=(record.id===result.current.id?'当前总结 · ':'')+date(record.createdAt)+' · '+record.title;
     button.addEventListener('click',async()=>{if(busy)return;lock(true);state.textContent='正在切换总结对话…';try{await request('VIDSIFT_POPUP_SUMMARY_OPEN',{recordId:record.id,cursor});window.close();}catch(e){state.textContent=e.message;lock(false);}});
     li.append(button);list.append(li);
    }
    next.hidden=!nextCursor;state.textContent=result.total?'同视频已保存 '+result.total+' 个总结对话；列表不代表生成已完成。':'书库当前没有可列出的总结对话。';
   }catch(e){state.textContent=e.message;next.hidden=true;select.value='unknown';list.replaceChildren();}
   finally{lock(false);}
  }
  select.addEventListener('change',async()=>{
   if(busy||!ready)return;const score=select.value===''?null:Number(select.value);if(score===confirmed)return;
   lock(true);state.textContent='正在保存评分…';
   try{const result=await request('VIDSIFT_POPUP_SUMMARY_RATE',{score});confirmed=result.score;state.textContent='评分已在知行批注书库本地保存';}
   catch(e){select.value=confirmed===null?'':String(confirmed);state.textContent='评分未确认保存：'+e.message;}
   finally{lock(false);}
  });
  next.addEventListener('click',()=>load(nextCursor));retry.addEventListener('click',()=>load(null));
  await load();
 }
 function date(value){const d=new Date(value);return Number.isFinite(d.getTime())?d.toLocaleString('zh-CN'):'日期未知';}
 root.VidSiftSummaryPopup={conversationUrl,open};
})(globalThis);
