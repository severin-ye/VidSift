let isRunning = false;
let canClose = false;
let cachedVideoInfo = null;  // { bvid, aid, cid }
let cachedHasSubtitle = null; // true/false/null (null = not checked yet)
let transcribeService = 'aistudio'; // 'aistudio' | 'selfhosted' | 'local'
let localModel = null;
let localDevice = null;
let activeTranscribeTask = null;
let statusTabId = null;
let viewingTaskTarget = false;
let currentPlatform = 'bilibili';
let screenshotSettings = ScreenshotSettings.normalize();
let audioSettings = AudioSettings.normalize();
const screenshotCheckbox = document.getElementById('screenshotCheckbox');
const screenshotLabel = document.getElementById('screenshotLabel');
const cancelBtn = document.getElementById('cancelBtn');
document.getElementById('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
screenshotCheckbox.addEventListener('change', async () => {
 screenshotSettings = {...screenshotSettings, enabled:screenshotCheckbox.checked};
 screenshotLabel.textContent = screenshotCheckbox.checked ? '图片提取·开' : '图片提取·关';
 await chrome.storage.local.set({screenshotSettings}); updateUI();
});
cancelBtn.addEventListener('click', async () => {
 const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
 const result = await chrome.runtime.sendMessage({type:'CANCEL_VIDEO_TASK',tabId:statusTabId??tab.id});
 setStatus(result.ok ? '已请求取消当前视频任务' : '当前没有可取消的视频任务');
});

// DOM
const runBtn = document.getElementById('runBtn');
const errorBox = document.getElementById('errorBox');
const statusText = document.getElementById('statusText');
const tempChatCheckbox = document.getElementById('tempChatCheckbox');
const forceAIStudioCheckbox = document.getElementById('forceAIStudioCheckbox');
const forceAIStudioLabel = document.getElementById('forceAIStudioLabel');
const forceAIStudioLabelText = document.getElementById('forceAIStudioLabelText');
const bgOpenCheckbox = document.getElementById('bgOpenCheckbox');

// Restore checkbox state from localStorage (synchronous, no flicker)
tempChatCheckbox.checked = localStorage.getItem('tempChat') === 'true';
document.getElementById('tempChatLabel').textContent=tempChatCheckbox.checked?'临时聊天·开':'临时聊天·关';
forceAIStudioCheckbox.checked = localStorage.getItem('forceAIStudio') === 'true';
bgOpenCheckbox.checked = localStorage.getItem('bgOpen') === 'true';
document.getElementById('bgOpenLabel').textContent=bgOpenCheckbox.checked?'GPT后台打开·开':'GPT后台打开·关';

// Save checkbox state on change
tempChatCheckbox.addEventListener('change', () => {
  localStorage.setItem('tempChat', tempChatCheckbox.checked);
  document.getElementById('tempChatLabel').textContent=tempChatCheckbox.checked?'临时聊天·开':'临时聊天·关';
});

// 根据 transcribeService 和字幕状态更新按钮文案与复选框文案
function updateUI() {
  if (activeTranscribeTask?.active) {
    runBtn.textContent = '视频处理进行中';
    return;
  }
  if (runBtn.disabled) return;
  if (currentPlatform !== 'bilibili' || screenshotCheckbox.checked) {
   forceAIStudioLabelText.textContent = '始终使用音频处理';
   runBtn.textContent = screenshotCheckbox.checked ? '提取内容与图片并发送' : '提取字幕或音频并发送';
   return;
  }
  const noSubtitle = cachedHasSubtitle === false;
  const forceChecked = forceAIStudioCheckbox.checked;

  if (transcribeService === 'selfhosted') {
    // 自建服务场景
    forceAIStudioLabelText.textContent = '始终音频转写';
    if (noSubtitle || forceChecked) {
      runBtn.textContent = '音频转写并发送到ChatGPT';
    } else {
      runBtn.textContent = '发送字幕到 ChatGPT';
    }
  } else if (transcribeService === 'local') {
    // 本地推理场景
    forceAIStudioLabelText.textContent = '始终本地推理';
    if (noSubtitle || forceChecked) {
      runBtn.textContent = '本地推理并发送到 ChatGPT';
    } else {
      runBtn.textContent = '发送字幕到 ChatGPT';
    }
  } else {
    // AI Studio 场景（默认）
    forceAIStudioLabelText.textContent = '始终使用 AI Studio';
    if (noSubtitle || forceChecked) {
      runBtn.textContent = '转写音频并交给 ChatGPT 整理';
    } else {
      runBtn.textContent = '发送字幕到 ChatGPT';
    }
  }
}

forceAIStudioCheckbox.addEventListener('change', () => {
  localStorage.setItem('forceAIStudio', forceAIStudioCheckbox.checked);
  updateUI();
});

bgOpenCheckbox.addEventListener('change', () => {
  localStorage.setItem('bgOpen', bgOpenCheckbox.checked);
  document.getElementById('bgOpenLabel').textContent=bgOpenCheckbox.checked?'GPT后台打开·开':'GPT后台打开·关';
});

// Set initial UI based on restored checkbox state
updateUI();



// Show/hide error
function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.add('show');
}

function hideError() {
  errorBox.classList.remove('show');
}

function setStatus(msg) {
  statusText.textContent = msg + (canClose ? '（可关闭此窗口）' : '');
}

async function getActiveTranscribeTask(tabId) {
  statusTabId = tabId;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_TAB_TRANSCRIBE_STATUS', tabId });
    if (!result) throw new Error('扩展后台未响应，请在扩展管理页重新加载通用总结扩展');
    return result;
  } catch (e) {
    throw new Error(`无法连接扩展后台：${e.message}`);
  }
}

function applyActiveTranscribeTask(task) {
  activeTranscribeTask = task?.active ? task : null;
  cancelBtn.style.display = activeTranscribeTask?.active ? '' : 'none';
  if (activeTranscribeTask) {
    runBtn.disabled = true;
    setStatus(activeTranscribeTask.statusText || '当前页面已有音频转写任务进行中，请等待完成后再试。');
    updateUI();
    return true;
  }
  return false;
}

async function refreshActiveTranscribeTask(tabId) {
  const task = await getActiveTranscribeTask(tabId);
  if (applyActiveTranscribeTask(task)) {
    return task;
  }
  activeTranscribeTask = null;
  runBtn.disabled = false;
  updateUI();
  return task;
}

// Fetch video info (bvid, aid, cid) from Bilibili
async function fetchVideoInfo(pageUrl) {
  setStatus('正在获取视频信息...');

  const bvMatch = pageUrl.match(/\/video\/(BV[\w]+)/) || pageUrl.match(/[?&]bvid=(BV[\w]+)/);
  if (!bvMatch) {
    throw new Error('URL 中未找到 BV 号');
  }
  const bvid = bvMatch[1];

  // Get aid and cid from view API
  const viewUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
  const viewRes = await fetch(viewUrl,{credentials:'include'});
  const viewData = await viewRes.json();

  const aid = viewData?.data?.aid;
  if (!aid) {
    throw new Error(`视频信息获取失败 (code: ${viewData?.code}, msg: ${viewData?.message || '未知'})`);
  }

  // Determine cid based on page number (for multi-part videos)
  const pMatch = pageUrl.match(/[?&]p=(\d+)/);
  const pageNum = pMatch ? parseInt(pMatch[1], 10) : 1;
  const pages = viewData?.data?.pages;
  const cid = pages?.[pageNum - 1]?.cid || viewData?.data?.cid;
  if (!cid) {
    throw new Error(`未找到第 ${pageNum} P 的视频信息`);
  }

  const title = viewData?.data?.title || '';
  return { bvid, aid, cid, title, duration: pages?.[pageNum - 1]?.duration || viewData?.data?.duration || 0, page: pageNum };
}

// Fetch subtitle for given aid/cid, returns subtitle body or null
async function fetchSubtitle(bvid, aid, cid) {
  setStatus(`正在获取字幕... (${bvid})`);

  const playerUrl = `https://api.bilibili.com/x/player/wbi/v2?aid=${aid}&cid=${cid}`;
  const playerRes = await fetch(playerUrl,{credentials:'include'});
  const playerData = await playerRes.json();

  const subtitles = playerData?.data?.subtitle?.subtitles;
  if (!subtitles || subtitles.length === 0) {
    return null;
  }

  // Prefer Chinese AI subtitle
  const zhSub = subtitles.find(s => /zh/.test(s.lan)) || subtitles[0];
  if (!zhSub) {
    return null;
  }

  let subtitleUrl = zhSub.subtitle_url;
  if (subtitleUrl.startsWith('//')) subtitleUrl = 'https:' + subtitleUrl;

  const subRes = await fetch(subtitleUrl);
  const subData = await subRes.json();

  if (!subData?.body || subData.body.length === 0) {
    return null;
  }

  return { body: subData.body, lan: zhSub.lan };
}

// Fetch the smallest audio stream URL from playurl API
async function fetchSmallestAudioUrl(aid, cid) {
  const url = `https://api.bilibili.com/x/player/wbi/playurl?avid=${aid}&cid=${cid}&qn=32&fnver=0&fnval=4048&fourk=1`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.code !== 0) throw new Error(`playurl API error: ${data.message}`);
  const audio = data.data.dash.audio;
  const smallest = audio.reduce((min, a) => a.bandwidth < min.bandwidth ? a : min);

  // 过滤掉 mcdn.bilivideo.cn 域名的 URL，优先使用其他 CDN
  const isMcdn = (u) => { if (!u) return false; const h = new URL(u).hostname; return h === 'mcdn.bilivideo.cn' || h.endsWith('.mcdn.bilivideo.cn'); };
  const allUrls = [smallest.baseUrl, ...(smallest.backupUrl || [])];
  const filtered = allUrls.filter(u => !isMcdn(u));
  const candidates = filtered.length > 0 ? filtered : allUrls;
  return { baseUrl: candidates[0], backupUrl: candidates[1] };
}

// Convert seconds to SRT time format: HH:MM:SS,mmm
function secondsToSrtTime(seconds) {
  return VidSiftPlatforms.srtTime(seconds);
  /*
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  */
}

// Convert Bilibili subtitle JSON array to SRT format string
function subtitleToSrt(body) {
  return body.map((item, i) => {
    return `${i + 1}\n${secondsToSrtTime(item.from)} --> ${secondsToSrtTime(item.to)}\n${item.content}`;
  }).join('\n\n');
}

// Main flow
async function run() {
  if (isRunning) return;

  hideError();
  isRunning = true;
  canClose = false;
  let handedOff = false;

  try {
    // Get current tab URL
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const pageUrl = tab.url || '';

    const taskStatus = await getActiveTranscribeTask(tab.id);
    if (taskStatus.active) {
      applyActiveTranscribeTask(taskStatus);
      showError('当前页面已有音频转写任务进行中，请等待完成后再试。');
      return;
    }

    if (!VidSiftPlatforms.identify(pageUrl)) {
      showError('请在 B站、YouTube 或抖音视频页面使用此扩展。');
      return;
    }

    const identity = VidSiftPlatforms.identify(pageUrl);
    if (identity.platform !== 'bilibili' || screenshotCheckbox.checked) {
      if (transcribeService === 'local') {
        const granted = await chrome.permissions.request({origins:['https://*.huggingface.co/*','https://cdn.jsdelivr.net/*']});
        if (!granted) throw new Error('本地模型权限未授予，请在设置页完成配置');
      }
      const config = await chrome.storage.local.get(['selfHostedApiUrl','selfHostedApiToken']);
      let source = identity;
      if (identity.platform === 'bilibili') {
        const info = await fetchVideoInfo(pageUrl);
        const subtitle = forceAIStudioCheckbox.checked ? null : await fetchSubtitle(info.bvid, info.aid, info.cid);
        source = {...identity,title:info.title,duration:info.duration,subtitle,bili:{aid:info.aid,cid:info.cid,pageUrl:'https://www.bilibili.com/video/'+info.bvid+'?p='+info.page}};
      }
      const port = chrome.runtime.connect({name:'vidsift-video'});
      port.onMessage.addListener(msg => {
        if (msg.type === 'STATUS') setStatus(msg.text);
        if (msg.type === 'ERROR' || msg.type === 'DONE') {
          if (msg.type === 'ERROR') showError(msg.text); else setStatus(msg.text);
          isRunning = false; cancelBtn.style.display='none'; activeTranscribeTask=null; runBtn.disabled=false; updateUI();
        }
      });
      port.onDisconnect.addListener(()=>{if(isRunning){isRunning=false;runBtn.disabled=false;setStatus('弹窗连接已断开；重新打开扩展可查看处理状态');}});
      port.postMessage({type:'START_VIDEO_TASK',sourceUrl:pageUrl,source,openerTabId:tab.id,bgOpen:bgOpenCheckbox.checked,tempChat:tempChatCheckbox.checked,forceAudio:forceAIStudioCheckbox.checked,screenshotSettings,audioSettings,transcribeService,model:localModel,device:localDevice,selfHostedUrl:config.selfHostedApiUrl,selfHostedToken:config.selfHostedApiToken});
      handedOff=true; canClose=true;cancelBtn.style.display='';runBtn.disabled=true;setStatus('已移交后台；重新打开扩展可查看进度');return;
    }

    // Get video info (use cache from init if available)
    const { bvid, aid, cid, title: videoTitle, duration } = cachedVideoInfo || await fetchVideoInfo(pageUrl);

    // 判断是否使用自建服务（无字幕 or 强制勾选，且服务来源为 selfhosted）
    const forceChecked = forceAIStudioCheckbox.checked;

    // Try fetching subtitles (skip if forced)
    let subtitle = null;
    if (!forceChecked) {
      subtitle = cachedHasSubtitle === false ? null : await fetchSubtitle(bvid, aid, cid);
    }

    const noSubtitle = !subtitle;

    // Connect to background service worker
    setStatus('正在移交任务，请勿关闭此窗口...');
    const port = chrome.runtime.connect({ name: 'bilibili-subtitle' });

    port.onMessage.addListener((msg) => {
      if (msg.type === 'STATUS') { if (!canClose) setStatus(msg.text); return; }
      if (msg.type === 'ERROR') {
        showError(msg.text);
        isRunning = false;
        void refreshActiveTranscribeTask(tab.id);
      }
      if (msg.type === 'DONE') {
        canClose = true;
        setStatus(msg.text);
        isRunning = false;
        void refreshActiveTranscribeTask(tab.id);
      }
    });

    port.onDisconnect.addListener(() => {
      if (isRunning) {
        showError('后台任务连接已断开，请重试。');
        isRunning = false;
        void refreshActiveTranscribeTask(tab.id);
      }
    });

    if (!noSubtitle && !forceChecked) {
      // 有字幕 → 发送字幕到 ChatGPT（两种服务来源均走此流程）
      const srtContent = subtitleToSrt(subtitle.body);
      const title = videoTitle || tab.title || 'bilibili-subtitle';
      const fileName = bvid ? `${bvid}_${title}.srt` : `${title}.srt`;

      port.postMessage({
        type: 'START_TASK',
        sourceUrl: pageUrl,
        taskType: 'chatgpt',
        openerTabId: tab.id,
        biliTabId: tab.id,
        bgOpen: bgOpenCheckbox.checked,
        tempChat: tempChatCheckbox.checked,
        file: { name: fileName, content: srtContent },
        videoTitle,
        bvid,
      });
      // 字幕数据已完整传入 background，popup 不再需要待机
      canClose = true;
      setStatus('字幕已移交后台处理。');
      isRunning = false;
      runBtn.disabled = false;
      handedOff = true;
    } else if (transcribeService === 'selfhosted') {
      // 无字幕 + 自建服务 → 音频转写并发送到 ChatGPT
      setStatus('正在获取音频 URL...');
      const audioUrls = await fetchSmallestAudioUrl(aid, cid);

      // 读取自建服务配置
      const storageResult = await chrome.storage.local.get(['selfHostedApiUrl', 'selfHostedApiToken']);
      const selfHostedUrl = storageResult.selfHostedApiUrl || '';
      const selfHostedToken = storageResult.selfHostedApiToken || '';

      if (!selfHostedUrl) {
        showError('请先在设置页配置自建服务 API 地址。');
        return;
      }

      port.postMessage({
        type: 'START_TASK',
        sourceUrl: pageUrl,
        taskType: 'selfhosted',
        openerTabId: tab.id,
        bgOpen: bgOpenCheckbox.checked,
        tempChat: tempChatCheckbox.checked,
        audioUrls,
        biliTabId: tab.id,
        videoTitle,
        selfHostedUrl,
        selfHostedToken,
      });
      canClose = true;
      setStatus('后台继续处理，重新打开扩展可查看进度。');
    } else if (transcribeService === 'local') {
      // 无字幕 + 本地推理 → 本地转写并发送到 ChatGPT
      if (!localModel || !localDevice) throw new Error('本地推理配置缺失，请在设置页重新选择模型和设备。');
      // 确保权限仍然有效（开发模式重新加载扩展后可选权限会重置）
      const ALL_LOCAL_ORIGINS = [
        'https://*.huggingface.co/*',
        'https://cdn.jsdelivr.net/*',
      ];
      const permGranted = await chrome.permissions.request({ origins: ALL_LOCAL_ORIGINS }).catch(() => false);
      if (!permGranted) throw new Error('权限未授予，请在设置页重新选择「本地推理」以授权。');
      setStatus('正在获取音频 URL...');
      const audioUrls = await fetchSmallestAudioUrl(aid, cid);

      port.postMessage({
        type: 'START_TASK',
        sourceUrl: pageUrl,
        taskType: 'local',
        openerTabId: tab.id,
        bgOpen: bgOpenCheckbox.checked,
        tempChat: tempChatCheckbox.checked,
        audioUrls,
        biliTabId: tab.id,
        videoTitle,
        bvid,
        model: localModel,
        device: localDevice,
      });
      canClose = true;
      setStatus('后台继续处理，重新打开扩展可查看进度。');
    } else {
      // 无字幕 + AI Studio → 发送音频到 AI Studio
      setStatus('正在获取音频 URL...');
      const audioUrls = await fetchSmallestAudioUrl(aid, cid);

      port.postMessage({
        type: 'START_TASK',
        sourceUrl: pageUrl,
        taskType: 'aistudio',
        duration,
        openerTabId: tab.id,
        bgOpen: bgOpenCheckbox.checked,
        tempChat: tempChatCheckbox.checked,
        audioUrls,
        biliTabId: tab.id,
        videoTitle,
        bvid,
      });
      // 任务已移交后台，popup 不再需要待机（后台将继续下载音频并在 AI Studio 页面处理）
      canClose = true;
      setStatus('后台继续处理，重新打开扩展可查看进度。');
    }

    handedOff = true;
    // Status will be updated by background notify messages
  } catch (e) {
    showError(`错误：${e.message}`);
  } finally {
    if (!handedOff) {
      isRunning = false;
      if (!activeTranscribeTask?.active) {
        runBtn.disabled = false;
      }
    }
  }
}

runBtn.addEventListener('click', run);

// Init: load transcribeService config, check if current page is bilibili video, pre-check subtitle
(async () => {
  try {
    // 先加载服务来源配置
    const storageResult = await chrome.storage.local.get(['transcribeService', 'localModel', 'localDevice', 'screenshotSettings','audioSettings']);
    screenshotSettings = ScreenshotSettings.normalize(storageResult.screenshotSettings);
    audioSettings = AudioSettings.normalize(storageResult.audioSettings);
    screenshotCheckbox.checked=screenshotSettings.enabled;
    screenshotLabel.textContent=screenshotSettings.enabled?'图片提取·开':'图片提取·关';
    transcribeService = storageResult.transcribeService || 'aistudio';
    localModel = storageResult.localModel || null;
    localDevice = storageResult.localDevice || null;
    updateUI();

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const pageUrl = tab.url || '';
    currentPlatform=VidSiftPlatforms.identify(pageUrl)?.platform || '';
    const taskStatus = await getActiveTranscribeTask(tab.id);
    if (!VidSiftPlatforms.identify(pageUrl)) {
      viewingTaskTarget=true;
      if(taskStatus.sourceTabId!==tab.id){
        if(!applyActiveTranscribeTask(taskStatus)){runBtn.textContent='视频任务已结束';setStatus(taskStatus.statusText||'视频任务已结束');}
      }else{runBtn.textContent='请从视频页开始';setStatus('请在 B站、YouTube 或抖音视频页面使用');}
      runBtn.disabled=true;return;
    }
    activeTranscribeTask = taskStatus.active ? taskStatus : null;
    if (currentPlatform !== 'bilibili') {
      forceAIStudioLabel.style.display=''; runBtn.disabled=false;
      if(!applyActiveTranscribeTask(taskStatus)) {setStatus(taskStatus.statusText || '已识别'+(currentPlatform==='youtube'?' YouTube':'抖音')+'视频，点击后提取内容');updateUI();}
      return;
    }

    try {
      cachedVideoInfo = await fetchVideoInfo(pageUrl);
      const subtitle = await fetchSubtitle(cachedVideoInfo.bvid, cachedVideoInfo.aid, cachedVideoInfo.cid);
      cachedHasSubtitle = !!subtitle;
      updateUI();
      if (cachedHasSubtitle) {
        forceAIStudioLabel.style.display = '';
        setStatus(`发现 ${subtitle.lan} 字幕 `);
      } else {
        setStatus('未发现可用字幕');
      }
    } catch (e) {
      // Pre-check failed, run() will retry
      setStatus('字幕探测失败，将在点击时重试');
    } finally {
      if (!applyActiveTranscribeTask(activeTranscribeTask)) {
        runBtn.disabled = false;
        if(taskStatus.statusText)setStatus(taskStatus.statusText);
      }
      updateUI();
    }
  } catch (e) {
    showError(`扩展初始化失败：${e.message}`);
    setStatus('请刷新视频页并重新打开扩展；若仍失败，请在扩展管理页重新加载通用总结扩展。');
    runBtn.disabled = true;
    runBtn.textContent = '初始化失败';
  }
})();

// Reopened popups follow worker state; the video page carries no status overlay.
setInterval(async()=>{
 if(statusTabId==null||(!activeTranscribeTask?.active&&!isRunning))return;
 try{
  const state=await getActiveTranscribeTask(statusTabId);
  if(state.active){applyActiveTranscribeTask(state);return;}
  activeTranscribeTask=null;isRunning=false;runBtn.disabled=viewingTaskTarget;cancelBtn.style.display='none';
  if(viewingTaskTarget)runBtn.textContent='视频任务已结束';
  if(state.statusText)setStatus(state.statusText);updateUI();
 }catch(e){showError(e.message);}
},1000);
