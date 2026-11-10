// AI Studio page content script: drop audio file, type prompt, click Run
(() => {
  if(globalThis.__vidsiftAIStudioBridgeVersion==='5.0.10')return;
  globalThis.__vidsiftAIStudioBridgeVersion='5.0.10';
  // --- Status overlay ---

  let statusOverlay = null;
  let _taskActive = false;
  let _activeTaskId = null;
  const cancelledTasks = new Map();
  function assertNotCancelled(taskId) { if (taskId && cancelledTasks.has(taskId)) throw new Error((cancelledTasks.get(taskId)||'任务已取消')+'，未自动发送'); }
  function reportTarget(msg, ok, error, payload = {}) { if (msg.taskId) chrome.runtime.sendMessage({type:'VIDSIFT_TARGET_DONE',taskId:msg.taskId,ok,...payload,...(error?{error}: {})}).catch(() => {}); }

  function reportTranscribeTaskEvent(state, text, biliTabId) {
    if (biliTabId == null) return;
    chrome.runtime.sendMessage({
      type: 'TRANSCRIBE_TASK_EVENT',
      taskId: _activeTaskId,
      state,
      text,
      biliTabId,
    }).catch(() => {});
  }

  function showStatus(msg) {
    if (!statusOverlay) {
      statusOverlay = document.createElement('div');
      statusOverlay.style.cssText =
        'position:fixed;top:16px;right:16px;z-index:999999;' +
        'background:#1a73e8;color:#fff;padding:10px 16px;border-radius:8px;' +
        'font-size:14px;font-family:system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);' +
        'max-width:360px;line-height:1.4;transition:opacity .3s;';
    }
    // document_start: body may not exist yet; attach/re-attach when available
    if (!statusOverlay.parentNode) {
      (document.body || document.documentElement).appendChild(statusOverlay);
    }
    statusOverlay.style.background = '#1a73e8';
    statusOverlay.style.opacity = '1';
    statusOverlay.textContent = msg;
  }

  function showError(msg) {
    showStatus(msg);
    statusOverlay.style.background = '#d93025';
  }

  function hideStatus() {
    if (statusOverlay) {
      statusOverlay.style.opacity = '0';
      setTimeout(() => statusOverlay?.remove(), 300);
      statusOverlay = null;
    }
  }

  // --- DOM automation helpers ---

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function visibleControl(element) {
    return !element.hidden && element.getAttribute?.('aria-hidden') !== 'true' &&
      (!element.getClientRects || element.getClientRects().length > 0);
  }

  function controlLabel(button) {
    return button.getAttribute?.('aria-label') || button.getAttribute?.('title') || button.textContent || '';
  }

  function findRunButton() {
    const matches = Array.from(document.querySelectorAll('button')).filter(button => {
      if (!visibleControl(button)) return false;
      const label = controlLabel(button).trim().replace(/\s+/g, ' ')
        .replace(/^(?:play_arrow|arrow_upward|send)\s+/, '')
        .replace(/\s*(?:↵|⏎|keyboard_return|subdirectory_arrow_left)$/, '').trim();
      // Match the action, never a settings/menu label containing the word Run.
      return /^(?:run(?: prompt)?|send(?: prompt)?|运行|运行提示|发送|执行)(?:\s*(?:\(?Ctrl\s*\+\s*Enter\)?|\(?⌘\s*Enter\)?))?$/i.test(label) ||
        (button.matches?.('ms-run-button button, button[data-testid="run-button"]') &&
          /^(?:arrow_upward|play_arrow|send)$/i.test(label));
    });
    // Ambiguous controls are not a reason to guess and submit the wrong form.
    return matches.length === 1 ? matches[0] : null;
  }

  function isEnabled(button) {
    return button && !button.disabled && button.getAttribute?.('aria-disabled') !== 'true';
  }

  function getPromptTextarea() {
    return Array.from(document.querySelectorAll('textarea')).find(textarea =>
      visibleControl(textarea) && !textarea.disabled &&
      textarea.getAttribute?.('aria-label') !== 'Prompt description text field' &&
      !textarea.closest?.('[role="dialog"], mat-dialog-container')) || null;
  }

  // --- Drop file onto prompt area ---

  function getAttachmentCards() {
    const cards = Array.from(document.querySelectorAll('ms-file-chunk, ms-audio-chunk, ms-image-chunk, [data-testid="attachment"], .attachment-container, .file-container'));
    // A renderer and its wrapper are one attachment, not two receipts.
    return cards.filter(card => !cards.some(other => other !== card && card.contains?.(other)));
  }

  function attachmentState(fileName, receipt = new Set()) {
    const cards = getAttachmentCards();
    const existing = receipt.existing || receipt;
    let card = receipt.card;
    if (card && !cards.includes(card)) return {state:'pending'};
    if (!card) {
      const added = cards.filter(candidate => !existing.has(candidate));
      const named = added.filter(candidate => candidate.getAttribute('aria-label') === fileName ||
        candidate.getAttribute('title') === fileName || (candidate.textContent || '').includes(fileName));
      // Only a drop receipt may bind a renamed card. Plain filename lookup cannot
      // claim an unrelated pre-existing upload or choose among multiple new cards.
      card = named.length === 1 ? named[0] : receipt.existing && added.length === 1 ? added[0] : null;
      if (card && receipt.existing) receipt.card = card;
    }
    if (!card) return {state:'pending'};
    const errorSelector = '[role="alert"], [data-state="error"], [class*="error"]';
    const busySelector = '[role="progressbar"], [aria-busy="true"], mat-progress-spinner, mat-spinner, [class*="loading"]';
    if (card.matches?.(errorSelector) || card.querySelector(errorSelector) || /upload failed|上传失败|无法上传/i.test(card.textContent || '')) return {state:'failed',card};
    if (card.matches?.(busySelector) || card.querySelector(busySelector)) return {state:'pending',card};
    const image = card.querySelector('img');
    const audio = card.querySelector('audio');
    const audioCard = receipt.mime?.startsWith('audio/') || card.matches?.('ms-audio-chunk');
    const tokenCount = /(?:[1-9]\d*(?:[,，]\d{3})*(?:\.\d+)?)\s*(?:tokens?\b|个?词元)/i.test(card.textContent || '');
    const play = audioCard && Array.from(card.querySelectorAll?.('button') || []).some(button =>
      visibleControl(button) && isEnabled(button) &&
      /^(?:play(?: audio)?|播放(?:音频)?|play_arrow|play_circle|play_circle_filled)$/i.test(controlLabel(button).trim()));
    // AI Studio may rename audio and render its own player without an HTML audio
    // element. A token count AND an available player are an explicit media receipt;
    // a filename, a token count alone, or an enabled Run button is insufficient.
    const ready = (image && image.complete && image.naturalWidth > 0) ||
      (audio && audio.readyState >= 2) || (tokenCount && play) ||
      ['ready','complete','uploaded'].includes(card.getAttribute('data-state'));
    return {state:ready ? 'confirmed' : 'pending',card};
  }

  async function dropAttachment(attachment) {
    const file = VidSiftAttachments.toFile(attachment);
    const existing = new Set(getAttachmentCards());
    const dt = new DataTransfer(); dt.items.add(file);
    const target = document.querySelector('main') || document.querySelector('textarea');
    if (!target) throw new Error('找不到附件上传区域');
    for (const type of ['dragenter','dragover','drop']) target.dispatchEvent(new DragEvent(type, {bubbles:true,dataTransfer:dt}));
    return {existing, card:null, mime:attachment.mime};
  }

  async function waitForFileAttached(fileName, existing, taskId, timeout = 300000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      assertNotCancelled(taskId);
      const result = attachmentState(fileName, existing);
      if (result.state === 'confirmed') return;
      if (result.state === 'failed') throw Object.assign(new Error(`附件上传失败：${fileName}，未自动发送`), {retryable:true,tile:result.card});
      await sleep(500);
    }
    throw new Error(`附件 ${fileName} 上传状态未确认，已停止发送；为避免重复附件，不自动重新上传`);
  }

  let retryFailedButton = null;
  function showFailedAttachmentRetry(error) {
    if (!error.retryable || !error.attachment) return;
    retryFailedButton?.remove();
    const button = document.createElement('button'); retryFailedButton = button;
    button.textContent = `重试失败附件：${error.attachment.name}`;
    button.style.cssText = 'position:fixed;right:16px;bottom:80px;z-index:999999;padding:10px;background:#1a73e8;color:white;border:0;border-radius:8px;cursor:pointer';
    button.addEventListener('click', async () => {
      if (_taskActive) return;
      button.disabled = true;
      try {
        const remove = error.tile?.querySelector('button[aria-label*="Remove"], button[aria-label*="Delete"], button[aria-label*="移除"]');
        if (!remove) throw new Error('找不到失败附件的移除控件，请先在页面移除失败附件，避免重复上传');
        remove.click();
        const existing = await dropAttachment(error.attachment);
        try { await waitForFileAttached(error.attachment.name, existing); } catch (e) { e.attachment = error.attachment; throw e; }
        button.remove(); retryFailedButton = null;
        showStatus('失败附件已重新上传；请检查所有附件后手动运行。');
      } catch (e) { showError(e.message); if (e.retryable) { error = e; button.disabled = false; } }
    });
    (document.body || document.documentElement).appendChild(button);
  }

  // --- Type prompt into textarea ---

  async function typePrompt(promptText) {
    const textarea = getPromptTextarea();
    if (!textarea) throw new Error('找不到 AI Studio 提示词输入框');

    textarea.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, promptText);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(300);
  }

  // --- Click Run button ---

  function submissionSnapshot() {
    return {
      turns: new Set(document.querySelectorAll('ms-chat-turn')),
      stop: new Set(Array.from(document.querySelectorAll('button')).filter(button =>
        visibleControl(button) && /^(?:stop(?: generating| generation| running)?|停止(?:生成|运行)?)$/i.test(controlLabel(button).trim())))
    };
  }

  function submissionAccepted(before) {
    const after = submissionSnapshot();
    return [...after.turns].some(turn => !before.turns.has(turn)) ||
      [...after.stop].some(button => !before.stop.has(button));
  }

  async function clickRunButton(timeout = 30000, taskId, verifyAttachments, acceptanceTimeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      assertNotCancelled(taskId);
      if (verifyAttachments) verifyAttachments();
      const runBtn = findRunButton();
      if (isEnabled(runBtn)) {
        if (document.querySelector('[role="dialog"], mat-dialog-container')) throw new Error('AI Studio 有未关闭的对话框，未自动发送');
        const before = submissionSnapshot();
        assertNotCancelled(taskId);
        runBtn.click();
        const clickedAt = Date.now();
        while (Date.now() - clickedAt < acceptanceTimeout) {
          if (submissionAccepted(before)) return;
          // Never click again, including after cancellation or an uncertain receipt.
          assertNotCancelled(taskId);
          await sleep(200);
        }
        throw new Error('已点击运行，但 AI Studio 是否接受尚未确认；为避免重复发送，不会自动再点，请检查页面');
      }
      await sleep(300);
    }
    throw new Error('未找到唯一且可用的 AI Studio 运行按钮，未自动发送');
  }

  function responseText(turn) {
    const chunks = Array.from(turn.querySelectorAll('ms-text-chunk')).filter(chunk => !chunk.closest('ms-thought-chunk'));
    const scopes = chunks.length ? chunks : [turn];
    const text = scopes.map(scope => scope.innerText || scope.textContent || '').join('\n');
    const codes = scopes.flatMap(scope => Array.from(scope.querySelectorAll('pre code, pre'))).filter(code =>
      /\d{2}:\d{2}:\d{2},\d{3}\s+-->/.test(code.textContent || ''));
    // Prefer the SRT code block over surrounding UI controls and explanation.
    const leaves = codes.filter(candidate => !codes.some(other => other !== candidate && candidate.contains(other)));
    if (leaves.length > 1) throw new Error('模型回复包含多个字幕代码块，未转交 GPT');
    const code = leaves[0];
    const marker = text.match(/\[转写完成 \d{2,}:[0-5]\d:[0-5]\d\]/g) || [];
    return code ? `${code.textContent.replace(/\[转写完成 \d{2,}:[0-5]\d:[0-5]\d\]/g, '').trim()}\n${marker.join('\n')}` : text;
  }

  async function waitForTranscript(before, taskId, duration, timeout = 900000) {
    if (!globalThis.VidSiftTranscript) throw new Error('转写完整性校验组件未加载，未转交 GPT');
    const started = Date.now();
    let lastText = '', stableSince = started;
    while (Date.now() - started < timeout) {
      assertNotCancelled(taskId);
      const turns = Array.from(document.querySelectorAll('ms-chat-turn')).filter(turn =>
        !before.has(turn) && turn.querySelector('.chat-turn-container.model') &&
        (!turn.querySelector('ms-thought-chunk') || Array.from(turn.querySelectorAll('ms-text-chunk')).some(chunk => !chunk.closest('ms-thought-chunk'))));
      if (turns.length > 1) throw new Error('出现多个新的模型回复，无法确定本次转写，未转交 GPT');
      const turn = turns[0];
      if (turn?.querySelector('[role="alert"], [data-state="error"], [data-state="truncated"], [data-finish-reason="MAX_TOKENS"], .error-message') ||
          document.querySelector('ms-error-banner [role="alert"], ms-chat-error')) throw new Error('AI Studio 转写生成失败，未转交 GPT');
      const text = turn ? responseText(turn) : '';
      if (text !== lastText) { lastText = text; stableSince = Date.now(); }
      const generating = submissionSnapshot().stop.size > 0;
      if (text && !generating && isEnabled(findRunButton()) && Date.now() - stableSince >= 1500) {
        assertNotCancelled(taskId);
        return VidSiftTranscript.parse(text, duration);
      }
      await sleep(250);
    }
    throw new Error('等待 AI Studio 完整转写超时，未转交 GPT；不会重复运行');
  }

  // --- Enable or disable temporary chat as needed ---

  function setTempChat(enabled) {
    const btn = document.querySelector('button[aria-label="Temporary chat toggle"]');
    if (!btn) return;
    const isActive = btn.classList.contains('ms-button-active');
    if (enabled && !isActive) {
      btn.click();
    } else if (!enabled && isActive) {
      btn.click();
    }
  }

  // --- Main handler ---

  async function handleUploadAndRun(attachments, prompt, tempChat, bgOpen, videoTitle, bvid, biliTabId, taskId, {relayToChatGPT = false, duration} = {}) {
    setTempChat(!!tempChat);
    await typePrompt(prompt);
    reportTranscribeTaskEvent('status','AI Studio 提示词已填写，正在添加附件...',biliTabId);
    const receipts = [];
    for (const attachment of attachments) {
      assertNotCancelled(taskId);
      if (attachment.mime.startsWith('audio/') && VidSiftAttachments.toFile(attachment).size < 1024) throw new Error('音频数据异常，下载可能失败，已中止');
      showStatus(`正在上传并确认附件：${attachment.name}`);
      reportTranscribeTaskEvent('status', `正在上传附件：${attachment.name}`, biliTabId);
      const existing = await dropAttachment(attachment);
      try { await waitForFileAttached(attachment.name, existing, taskId); } catch (e) { e.attachment = attachment; throw e; }
      receipts.push({attachment,existing});
    }

    showStatus('正在运行...');
    reportTranscribeTaskEvent('status', '正在运行...', biliTabId);
    assertNotCancelled(taskId);
    const beforeTurns = new Set(document.querySelectorAll('ms-chat-turn'));
    await clickRunButton(30000, taskId, () => {
      for (const {attachment,existing} of receipts) { if (attachmentState(attachment.name, existing).state !== 'confirmed') throw new Error('附件状态已改变，未自动发送'); }
    });
    let transcript;
    if (relayToChatGPT) {
      showStatus('AI Studio 正在转写，完成后将自动交给 GPT...');
      reportTranscribeTaskEvent('status', 'AI Studio 正在转写，等待完整字幕后交给 GPT。', biliTabId);
      transcript = await waitForTranscript(beforeTurns, taskId, duration);
      reportTranscribeTaskEvent('status', '完整字幕已核验，正在交给 GPT。', biliTabId);
    } else {
      reportTranscribeTaskEvent('done', '已提交到 AI Studio，当前页面可再次发起新任务。', biliTabId);
    }
    // Optional metadata must never open a modal before the critical submission.
    if (videoTitle && !cancelledTasks.has(taskId)) {
      try { await renamePromptTitle(videoTitle, bvid); }
      catch { console.warn('[ext] optional AI Studio title update failed'); }
    }

    if (bgOpen) scrollToResponseOnTabFocus();
    hideStatus();
    return transcript ? {transcript} : {};
  }

  // After clicking Run, scroll the new response turn into view the first time
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

      // Find model response turns that are NOT the thoughts/thinking section.
      // Thought turns contain ms-thought-chunk; the actual response turn does not.
      const modelTurns = document.querySelectorAll(
        'ms-chat-turn:has(.chat-turn-container.model):not(:has(ms-thought-chunk))'
      );
      console.log('[ext] modelTurns found:', modelTurns.length);
      const turn = modelTurns[modelTurns.length - 1];
      if (turn) {
        // AI Studio's ms-autoscroll-container will auto-scroll to the bottom while
        // generation is running. Wait for it to stop scrolling, then scroll to the
        // response turn. We detect "scroll stopped" by watching for 300ms of silence.
        const scroller = document.querySelector('ms-autoscroll-container');
        if (!scroller) {
          console.log('[ext] scroller not found, scrolling immediately');
          turn.scrollIntoView({ behavior: 'instant', block: 'start' });
          return;
        }
        let quietTimer = null;
        function doScroll() {
          console.log('[ext] scroll settled, scrolling to turn');
          scroller.removeEventListener('scroll', onScroll);
          turn.scrollIntoView({ behavior: 'instant', block: 'start' });
        }
        function onScroll() {
          console.log('[ext] scroll event on scroller, resetting quiet timer');
          clearTimeout(quietTimer);
          quietTimer = setTimeout(doScroll, 300);
        }
        scroller.addEventListener('scroll', onScroll);
        // Kick off immediately in case scrolling already stopped
        quietTimer = setTimeout(doScroll, 300);
        console.log('[ext] waiting for scroller to settle...');
      } else {
        console.log('[ext] no model response turn found');
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    console.log('[ext] visibilitychange listener registered');
  }

  // --- Rename the prompt title via the Edit dialog ---

  async function renamePromptTitle(title, bvid) {
    const editBtn = document.querySelector('button[aria-label="Edit prompt title and description"]');
    if (!editBtn) {
      console.warn('[ext] renamePromptTitle: edit button not found');
      return;
    }
    editBtn.click();
    console.log('[ext] renamePromptTitle: clicked edit button');

    // Wait for the dialog input to appear
    const start = Date.now();
    let nameInput = null;
    while (Date.now() - start < 5000) {
      nameInput = document.querySelector('input[aria-label="Prompt name text field"]');
      if (nameInput) break;
      await sleep(100);
    }
    if (!nameInput) {
      console.warn('[ext] renamePromptTitle: dialog input not found after 5s');
      return;
    }

    // Set the title using the native setter so Angular picks up the change
    const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeInputSetter.call(nameInput, title);
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));

    // Fill the description with bvid for easy backtracking
    if (bvid) {
      const descInput = document.querySelector('textarea[aria-label="Prompt description text field"]');
      if (descInput) {
        const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        nativeTextareaSetter.call(descInput, bvid);
        descInput.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        console.warn('[ext] renamePromptTitle: description textarea not found');
      }
    }

    await sleep(100);

    const saveBtn = document.querySelector('button[aria-label="Save title and description"]');
    if (saveBtn) {
      saveBtn.click();
      console.log('[ext] renamePromptTitle: clicked save button');
    } else {
      console.warn('[ext] renamePromptTitle: save button not found');
    }
  }

  // --- Wait for AI Studio to become interactive ---

  function waitForReady(timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (getPromptTextarea()) { resolve(); return; }
      const start = Date.now();
      const timer = setInterval(() => {
        if (getPromptTextarea()) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - start > timeout) {
          clearInterval(timer);
          reject(new Error('AI Studio 页面加载超时，请确认已登录后重试'));
        }
      }, 200);
    });
  }

  // --- Load prompt from storage, fallback to built-in file ---

  async function loadAIStudioPrompt() {
    const result = await chrome.storage.local.get('customAIStudioPrompt');
    if (result.customAIStudioPrompt != null) return result.customAIStudioPrompt;
    const res = await fetch(chrome.runtime.getURL('prompt_aistudio.txt'));
    return res.text();
  }

  // --- Message listener ---

  function startUploadTask(msg) {
      (async () => {
        try {
          showStatus('正在等待页面就绪...');
          reportTranscribeTaskEvent('status','AI Studio 已收到任务，正在等待提示词输入框...',msg.biliTabId);
          await waitForReady();
          reportTranscribeTaskEvent('status','AI Studio 输入框已就绪，正在准备提示词和附件...',msg.biliTabId);
          const attachments = VidSiftAttachments.normalizeMessage(msg, 'aistudio');
          const source = msg.source?.url || msg.sourceUrl || msg.bvid || msg.videoTitle;
          let prompt = VidSiftAttachments.contextualPrompt(msg.prompt ?? await loadAIStudioPrompt(), attachments, source);
          if (msg.relayToChatGPT === true) {
            const duration = Number(msg.duration);
            const knownDuration = Number.isFinite(duration) && duration > 0;
            const total = knownDuration ? Math.round(duration) : 0;
            const clock = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60].map(value => String(value).padStart(2, '0')).join(':');
            prompt += `\n\n本次自动转写协议：${knownDuration ? `音频实际时长为 ${duration} 秒；` : ''}请输出完整、按顺序编号且带毫秒时间戳的 SRT 字幕，只有全部音频已逐字转写后才在字幕之后单独输出 [转写完成 ${knownDuration ? clock : 'HH:MM:SS'}]。尾标时间必须对应完整音频时长；未完成、遇到错误或长度限制时不得伪造完成标记。`;
          }
          const payload = await handleUploadAndRun(attachments, prompt, msg.tempChat, msg.bgOpen, msg.videoTitle, msg.bvid, msg.biliTabId, msg.taskId, {relayToChatGPT:msg.relayToChatGPT === true,duration:msg.duration});
          reportTarget(msg, true, undefined, payload);
        } catch (e) {
          showFailedAttachmentRetry(e);
          reportTarget(msg, false, e.message);
          console.error('AISTUDIO_UPLOAD_AND_RUN failed:', e);
          reportTranscribeTaskEvent('error', `错误：${e.message}`, msg.biliTabId);
          showError(`错误：${e.message}`);
        } finally { _taskActive = false; _activeTaskId = null; }
      })();
  }
  const attachmentReceiver = globalThis.VidSiftAttachmentTransfer?.createReceiver({
    reserve(taskId) { if (_taskActive || cancelledTasks.has(taskId)) return false; _taskActive = true; _activeTaskId = taskId; return true; },
    release(taskId) { if (_activeTaskId === taskId) { _taskActive = false; _activeTaskId = null; } },
    isCancelled(taskId) { return cancelledTasks.has(taskId); },
    accept: startUploadTask,
  });
  globalThis.addEventListener?.('pagehide', () => attachmentReceiver?.dispose(), {once:true});

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if(msg.type==='VIDSIFT_AISTUDIO_PING'){sendResponse({ok:true,component:'aistudio',attachmentTransfer:!!attachmentReceiver});return;}

    const transferReply = attachmentReceiver?.handle(msg);
    if (transferReply) { sendResponse(transferReply); return; }
    if (msg.type === 'VIDSIFT_CANCEL_UPLOAD') { attachmentReceiver?.cancel(msg.taskId); cancelledTasks.set(msg.taskId,typeof msg.reason==='string'?msg.reason:'任务已取消'); sendResponse({ok:true}); return; }
    if (msg.type === 'VIDSIFT_AISTUDIO_UPLOAD_AND_RUN') {
      if (_taskActive) { sendResponse({ok:false,error:'已有附件任务正在处理'}); return; }
      _taskActive = true;
      _activeTaskId = msg.taskId || null;
      sendResponse({ ok: true });
      startUploadTask(msg);
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
