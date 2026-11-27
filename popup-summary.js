(function(root){
 'use strict';
 const conversationUrl=value=>{try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='chatgpt.com'&&!u.username&&!u.password&&!u.port&&u.searchParams.get('temporary-chat')!=='true'&&/^\/(?:g\/[^/]+\/)?c\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/?$/i.test(u.pathname);}catch{return false;}};
 async function open(tab,expectedVideoUrl){
  const panel=document.getElementById('summaryPanel'),select=document.getElementById('summaryRating'),state=document.getElementById('summaryState'),list=document.getElementById('summaryList'),next=document.getElementById('summaryNext'),retry=document.getElementById('summaryRetry');
  const rating=document.getElementById('summaryRatingField'),currentButton=document.getElementById('summaryRemoveCurrent');
  const dialog=document.getElementById('summaryRemoveDialog'),confirmText=document.getElementById('summaryRemoveText');
  const videoMode=typeof expectedVideoUrl==='string';
  if(videoMode){
   rating.hidden=true;
   panel.parentNode.append(panel);
  }else{
   document.body.classList.add('summary-mode');
   document.getElementById('runBtn').style.display='none';
   document.getElementById('statusText').style.display='none';
  }
  panel.hidden=false;
  let confirmed=null,cursor=null,nextCursor=null,busy=false,ready=false;
  const request=async(type,extra={})=>{
   const result=await chrome.runtime.sendMessage({type,tabId:tab.id,expectedUrl:tab.url,expectedVideoUrl,...extra});
   if(!result?.ok)throw Error(result?.error||'书库未响应，请重试');return result;
  };
  const lock=value=>{busy=value;select.disabled=value||!ready;currentButton.disabled=value;next.disabled=value;retry.disabled=value;for(const button of list.querySelectorAll('button'))button.disabled=value;};
  async function remove(record,isCurrent){
   if(busy||dialog.open)return;
   confirmText.textContent='从书库移除「'+record.title+'」中 '+date(record.createdAt)+' 的总结？ChatGPT 原对话和已有批注会保留。'+(isCurrent?' 如果还有其他总结，GPT 页会切换到其中一条。':'');
   dialog.returnValue='';
   dialog.showModal();
   await new Promise(resolve=>dialog.addEventListener('close',resolve,{once:true}));
   if(dialog.returnValue!=='remove')return;
   lock(true);state.textContent='正在从书库移除这条总结…';
   try{
    const result=await request('VIDSIFT_POPUP_SUMMARY_REMOVE',{recordId:record.id,cursor});
    if(result.switched){window.close();return;}
    if(result.currentRemoved){
     ready=false;currentButton.hidden=true;next.hidden=true;retry.hidden=true;list.replaceChildren();
     state.textContent='当前对话已从书库移除。ChatGPT 原对话和已有批注仍在。';
    }else{
     lock(false);
     await load(null,'已从书库移除这条总结。');
    }
   }catch(error){state.textContent='移除未确认：'+error.message;}
   finally{lock(false);}
  }
  async function load(page=null,notice=''){
   if(busy)return;ready=false;select.value='unknown';currentButton.hidden=true;lock(true);state.textContent='正在读取书库中的总结对话…';
   try{
    const result=await request('VIDSIFT_POPUP_SUMMARY_CONTEXT',{cursor:page});
    cursor=page;nextCursor=result.nextCursor;
    if(!videoMode){
     confirmed=result.rating;select.value=confirmed===null?'':String(confirmed);ready=true;
     document.getElementById('summaryTitle').textContent=result.current.title;
     document.getElementById('summaryCurrent').textContent='当前总结 · '+date(result.current.createdAt);
     currentButton.hidden=!result.canRemove;
     currentButton.onclick=()=>remove(result.current,true);
    }
    list.replaceChildren();
    for(const record of result.records){
     const li=document.createElement('li'),button=document.createElement('button');button.type='button';
     const current=record.id===result.current?.id&&!videoMode;
     button.textContent=(current?'当前总结 · ':'')+date(record.createdAt)+' · '+record.title;
     button.addEventListener('click',async()=>{if(busy)return;lock(true);state.textContent='正在切换总结对话…';try{await request('VIDSIFT_POPUP_SUMMARY_OPEN',{recordId:record.id,cursor});window.close();}catch(e){state.textContent=e.message;lock(false);}});
     li.append(button);
     if(result.canRemove&&!current){
      const removeButton=document.createElement('button');removeButton.type='button';removeButton.dataset.removeSummary='';
      removeButton.textContent='移除';removeButton.setAttribute('aria-label','从书库移除 '+date(record.createdAt)+' 的总结 · '+record.title);
      removeButton.addEventListener('click',()=>remove(record,false));
      li.append(removeButton);
     }
     list.append(li);
    }
    next.hidden=!nextCursor;
    state.textContent=notice+(result.total?'同视频已保存 '+result.total+' 个总结对话。':'书库还没有保存当前视频的总结。')+(result.total&&!result.canRemove?' 更新书库后可移除。':'');
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
