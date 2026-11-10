(() => {
'use strict';
if (globalThis.__vidsiftBiliBridgeVersion === '5.0.2') return;
globalThis.__vidsiftBiliBridgeVersion = '5.0.2';

// Track the active download's requestId to filter spurious progress messages.
let _activeRequestId = null;

// Forward download progress from MAIN world to background service worker.
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data) return;
  if (event.data.type !== 'VIDSIFT_BILI_V2_FETCH_PROGRESS') return;
  if (!_activeRequestId || event.data.requestId !== _activeRequestId) return;
  chrome.runtime.sendMessage({
    type: 'VIDSIFT_BILI_V2_FETCH_PROGRESS',
    loaded: event.data.loaded,
    total: event.data.total,
  }).catch(() => {});
});

// Runs in the ISOLATED world — bridges chrome.tabs.sendMessage from the
// background to the MAIN world content script via window.postMessage.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'VIDSIFT_BILI_PING') {
    const requestId = crypto.randomUUID();
    const finish = (result) => {
      window.removeEventListener('message', handler);
      clearTimeout(timer);
      sendResponse(result);
    };
    const handler = (event) => {
      if (event.source !== window || event.data?.type !== 'VIDSIFT_BILI_MAIN_READY' || event.data.requestId !== requestId) return;
      finish({ ok: true, component: 'bilibili', mainReady: true });
    };
    const timer = setTimeout(() => finish({ ok: false, component: 'bilibili', error: 'B站页面音频桥接脚本未就绪，请刷新视频页面后重试' }), 1200);
    window.addEventListener('message', handler);
    window.postMessage({ type: 'VIDSIFT_BILI_MAIN_PING', requestId }, '*');
    return true;
  }
  if (msg.type === 'VIDSIFT_BILI_V2_FETCH_AUDIO') {
    const requestId = crypto.randomUUID();
    _activeRequestId = requestId;

    const handler = (event) => {
      if (event.source !== window || !event.data) return;
      if (event.data.type !== 'VIDSIFT_BILI_V2_FETCH_RESULT' || event.data.requestId !== requestId) return;
      window.removeEventListener('message', handler);
      _activeRequestId = null;
      sendResponse(event.data.result);
    };
    window.addEventListener('message', handler);

    window.postMessage({ type: 'VIDSIFT_BILI_V2_FETCH_AUDIO', urls: msg.urls, requestId }, '*');
    return true; // keep channel open for async sendResponse
  }

  if (msg.type === 'SELF_HOSTED_TRANSCRIBE') {
    handleSelfHostedTranscribe(msg);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'EXT_STATUS') {
    showOverlay(msg.text);

    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'EXT_ERROR') {
    showOverlay(msg.text);

    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'EXT_HIDE_STATUS') {
    hideOverlay();
    sendResponse({ ok: true });
    return false;
  }
});

// ---- 状态浮层 ----

let _overlay = null;
let _sourceStatus = "";
let _overlayClose = null;

function reportTranscribeTaskEvent(state, text, biliTabId, taskId) {
  chrome.runtime.sendMessage({
    type: 'TRANSCRIBE_TASK_EVENT',
    taskId,
    state,
    text,
    biliTabId,
  }).catch(() => {});
}

// Source-page progress is retained by the worker and read from the popup.
function showOverlay(text) { _sourceStatus=text; }
function hideOverlay() { _overlay?.remove(); _overlay=null; }

// ---- 自建服务转写流程 ----

async function handleSelfHostedTranscribe(msg) {
  const {
    audioUrls, selfHostedUrl, selfHostedToken,
    videoTitle, openerTabId, bgOpen, tempChat, biliTabId,
  } = msg;

  // 获取当前页面 URL 用于提取 bvid
  const bvMatch = location.href.match(/\/video\/(BV[\w]+)/);
  const bvid = bvMatch ? bvMatch[1] : '';

  showOverlay('正在准备音频转写...');
  reportTranscribeTaskEvent('status', '正在准备音频转写...', biliTabId, msg.taskId);

  // 通过 background 代理 SSE 请求（service worker 可访问任意 URL）
  const port = chrome.runtime.connect({ name: 'bilibili-sse-proxy' });

  // 构造请求体：音频 URL + 仅传递必要 headers
  const headers = {
    'Authorization': `Bearer ${selfHostedToken}`,
    'Content-Type': 'application/json',
  };

  const requestBody = JSON.stringify({
    url: audioUrls.baseUrl,
    headers: {
      'User-Agent': navigator.userAgent,
      'Referer': location.href,
      'Origin': location.origin,
    },
  });

  port.postMessage({
    type: 'START_SSE',
    taskId: msg.taskId,
    url: `${selfHostedUrl}/transcribe`,
    headers,
    body: requestBody,
  });

  port.onMessage.addListener(async (sseMsg) => {
    if (sseMsg.type === 'SSE_EVENT') {
      const { event, data } = sseMsg;

      if (event === 'queue') {
        try {
          const parsed = JSON.parse(data);
          showOverlay(`排在第 ${parsed.position} 位，等待转写...`);
          reportTranscribeTaskEvent('status', `排在第 ${parsed.position} 位，等待转写...`, biliTabId, msg.taskId);
        } catch (e) {
          showOverlay('排队等待中...');
          reportTranscribeTaskEvent('status', '排队等待中...', biliTabId, msg.taskId);
        }
      } else if (event === 'progress') {
        try {
          const parsed = JSON.parse(data);
          showOverlay(`正在转写中... ${parsed.percent}%`);
          reportTranscribeTaskEvent('status', `正在转写中... ${parsed.percent}%`, biliTabId, msg.taskId);
        } catch (e) {
          showOverlay('正在转写中...');
          reportTranscribeTaskEvent('status', '正在转写中...', biliTabId, msg.taskId);
        }
      } else if (event === 'converting') {
        showOverlay('正在转换中...');
        reportTranscribeTaskEvent('status', '正在转换中...', biliTabId, msg.taskId);
      } else if (event === 'result') {
        try {
          const parsed = JSON.parse(data);
          const srtContent = parsed.srt || '';
          showOverlay('转写完成，正在发送到 ChatGPT...');
          reportTranscribeTaskEvent('status', '转写完成，正在发送到 ChatGPT...', biliTabId, msg.taskId);
          port.disconnect();

          // 将 SRT 发送给 background，由 background 打开 ChatGPT 并发送
          const result = await chrome.runtime.sendMessage({
            type: 'SELF_HOSTED_SRT_RESULT',
            taskId: msg.taskId,
            srtContent,
            videoTitle,
            bvid,
            openerTabId,
            bgOpen,
            tempChat,
          });

          if (result && result.ok) {
            showOverlay('已发送到 ChatGPT！');
            reportTranscribeTaskEvent('done', '已发送到 ChatGPT！', biliTabId, msg.taskId);
            setTimeout(hideOverlay, 3000);
          } else {
            showOverlay(`发送失败：${result?.error || '未知错误'}`);
            reportTranscribeTaskEvent('error', `发送失败：${result?.error || '未知错误'}`, biliTabId, msg.taskId);
          }
        } catch (e) {
          showOverlay(`解析结果失败：${e.message}`);
          reportTranscribeTaskEvent('error', `解析结果失败：${e.message}`, biliTabId, msg.taskId);
        }
      } else if (event === 'error') {
        try {
          const parsed = JSON.parse(data);
          showOverlay(`转写失败：${parsed.error || data}`);
          reportTranscribeTaskEvent('error', `转写失败：${parsed.error || data}`, biliTabId, msg.taskId);
        } catch (e) {
          showOverlay(`转写失败：${data}`);
          reportTranscribeTaskEvent('error', `转写失败：${data}`, biliTabId, msg.taskId);
        }
        port.disconnect();
      }
    } else if (sseMsg.type === 'SSE_ERROR') {
      showOverlay(`连接失败：${sseMsg.error}`);
      reportTranscribeTaskEvent('error', `连接失败：${sseMsg.error}`, biliTabId, msg.taskId);
      port.disconnect();
    } else if (sseMsg.type === 'SSE_DONE') {
      // 正常结束（result 事件已处理）
    }
  });

  port.onDisconnect.addListener(() => {
    // port 断开时如果浮层还在显示"转换中"，说明异常断开
    if (_sourceStatus.includes('转换中')) {
      showOverlay('连接已断开，请重试。');
      reportTranscribeTaskEvent('error', '连接已断开，请重试。', biliTabId, msg.taskId);
    }
  });
}

})();
