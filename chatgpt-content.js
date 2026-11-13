// ChatGPT page content script: attach SRT file and send
(() => {
  if(globalThis.__vidsiftChatGPTBridgeVersion==='5.0.2')return;
  globalThis.__vidsiftChatGPTBridgeVersion='5.0.2';
  // --- Last received subtitle file (for manual save) ---
  let _subtitleState = 'idle';
  let _taskActive = false;
  let _lastConversationTask = null;
  const cancelledTasks = new Set();
  function assertNotCancelled(taskId) { if (taskId && cancelledTasks.has(taskId)) throw new Error('任务已取消，未自动发送'); }
  function reportTarget(msg, ok, error) { if (msg.taskId) chrome.runtime.sendMessage({type:'VIDSIFT_TARGET_DONE',taskId:msg.taskId,ok,...(error?{error}:{})}).catch(() => {}); }
  function readComposerText(editor = findTextarea()) {
    return editor?.value ?? editor?.innerText ?? editor?.textContent ?? '';
  }
  async function verifyOwnedConversation(id,messageId){
    const task=_lastConversationTask;
    if(!task)throw new Error('缺少本次视频发送记录，不能确认对话归属');
    if(task.candidateId!==id||!task.requestMessageId)throw new Error('没有与本次发送匹配的会话和消息编号，不能用当前页面替代');
    const token=await getAccessToken();
    let result;
    for(let attempt=0;attempt<3;attempt++){
      const response=await fetch('/backend-api/conversation/'+id,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(8000)});
      if(!response.ok)throw new Error('读取本次对话失败：HTTP '+response.status);
      const data=await response.json();
      const firstUser=Object.values(data.mapping||{}).map(node=>node?.message).find(message=>message?.author?.role==='user');
      result=VidSiftConversationBinding.verify(data,{...task,id,messageId:messageId||task.requestMessageId,now:Date.now()});
      if(result.ok)return id;
      if(result.reason!=='not_first_user_message'||firstUser)break;
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    const error=new Error('本次对话归属校验未通过：'+result.reason);error.reason=result.reason;throw error;
  }
  function captureSubmittedConversation(expectedText, taskId){
    const nonce=crypto.randomUUID();let finish,readyFinish,timer,readyTimer,stopped=false,verifying=false;
    const promise=new Promise(resolve=>{finish=resolve;});
    const ready=new Promise(resolve=>{readyFinish=resolve;});
    const stages=new Set();
    function diagnostic(stage,reason){
      const key=stage+':'+(reason||'');if(stages.has(key))return;stages.add(key);
      if(taskId)try{chrome.runtime.sendMessage({type:'VIDSIFT_DIAGNOSTIC',taskId,stage:'library.'+stage,details:reason?{reason}:{}}).catch(()=>{});}catch{}
    }
    function stop(id=null){if(stopped)return;stopped=true;clearTimeout(timer);clearTimeout(readyTimer);readyFinish(false);window.removeEventListener('message',receive);window.postMessage({type:'VIDSIFT_LIBRARY_DISARM',nonce},location.origin);finish(id);}
    function receive(event){
      if(event.source!==window||event.origin!==location.origin||event.data?.nonce!==nonce||stopped)return;
      const data=event.data;
      if(data.protocol!==2)return;
      if(data.type==='VIDSIFT_LIBRARY_READY'&&data.protocol===2){clearTimeout(readyTimer);readyFinish(true);diagnostic('armed');}
      if(data.type==='VIDSIFT_LIBRARY_STAGE'&&['request_match','response_id','candidate_id','timeout','rejected_shape'].includes(data.stage))diagnostic(data.stage,data.reason);
      if(data.type==='VIDSIFT_LIBRARY_CONVERSATION_CANDIDATE'&&!verifying&&/^[0-9a-f-]{36}$/i.test(data.id||'')){
        verifying=true;
        _lastConversationTask.candidateId=data.id;_lastConversationTask.requestMessageId=data.messageId;
        verifyOwnedConversation(data.id,data.messageId).then(id=>{if(!stopped){diagnostic('ownership_verified');stop(id);}},error=>{if(!stopped){diagnostic('ownership_rejected',error.reason||'metadata_unavailable');stop();}});
      }
      if(data.type==='VIDSIFT_LIBRARY_CONVERSATION_ID'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(data.id||'')){
        _lastConversationTask.candidateId=data.id;_lastConversationTask.requestMessageId=data.messageId;stop(data.id);
      }
    }
    window.addEventListener('message',receive);
    timer=setTimeout(()=>{diagnostic('timeout');stop();},90000);
    readyTimer=setTimeout(()=>{diagnostic('timeout');stop();},1500);
    window.postMessage({type:'VIDSIFT_LIBRARY_ARM',nonce,protocol:2,expectedText,allowPrepared:!_lastConversationTask?.initialId},location.origin);return {promise,ready,stop};
  }
  let _lastFile = null; // { name: string, content: string }

  // --- Save subtitle button ---
  let _saveBtn = null;
  let _retryUploadBtn = null;

  // --- Retry rename button ---
  let _retryRenameBtn = null;

  function showRetryRenameButton(conversationId, title) {
    if (_retryRenameBtn) return;
    _retryRenameBtn = document.createElement('button');
    _retryRenameBtn.textContent = '✎ 重试保存与改名';
    _retryRenameBtn.title = '发送字幕并生成会话后，可重新尝试修改会话名';
    _retryRenameBtn.style.cssText = getFloatingActionButtonStyle(
      _saveBtn || _retryUploadBtn ? 176 : 80, '#f59e0b');
    _retryRenameBtn.addEventListener('click', async () => {
      const originalText = _retryRenameBtn.textContent;
      _retryRenameBtn.disabled = true;
      _retryRenameBtn.style.opacity = '0.7';
      _retryRenameBtn.style.cursor = 'not-allowed';
      try {
        if(_taskActive)throw new Error('本次附件或对话仍在处理中，请等待当前任务结束');
        showStatus('正在重试修改会话名...');
        let id = conversationId;
        if (!id) {
          id = getConversationIdFromUrl();
        }
        if (!id) throw new Error('请先发送字幕并生成会话，再点击重试改名');
        await verifyOwnedConversation(id);
        if(_lastConversationTask?.libraryEligible){
          const saved=await chrome.runtime.sendMessage({type:'VIDSIFT_LIBRARY_CONFIRMED',taskId:_lastConversationTask.taskId,chatgptUrl:location.origin+'/c/'+id});
          if(!saved?.ok)throw new Error('本次视频的书库关系尚未保存，请检查错误日志后重试');
        }
        if (!await renameConversationViaAPI(id, title)) {
          showStatus('总结已发送；ChatGPT仍在等待标题，会话名待更新，可稍后只重试改名。');
          _retryRenameBtn.disabled = false;
          _retryRenameBtn.style.opacity = '1';
          _retryRenameBtn.style.cursor = 'pointer';
          return;
        }
        document.title = title;
        hideRetryRenameButton();
        hideStatus();
      } catch (e) {
        console.error('[ext] retry rename failed:', e);
        showError(`修改会话名失败：${e.message}`);
        _retryRenameBtn.disabled = false;
        _retryRenameBtn.style.opacity = '1';
        _retryRenameBtn.style.cursor = 'pointer';
        _retryRenameBtn.textContent = originalText;
      }
    });
    document.body.appendChild(_retryRenameBtn);
  }

  let _retryFailedBtn = null;
  function showFailedAttachmentRetry(error) {
    if (!error.retryable || !error.attachment) return;
    _retryFailedBtn?.remove();
    const button = document.createElement('button');
    _retryFailedBtn = button;
    button.textContent = `重试失败附件：${error.attachment.name}`;
    button.style.cssText = getFloatingActionButtonStyle(224, '#2563eb');
    button.addEventListener('click', async () => {
      if (_taskActive) return;
      button.disabled = true;
      try {
        // Only the positively failed tile owned by this attempt may be removed.
        (error.tile?.querySelector('button[aria-label^="Remove file"]') || error.tile?.querySelector('button[aria-label^="Remove "]'))?.click();
        await attachFileWithRetry(error.attachment.name, error.attachment.content, 1, error.attachment);
        button.remove(); _retryFailedBtn = null;
        showStatus('失败附件已重新上传；请检查所有附件后手动发送。');
      } catch (e) { showError(e.message); if (e.retryable) { error = e; button.disabled = false; } }
    });
    document.body.appendChild(button);
  }

  function hideRetryRenameButton() {
    if (_retryRenameBtn) {
      _retryRenameBtn.remove();
      _retryRenameBtn = null;
    }
  }

  function getFloatingActionButtonStyle(bottomPx, background) {
    return 'position:fixed;right:16px;z-index:999999;' +
      `bottom:${bottomPx}px;` +
      `background:${background};color:#fff;border:none;cursor:pointer;` +
      'padding:8px 14px;border-radius:8px;font-size:13px;' +
      'font-family:system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);' +
      'display:flex;align-items:center;gap:6px;';
  }

  function showSaveButton(fileName, fileContent) {
    _lastFile = { name: fileName, content: fileContent };
    if (_saveBtn && _retryUploadBtn) return; // already shown

    if (!_retryUploadBtn) {
      _retryUploadBtn = document.createElement('button');
      _retryUploadBtn.textContent = '⤴ 重新上传字幕';
      _retryUploadBtn.title = '再次触发字幕文件上传，但不会自动提交';
      _retryUploadBtn.style.cssText = getFloatingActionButtonStyle(128, '#2563eb');
      _retryUploadBtn.addEventListener('click', async () => {
        console.log('[ext] retry upload button clicked, _lastFile=', _lastFile ? _lastFile.name : null);
        if (['processing', 'confirmed', 'uncertain'].includes(_subtitleState)) {
          showError('字幕仍在处理、已经上传或状态未确认，已阻止重复上传；可保存字幕后检查页面。');
          return;
        }
        if (!_lastFile) {
          // Should not happen while the button is visible, but fail loudly instead of
          // silently doing nothing so a stale/detached state is easy to notice and debug.
          showError('没有可重新上传的字幕文件，请刷新页面后重试。');
          return;
        }
        const originalText = _retryUploadBtn.textContent;
        _retryUploadBtn.disabled = true;
        _retryUploadBtn.style.opacity = '0.7';
        _retryUploadBtn.style.cursor = 'not-allowed';
        try {
          showStatus('正在重新上传字幕文件...');
          await attachFileWithRetry(_lastFile.name, _lastFile.content);
          showStatus('字幕文件已重新上传，可继续手动发送。');
        } catch (e) {
          console.error('[ext] manual retry upload failed:', e);
          showError(`重新上传失败：${e.message}`);
        } finally {
          _retryUploadBtn.disabled = false;
          _retryUploadBtn.style.opacity = '1';
          _retryUploadBtn.style.cursor = 'pointer';
          _retryUploadBtn.textContent = originalText;
        }
      });
      document.body.appendChild(_retryUploadBtn);
    }

    if (!_saveBtn) {
      _saveBtn = document.createElement('button');
      _saveBtn.textContent = '⬇ 保存字幕文件';
      _saveBtn.title = '字幕文件上传失败时，可手动下载后再上传';
      _saveBtn.style.cssText = getFloatingActionButtonStyle(80, '#10a37f');
      _saveBtn.addEventListener('click', () => {
        if (!_lastFile) return;
        const blob = new Blob([_lastFile.content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = _lastFile.name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
      });
      document.body.appendChild(_saveBtn);
    }
  }

  function hideSaveButton() {
    if (_retryUploadBtn) {
      _retryUploadBtn.remove();
      _retryUploadBtn = null;
    }
    if (_saveBtn) {
      _saveBtn.remove();
      _saveBtn = null;
    }
    _lastFile = null;
    if (_retryRenameBtn) _retryRenameBtn.style.bottom = '80px';
  }

  // --- Status overlay ---

  let statusOverlay = null;

  function showStatus(msg) {
    if (!statusOverlay) {
      statusOverlay = document.createElement('div');
      statusOverlay.style.cssText =
        'position:fixed;top:16px;right:16px;z-index:999999;' +
        'background:#10a37f;color:#fff;padding:10px 16px;border-radius:8px;' +
        'font-size:14px;font-family:system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);' +
        'max-width:360px;line-height:1.4;transition:opacity .3s;' +
        'display:flex;align-items:flex-start;gap:10px;';

      const textNode = document.createElement('span');
      textNode.className = '__ext-status-text';
      textNode.style.flex = '1';

      const closeBtn = document.createElement('button');
      closeBtn.textContent = '✕';
      closeBtn.style.cssText =
        'background:none;border:none;color:inherit;cursor:pointer;' +
        'font-size:14px;line-height:1;padding:0;opacity:.8;flex-shrink:0;';
      closeBtn.addEventListener('click', hideStatus);

      statusOverlay.appendChild(textNode);
      statusOverlay.appendChild(closeBtn);
      document.body.appendChild(statusOverlay);
    }
    statusOverlay.style.background = '#10a37f';
    statusOverlay.style.opacity = '1';
    statusOverlay.querySelector('.__ext-status-text').textContent = msg;
  }

  function showError(msg) {
    globalThis.VidSiftErrors?.report(msg,{component:'chatgpt'});
    showStatus(msg);
    statusOverlay.style.background = '#e53935';
  }

  function hideStatus() {
    if (statusOverlay) {
      statusOverlay.style.opacity = '0';
      setTimeout(() => statusOverlay?.remove(), 300);
      statusOverlay = null;
    }
  }

  function findTextarea() {
    return document.querySelector('#prompt-textarea')
      || document.querySelector('div[contenteditable][data-placeholder]')
      || document.querySelector('.ProseMirror');
  }

  function findSendButton() {
    const composer = findTextarea()?.closest('form') || document;
    return composer.querySelector('#composer-submit-button')
      || composer.querySelector('button[data-testid="send-button"]')
      || composer.querySelector('button[aria-label="Send"]')
      || composer.querySelector('button[aria-label="发送"]')
      || composer.querySelector('button[type="submit"]');
  }

  function findFileInput() {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    // The first input may only accept photos/videos. Subtitle files need the
    // unrestricted file picker; generated React IDs are not stable selectors.
    return inputs.find(input => input.getAttribute('aria-label') === 'Attach files')
      || inputs.find(input => !input.getAttribute('accept')?.trim())
      || inputs.find(input => /(?:text\/plain|\.srt)(?:,|$)/i.test(input.getAttribute('accept') || ''))
      || document.querySelector('#upload-files');
  }

  function getVisibleFileTiles() {
    const composer = findTextarea()?.closest('form') || document;
    return Array.from(composer.querySelectorAll(
      '[class*="file-tile"][role="group"], [class~="group/composer-attachment"]'));
  }

  function getFileTileName(tile) {
    return tile.getAttribute('aria-label')
      || tile.querySelector('button.composer-attachment-surface[aria-label]')?.getAttribute('aria-label')
      || '';
  }

  // ChatGPT auto-renames a newly attached file to "name(1).ext", "name(2).ext", etc.
  // when a tile with the same name is already present in the composer.
  function tileNameMatches(tileName, fileName) {
    if (tileName === fileName) return true;
    const dot = fileName.lastIndexOf('.');
    const base = dot === -1 ? fileName : fileName.slice(0, dot);
    const ext = dot === -1 ? '' : fileName.slice(dot);
    const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escape(base)}\\(\\d+\\)${escape(ext)}$`).test(tileName);
  }

  function findFileTileByName(fileName, tiles = getVisibleFileTiles()) {
    return tiles.find(tile => {
      const ariaLabel = getFileTileName(tile);
      const text = tile.textContent || '';
      return tileNameMatches(ariaLabel, fileName) || text.includes(fileName);
    }) || null;
  }

  // Remove any composer tile left over from a previous (failed/stuck) attach attempt,
  // matched by name (including ChatGPT's "(n)" dedup suffix), so stale tiles don't
  // pile up in the composer across retries. Note this does NOT stop ChatGPT from
  // renaming the new upload to "name(n).ext" — it keeps an internal used-name
  // registry for the composer session even after a tile is removed — which is why
  // findFileTileByName above must tolerate the "(n)" suffix too.
  async function removeStaleFileTiles(fileName) {
    for (let guard = 0; guard < 10; guard++) {
      const staleTiles = getVisibleFileTiles().filter(tile =>
        tileNameMatches(getFileTileName(tile), fileName));
      if (staleTiles.length === 0) return;
      for (const tile of staleTiles) {
        (tile.querySelector('button[aria-label^="Remove file"]')
          || tile.querySelector('button[aria-label^="Remove "]'))?.click();
      }
      await new Promise(r => setTimeout(r, 200));
    }
  }

  function checkReady() {
    const textarea = findTextarea();
    if (textarea) return {ready:true};
    const title=(document.title||'').toLowerCase();
    const text=(document.body?.innerText||'').slice(0,8000);
    if (/just a moment|请稍候/.test(title) || document.querySelector('script[src*="/cdn-cgi/challenge-platform/"]') || /verify you are human|enable javascript and cookies|checking your browser|验证您是真人|验证你是真人/i.test(text)) {
      return {ready:false,waitingForVerification:true,error:'ChatGPT页面正在进行访问验证；请在此页面手动完成验证，插件会自动继续当前总结。'};
    }
    return {ready:false};
  }

  function inputPrompt(text) {
    const textarea = findTextarea();
    if (!textarea) return;

    textarea.focus();

    if (textarea.tagName === 'TEXTAREA') {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      ).set;
      nativeSetter.call(textarea, text);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // contenteditable div (ProseMirror)
      textarea.innerHTML = '';
      textarea.focus();
      const success = document.execCommand('insertText', false, text);
      if (!success || !textarea.textContent.trim()) {
        const p = document.createElement('p');
        p.textContent = text;
        textarea.innerHTML = '';
        textarea.appendChild(p);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }

  function clickSend(taskId, verifyAttachments) {
    return new Promise((resolve, reject) => {
      const textarea = findTextarea();
      let intervals = 0;
      let clickCount = 0;
      let lastClickInterval = -10; // interval index of last click
      const maxIntervals = 300; // 60-second hard limit

      const timer = setInterval(() => {
        if (taskId && cancelledTasks.has(taskId)) { clearInterval(timer); reject(new Error('任务已取消，未自动发送')); return; }
        intervals++;
        const btn = findSendButton();
        if (clickCount === 0 && verifyAttachments) {
          try { verifyAttachments(); } catch (e) { clearInterval(timer); reject(e); return; }
        }

        // Success: textarea was cleared after at least one click → message accepted
        if (clickCount > 0 && !(textarea?.value ?? textarea?.textContent)?.trim()) {
          clearInterval(timer);
          console.log('[ext] clickSend: confirmed (textarea cleared) after', clickCount, 'click(s)');
          resolve();
          return;
        }

        // Click when button is enabled; re-click every 10 intervals (2s) if textarea still has content
        if (btn && !btn.disabled && clickCount === 0) {
          lastClickInterval = intervals;
          clickCount++;
          console.log('[ext] clickSend: click attempt', clickCount);
          btn.click();
        }

        if (intervals >= maxIntervals) {
          clearInterval(timer);
          reject(new Error('发送失败：60 秒内未能成功提交消息'));
        }
      }, 200);
    });
  }

  async function attachFile(fileName, fileContent, attachment) {
    const contentType = typeof fileContent;
    const contentLen = contentType === 'string' ? fileContent.length : (fileContent instanceof Uint8Array || Array.isArray(fileContent)) ? fileContent.length : -1;
    console.log('[ext] attachFile: fileName=', fileName,
      'contentType=', contentType,
      'contentLength=', contentLen,
      'preview=', contentType === 'string' ? fileContent.slice(0, 100) : '(non-string)');

    // Clear any leftover tile from a previous attempt so stale/duplicate tiles
    // don't pile up in the composer across retries.
    // Preserve existing user attachments, including same-name files.

    const file = VidSiftAttachments.toFile(attachment || {name:fileName,content:fileContent,mime:'text/plain'});
    console.log('[ext] attachFile: File object size=', file.size, 'name=', file.name);
    const dt = new DataTransfer();
    dt.items.add(file);

    // Snapshot existing tiles before dispatching so we only wait for NEW ones
    const existingTiles = new Set(getVisibleFileTiles());
    console.log('[ext] attachFile: existingTiles count=', existingTiles.size);

    const fileInput = findFileInput();
    if (!fileInput) throw new Error('找不到支持字幕文件的上传入口');
    console.log('[ext] attachFile: using fileInput strategy, id=', fileInput.id);
    try {
      fileInput.value = '';
    } catch (e) {
      console.warn('[ext] attachFile: failed to clear file input value before upload', e);
    }
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('input', { bubbles: true }));
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    // Return existingTiles so the caller can verify attachment later (right before send).
    console.log('[ext] attachFile: upload triggered, returning existingTiles for later verification');
    return existingTiles;
  }

  async function attachFileWithRetry(fileName, fileContent, maxAttempts = 2, attachment, taskId) {
    const isSubtitle = !attachment || /text\/plain|subrip/.test(attachment.mime);
    if (isSubtitle) _subtitleState = 'processing';
    let lastError = null;
    let attemptsMade = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      assertNotCancelled(taskId);
      attemptsMade = attempt;
      try {
        console.log('[ext] attachFileWithRetry: starting attempt', attempt, 'of', maxAttempts);
        const existingTiles = await attachFile(fileName, fileContent, attachment);
        await new Promise(r => setTimeout(r, 3000)); // ChatGPT may enable the button prematurely; wait before checking
        const receipt = await waitForFileAttachment(fileName, existingTiles, taskId);
        if (isSubtitle) _subtitleState = 'confirmed';
        console.log('[ext] attachFileWithRetry: upload succeeded on attempt', attempt);
        return receipt;
      } catch (e) {
        if (taskId && cancelledTasks.has(taskId)) { e.retryable = false; }
        lastError = e;
        if (isSubtitle) _subtitleState = e.retryable ? 'failed' : 'uncertain';
        if (e.retryable && e.tile && attempt < maxAttempts) {
          (e.tile.querySelector('button[aria-label^="Remove file"]') || e.tile.querySelector('button[aria-label^="Remove "]'))?.click();
        }
        console.warn('[ext] attachFileWithRetry: upload attempt failed', attempt, 'of', maxAttempts, e);
        // A timed-out upload may still be owned and processed by ChatGPT. Starting
        // another attempt in that state creates duplicate attachments because the
        // original browser upload cannot be cancelled from this content script.
        // Only retry after the UI has positively shown that the attachment failed.
        if (attempt >= maxAttempts || !e.retryable) break;
      }
    }

    throw Object.assign(new Error(`附件上传未完成，已自动重试 ${Math.max(0, attemptsMade - 1)} 次：${lastError?.message || '未知错误'}`), {retryable:lastError?.retryable, tile:lastError?.tile, attachment:attachment || {name:fileName,content:fileContent,mime:'text/plain'}});
  }

  // Wait until the file upload is complete, using the send button's disabled state as the
  // authoritative signal: ChatGPT keeps the send button disabled while any upload is in
  // progress, and re-enables it only when all uploads finish (success or failure).
  //
  // After the send button re-enables we then verify the file tile is still in the DOM.
  // If the tile is gone → upload failed (ChatGPT removed it on error).
  //
  // NOTE: behavior-btn appears immediately on tile creation, NOT after upload completes,
  // so it cannot be used as an upload-success signal.
  //
  // existingTiles: Set of tile elements already in the DOM before this upload started.
  function waitForFileAttachment(fileName, existingTiles = new Set(), taskId) {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      let newFileTile = null;
      let missingSince = null;
      let reportedSlowUpload = false;
      const slowUploadAttempts = 150; // 30 seconds: log only, do not retry
      const maxAttempts = 1500; // 5 minutes hard limit
      const deadline = Date.now() + 300000;

      function fail(message, retryable) {
        clearInterval(timer);
        const error = new Error(message);
        error.retryable = retryable;
        error.tile = newFileTile;
        reject(error);
      }

      const timer = setInterval(() => {
        attempts++;
        if (taskId && cancelledTasks.has(taskId)) { fail('任务已取消，未自动发送', false); return; }
        if (attempts >= maxAttempts || Date.now() >= deadline) { fail('附件上传等待超过 5 分钟；为避免重复文件，已停止自动重试', false); return; }
        const btn = findSendButton();
        const allTiles = getVisibleFileTiles();
        const newTiles = allTiles.filter(t => !existingTiles.has(t));
        if (!newFileTile || !allTiles.includes(newFileTile)) {
          newFileTile = findFileTileByName(fileName, newTiles) || newFileTile;
        }
        const tileStillPresent = !!newFileTile && allTiles.includes(newFileTile);

        if (attempts <= 5 || attempts % 10 === 0) {
          console.log('[ext] waitForFileAttachment: attempt', attempts,
            'sendDisabled=', btn?.disabled,
            'newTiles=', newTiles.length,
            'newFileTile=', newFileTile?.getAttribute('aria-label') ?? 'none',
            'tileStillPresent=', tileStillPresent);
        }

        // A missing send selector must not turn a rejected file into a five-minute
        // wait. Only retry a missing tile when the UI is idle (send enabled).
        if (!newFileTile && attempts >= slowUploadAttempts && !btn) {
          fail('未出现字幕文件块，且找不到发送按钮；ChatGPT 页面可能已更新，请刷新后重试', false);
          return;
        }

        // A visible failure blocks send even when ChatGPT enables its button.
        if (tileStillPresent && (newFileTile.querySelector('[role="alert"], [data-state="error"], [class*="error"]') || /upload failed|上传失败|无法上传/i.test(newFileTile.textContent || ''))) {
          fail('附件上传失败，请重试', true); return;
        }
        if (tileStillPresent && newFileTile.querySelector('[role="progressbar"], [aria-busy="true"], [class*="spinner"], [class*="loading"]')) return;
        // Send button enabled and this new file remains without processing/error indicators.
        if (btn && !btn.disabled) {
          if (tileStillPresent) {
            clearInterval(timer);
            console.log('[ext] waitForFileAttachment: upload success, tile=', newFileTile.getAttribute('aria-label'));
            resolve(newFileTile);
          } else if (newFileTile) {
            console.warn('[ext] waitForFileAttachment: send button enabled but file tile is gone → upload failed');
            fail('字幕文件上传失败（文件块已消失），请重试', true);
          } else {
            // The change event and ChatGPT's tile rendering are asynchronous. Give
            // the UI a short grace period before treating "no tile" as a real failure.
            missingSince ??= Date.now();
            if (Date.now() - missingSince >= 5000) {
              console.warn('[ext] waitForFileAttachment: no new file tile appeared');
              fail('附件文件块未出现，上传状态未知；为避免重复附件，不自动重试', false);
            }
          }
          return;
        }
        missingSince = null;

        if (attempts >= slowUploadAttempts && !reportedSlowUpload) {
          reportedSlowUpload = true;
          console.warn('[ext] waitForFileAttachment: upload is taking longer than 30 seconds; continuing to wait without retrying');
        }

        if (attempts >= maxAttempts) {
          console.warn('[ext] waitForFileAttachment: hard timeout. sendDisabled=', btn?.disabled,
            'newTiles=', newTiles.length, 'tileStillPresent=', tileStillPresent);
          fail('字幕文件上传等待超过 5 分钟；为避免重复文件，已停止自动重试', false);
        }
      }, 200);
    });
  }

  // Wait for the URL to switch to a new /c/{uuid} path.
  // Returns the conversation ID, or null on timeout (e.g. temporary chat).
  function getConversationIdFromUrl() {
    return location.pathname.match(/^\/c\/([0-9a-f-]{36})/i)?.[1] ?? null;
  }

  function waitForConversationId(timeoutMs = 30000, initialId = null) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;

      function check() {
        const id = getConversationIdFromUrl();
        if (id && id !== initialId) { resolve(id); return; }
        if (Date.now() > deadline) { resolve(null); return; }
        setTimeout(check, 200);
      }
      check();
    });
  }

  // 获取 ChatGPT session token（带缓存，5 分钟内复用）
  let _cachedToken = null;
  let _cachedTokenExpiry = 0;
  async function getAccessToken() {
    if (_cachedToken && Date.now() < _cachedTokenExpiry) {
      return _cachedToken;
    }
    const sessionResp = await fetch('/api/auth/session',{signal:AbortSignal.timeout(8000)});
    if (!sessionResp.ok) throw new Error(`获取 session token 失败：HTTP ${sessionResp.status}`);
    const session = await sessionResp.json();
    const token = session?.accessToken;
    if (!token) throw new Error('session 中未找到 accessToken');
    _cachedToken = token;
    _cachedTokenExpiry = Date.now() + 5 * 60 * 1000; // 缓存 5 分钟
    return token;
  }

  // 新会话的默认标题
  const DEFAULT_TITLE = 'New chat';

  // 检查对话中是否存在至少一个已完成的助手回复。
  // 遍历所有 mapping 节点而非只看 current_node，
  // 避免轮询间隔中用户又提交新问题导致 current_node 指向未完成的新回复。
  function hasAnyFinishedAssistantResponse(data) {
    if (!data.mapping) return false;
    return Object.values(data.mapping).some(node => {
      const msg = node.message;
      return msg
        && msg.author?.role === 'assistant'
        && msg.status === 'finished_successfully'
        && msg.end_turn === true;
    });
  }

  // 等待 ChatGPT 自动标题生成完成。
  // ChatGPT 服务端在流式响应中会推送 title_generation 事件来自动命名新会话，
  // 如果我们在该事件之前就 PATCH 了标题，会被覆盖。
  // 策略：
  //   1. 标题已从 "New chat" 变为其他值 → 自动标题已生成，直接返回。
  //   2. 标题仍为 "New chat"，但助手回复已完成（finished_successfully + end_turn）
  //      → 服务端标题生成可能有延迟，再多等几轮给它一个窗口期，
  //        如果窗口期内标题仍未变化，则放弃等待。
  async function waitForTitleGeneration(conversationId, token) {
    // 长思考与标题延迟不是发送失败；有界等待后保留只改名的恢复入口。
    // 回复完成后额外等待的轮数（每轮 5 秒）
    const GRACE_ROUNDS = 3;
    let graceCountdown = -1; // -1 表示尚未进入宽限期
    let lastReadOK = false, lastError = null;
    const deadline=Date.now()+15*60*1000;
    while (Date.now()<deadline) {
      try {
        const resp = await fetch(`/backend-api/conversation/${conversationId}`, {
          headers: { 'Authorization': `Bearer ${token}` },
          signal:AbortSignal.timeout(8000),
        });
        if (resp.ok) {
          const data = await resp.json();
          lastReadOK = true;
          if (data.title && data.title !== DEFAULT_TITLE) {
            console.log('[ext] ChatGPT 自动标题已生成:', data.title);
            return true;
          }
          // 标题仍为默认值，检查助手回复是否已完成
          if (hasAnyFinishedAssistantResponse(data)) {
            if (graceCountdown < 0) {
              // 刚检测到回复完成，进入宽限期
              graceCountdown = GRACE_ROUNDS;
              console.log('[ext] 助手回复已完成，标题仍为默认值，进入宽限期等待标题生成...');
            } else {
              graceCountdown--;
            }
            if (graceCountdown <= 0) {
              console.log('[ext] 宽限期结束，标题仍为默认值，放弃等待标题生成');
              return true;
            }
            console.log(`[ext] 宽限期剩余 ${graceCountdown} 轮...`);
          } else {
            console.log('[ext] 当前标题仍为默认值，助手回复尚未完成，继续等待...');
          }
        } else {
          lastReadOK = false;
          lastError = new Error('读取本次会话标题失败：HTTP '+resp.status);
          if (resp.status === 401 || resp.status === 403) throw lastError;
        }
      } catch (e) {
        lastReadOK = false;
        lastError = e;
        if (/HTTP (401|403)\b/.test(e.message)) throw e;
        console.warn('[ext] waitForTitleGeneration 轮询出错:', e);
      }
      await new Promise(r => setTimeout(r, 5000));
    }
    if (!lastReadOK && lastError) throw lastError;
    return false;
  }

  // A title or an older reply cannot release the summary queue.
  function taskResponseOutcome(data,requestMessageId){
    if(typeof requestMessageId!=='string'||!requestMessageId)return null;
    const mapping=data.mapping||{};
    let failure=null;
    for(const node of Object.values(mapping)){
      if(node?.message?.author?.role!=='assistant')continue;
      let owned=false;
      const seen=new Set();let parent=mapping[node.parent];
      while(parent&&!seen.has(parent)){
        seen.add(parent);
        if(parent.message?.author?.role==='user'){owned=parent.message.id===requestMessageId;break;}
        parent=mapping[parent.parent];
      }
      if(!owned)continue;
      const status=node.message.status;
      if(status==='finished_successfully'&&node.message.end_turn===true)return 'completed';
      // Only explicit error/cancellation labels terminate a failed request.
      // finished_partial and unknown statuses can also describe unfinished work.
      if(['failed','finished_with_error'].includes(status))failure='failed';
      if(['cancelled','canceled'].includes(status))failure='cancelled';
    }
    return failure;
  }
  function hasFinishedTaskResponse(data,requestMessageId){
    return taskResponseOutcome(data,requestMessageId)==='completed';
  }
  function createTemporaryGenerationTracker(initialNodes=document.querySelectorAll('[role="status"]')){
    const complete=node=>/^(?:回答已完成|Response complete)[.!。！]?$/i.test((node.textContent||'').trim());
    const previous=new Set([...initialNodes].filter(complete));
    return ()=>{
      const nodes=[...document.querySelectorAll('[role="status"]')];
      for(const node of previous)if(!nodes.includes(node)||!complete(node))previous.delete(node);
      // A fresh completion announcement is authoritative; text pausing is not.
      const announced=nodes.some(node=>complete(node)&&!previous.has(node));
      const busy=document.querySelector('[data-testid="stop-button"],button[aria-label="Stop streaming"],button[aria-label="停止流式传输"],button[aria-label="停止"],button[aria-label="Stop"]');
      return announced&&!busy;
    };
  }
  async function waitForSummaryGeneration(msg,binding,temporaryFinished){
    const deadline=Date.now()+30*60*1000;
    if(msg.tempChat){
      const finished=temporaryFinished||createTemporaryGenerationTracker();
      while(Date.now()<deadline){
        assertNotCancelled(msg.taskId);
        if(finished())return;
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
    }else{
      const id=await binding?.promise;
      if(!id)throw new Error('总结已发送，但本次对话编号尚未确认；没有重复发送，请检查当前 ChatGPT 页面');
      const token=await getAccessToken(),task=_lastConversationTask;
      while(Date.now()<deadline){
        assertNotCancelled(msg.taskId);
        let response;
        try{response=await fetch('/backend-api/conversation/'+id,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(8000)});}catch{}
        if(response?.ok){
          const data=await response.json();
          const owned=VidSiftConversationBinding.verify(data,{...task,id,messageId:task.requestMessageId,now:Date.now()});
          if(owned.ok){
            const outcome=taskResponseOutcome(data,task.requestMessageId);
            if(outcome==='completed')return;
            if(outcome)throw new Error('总结已发送，但本次 ChatGPT 生成'+(outcome==='cancelled'?'已停止':'失败')+'；没有重复发送，后续视频将继续处理');
          }
        }else if(response&&[401,403].includes(response.status))throw new Error('总结已发送，但读取本次生成状态需要重新登录或访问验证；没有重复发送');
        await new Promise(resolve=>setTimeout(resolve,3000));
      }
    }
    throw new Error('总结已发送，但等待本次生成完成已超时；没有重复发送，请检查当前 ChatGPT 页面');
  }

  // Rename the conversation via ChatGPT internal API.
  // 重命名后会再确认一次，如果被服务端自动标题覆盖则重试。
  async function renameConversationViaAPI(conversationId, title) {
    const token = await getAccessToken();

    // 先等待 ChatGPT 自动标题生成完成，避免被覆盖
    if (!await waitForTitleGeneration(conversationId, token)) return false;

    async function patchTitle() {
      const resp = await fetch(`/backend-api/conversation/${conversationId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ title }),
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) throw new Error(`API 重命名失败：HTTP ${resp.status}`);
    }

    await patchTitle();

    // 确认标题是否生效（服务端 title_generation 可能在我们 PATCH 之后才到达）
    // 等待一小段时间后检查，如果被覆盖则重试一次
    await new Promise(r => setTimeout(r, 3000));
    try {
      const checkResp = await fetch(`/backend-api/conversation/${conversationId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
      if (checkResp.ok) {
        const data = await checkResp.json();
        if (data.title !== title) {
          console.log(`[ext] 标题被覆盖为 "${data.title}"，重新设置为 "${title}"`);
          await patchTitle();
        } else {
          console.log('[ext] 标题确认生效:', title);
        }
      }
    } catch (e) {
      console.warn('[ext] 标题确认检查出错:', e);
    }
    return true;
  }

  // After clicking send, scroll the new response turn into view the first time
  // the user switches to this tab. If the tab is already visible, do nothing.
  function scrollToResponseOnTabFocus() {
    console.log('[ext] scrollToResponseOnTabFocus called, visibilityState=', document.visibilityState);
    if (document.visibilityState === 'visible') {
      console.log('[ext] tab already visible, doing nothing');
      return;
    }

    function onVisibilityChange() {
      console.log('[ext] visibilitychange fired, visibilityState=', document.visibilityState);
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', onVisibilityChange);

      let article = document.querySelector('#thread .text-token-text-primary.w-full[data-turn=assistant]');
      if (article) {
        console.log("[ext] start scroll", article)
        article.scrollIntoView({"behavior": "instant", "block": "start"});
        setTimeout(function() {
          // 滚动2次，第一次不灵
          article.scrollIntoView({"behavior": "instant", "block": "start"});
        }, 200)
      } else {
        console.log('[ext] not found response')
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    console.log('[ext] visibilitychange listener registered');
  }

  async function loadPrompt() {
    const result = await chrome.storage.local.get('customPrompt');
    if (result.customPrompt != null) return result.customPrompt;
    const res = await fetch(chrome.runtime.getURL('prompt_chatgpt.txt'));
    return res.text();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if(msg.type==='VIDSIFT_CHATGPT_PING'){sendResponse({ok:true,component:'chatgpt',captureProtocol:2});return;}
    if (msg.type === 'VIDSIFT_CANCEL_UPLOAD') { cancelledTasks.add(msg.taskId); sendResponse({ok:true}); return; }
    if (msg.type === 'VIDSIFT_CHATGPT_CHECK_READY') {
      sendResponse(checkReady());
      return;
    }

    if (msg.type === 'VIDSIFT_CHATGPT_PREPARE_PROMPT') {
      // Reply immediately so popup can switch tab without waiting
      if (_taskActive) { sendResponse({ok:false,error:'已有附件任务正在处理'}); return; }
      _taskActive = true;
      globalThis.VidSiftErrors?.setTask(msg.taskId);
      _lastConversationTask={taskId:msg.taskId,startedAt:Date.now(),initialId:getConversationIdFromUrl(),libraryEligible:msg.libraryEligible===true};
      sendResponse({ ok: true });

      (async () => {
        let titleTimer = null, libraryBinding = null, generation = null, submitted = false;
        const conversationTitle = VidSiftConversationTitle.formatConversationTitle(msg.videoTitle, {...msg.source, videoId:msg.source?.videoId||msg.bvid});
        const bvidPrefix = msg.bvid ? `[${msg.bvid}] ` : '';
        console.log('[ext] CHATGPT_PREPARE_PROMPT received:',
          'file.name=', msg.file?.name,
          'file.content type=', typeof msg.file?.content,
          'file.content length=', typeof msg.file?.content === 'string' ? msg.file.content.length : '(non-string)',
          'bgOpen=', msg.bgOpen, 'tempChat=', msg.tempChat);
        let fileAttached = false;
        // Set tab title immediately so it doesn't stay on the default "ChatGPT" while we work
        if (conversationTitle && !msg.tempChat) {
          document.title = conversationTitle;
          titleTimer = setInterval(() => {
            if (document.title !== conversationTitle) {
              document.title = conversationTitle;
            }
          }, 200);
        }
        try {
          const attachments = VidSiftAttachments.normalizeMessage(msg);
          const subtitle = attachments.find(a => a.content !== undefined);
          if (subtitle) showSaveButton(subtitle.name, subtitle.content);
          if (conversationTitle && !msg.tempChat) {
            showRetryRenameButton(null, conversationTitle);
          }
          showStatus('正在添加字幕文件...');
          showStatus('正在输入提示词...');
          inputPrompt(VidSiftAttachments.contextualPrompt(msg.prompt ?? await loadPrompt(), attachments, msg.source?.url || msg.sourceUrl || msg.bvid || msg.videoTitle));
          _lastConversationTask.expectedText=readComposerText();
          showStatus('正在等待文件上传...');
          const receipts = [];
          for (const attachment of attachments) {
            assertNotCancelled(msg.taskId);
            receipts.push(await attachFileWithRetry(attachment.name, attachment.content, 2, attachment, msg.taskId));
          }
          fileAttached = true;
          console.log('[ext] CHATGPT_PREPARE_PROMPT: file attached successfully, proceeding to send');
          showStatus('正在发送...');
          assertNotCancelled(msg.taskId);
          if(!msg.tempChat&&(conversationTitle||msg.libraryEligible||msg.awaitGeneration)){
            libraryBinding=captureSubmittedConversation(readComposerText(),msg.taskId);
            await libraryBinding.ready; // Bounded handshake; capture failure never prevents the summary.
          }
          const temporaryFinished=msg.tempChat&&msg.awaitGeneration?createTemporaryGenerationTracker():null;
          await clickSend(msg.taskId, () => {
            const visible = getVisibleFileTiles();
            for (const tile of receipts) {
              if (!visible.includes(tile) || tile.querySelector('[role="alert"], [data-state="error"], [class*="error"], [role="progressbar"], [aria-busy="true"], [class*="spinner"], [class*="loading"]')) throw new Error('附件状态已改变，未自动发送');
            }
          });
          submitted=true;
          if(msg.awaitGeneration)chrome.runtime.sendMessage({type:'VIDSIFT_TARGET_SENT',taskId:msg.taskId}).catch(()=>{});
          if(msg.awaitGeneration){
            generation=waitForSummaryGeneration(msg,libraryBinding,temporaryFinished).then(()=>reportTarget(msg,true),error=>{showError(error.message);reportTarget(msg,false,error.message);});
          }else reportTarget(msg, true);
          if(msg.libraryEligible&&!msg.tempChat){const receipt=await chrome.runtime.sendMessage({type:'VIDSIFT_LIBRARY_SUBMITTED',taskId:msg.taskId});if(!receipt?.ok)showError('总结已发送，但本次视频的书库待办登记失败；详情已记录到日志');}
          // Submission succeeded — hide the save button now regardless of what happens next
          hideSaveButton();
          if (msg.bgOpen) scrollToResponseOnTabFocus();
          // Rename the new conversation to the video title via the sidebar UI (skip for temporary chats)
          if ((conversationTitle||msg.libraryEligible) && !msg.tempChat) {
            const conversationId = await libraryBinding.promise;
            if (!conversationId) {
              if(msg.libraryEligible)chrome.runtime.sendMessage({type:'VIDSIFT_LIBRARY_UNCONFIRMED',taskId:msg.taskId}).catch(()=>{});
              clearInterval(titleTimer);
              showError(`${bvidPrefix}总结请求已发送，但无法确认本次对话归属；未自动入书库或修改其他会话名`);
              showRetryRenameButton(null, conversationTitle);
              return;
            }
            if(msg.libraryEligible){const receipt=await chrome.runtime.sendMessage({type:'VIDSIFT_LIBRARY_CONFIRMED',taskId:msg.taskId,chatgptUrl:location.origin+'/c/'+conversationId});if(!receipt?.ok)throw new Error('总结已发送，但书库对话关系确认失败：'+(receipt?.error||'未收到回执'));}
            if(!conversationTitle){hideStatus();return;}
            showStatus('总结已发送；正在等待 ChatGPT 标题，随后自动改为视频名...');
            try {
              if (!await renameConversationViaAPI(conversationId, conversationTitle)) {
                clearInterval(titleTimer);
                showStatus(`${bvidPrefix}总结已发送；ChatGPT仍在等待标题，会话名待更新，可稍后只重试改名。`);
                showRetryRenameButton(conversationId, conversationTitle);
                return;
              }
              hideRetryRenameButton();
              clearInterval(titleTimer);
              document.title = conversationTitle;
            } catch (e) {
              clearInterval(titleTimer);
              console.error('[ext] renameConversationViaAPI failed:', e);
              showError(`${bvidPrefix}修改会话名失败：${e.message}`);
              showRetryRenameButton(conversationId, conversationTitle);
              return;
            }
          }
          hideStatus();
        } catch (e) {
          clearInterval(titleTimer);
          if(submitted)showError(e.message);else showFailedAttachmentRetry(e);
          if(!submitted)reportTarget(msg, false, e.message);
          console.error('[ext] CHATGPT_PREPARE_PROMPT failed, fileAttached=', fileAttached, 'error=', e);
          if (!fileAttached) {
            console.warn('[ext] 文件未成功附加，已跳过自动提交。请检查 DevTools Console 中的 debug 日志。');
            showError(`${bvidPrefix}附件未全部上传（未自动提交）：${e.message}`);
          } else {
            showError(`${bvidPrefix}错误：${e.message}`);
          }
        } finally { if(generation)await generation;libraryBinding?.stop(); _taskActive = false; }
      })();
      return;
    }

    if (msg.type === 'EXT_STATUS') {
      showStatus(msg.text);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'EXT_ERROR') {
      showError(msg.text);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'EXT_HIDE_STATUS') {
      hideStatus();
      sendResponse({ ok: true });
      return;
    }
  });
})();
