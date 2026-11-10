// Isolated Edge navigation fixture. tabs.create and target navigation are real:
// no about:blank staging, target goto, daily profile, login, or security overrides.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..'), art = path.join(root, '.task-artifacts');
fs.mkdirSync(art, { recursive: true });
const extension = process.env.VIDSIFT_EXTENSION_ROOT || root;
const id = 'kggdkncbamdlhhihfkeldbbkppkgihad';
const profile = fs.mkdtempSync(path.join(art, 'background-handoff-profile-'));
const sourceURL = 'https://www.bilibili.com/video/BV1uLpn6AEtS/';
const report = { fixtures: true, privateProfileUsed: false, tabsCreateUnmodified: true, targetGotoUsed: false, profile, extension, requests: [], notifications: [], checks: [] };
const srt = '1\n00:00:00,000 --> 00:00:20,000\nComplete synthetic transcript.\n\n[转写完成 00:00:20]';
const slowResource=process.env.VIDSIFT_HANDOFF_SLOW_RESOURCE==='1';
const aiHTML = `<!doctype html><meta charset="utf-8"><title>Background AI fixture</title>${slowResource?'<img src="/fixture-delayed-image">':''}<main><textarea></textarea><button type="button" aria-label="Run">Run</button></main><script>
window.uploads=[];window.sent=[];
document.querySelector('main').addEventListener('drop',event=>{event.preventDefault();for(const f of event.dataTransfer.files){window.uploads.push({name:f.name,size:f.size});window.dropReadyState=document.readyState;const card=document.createElement('ms-audio-chunk');card.textContent=f.name;card.dataset.state='ready';document.querySelector('main').append(card);}});
document.querySelector('button').onclick=()=>{window.sent.push(document.querySelector('textarea').value);const turn=document.createElement('ms-chat-turn');turn.innerHTML='<div class="chat-turn-container model"><ms-text-chunk style="white-space:pre-wrap"></ms-text-chunk></div>';turn.querySelector('ms-text-chunk').textContent=${JSON.stringify(srt)};document.querySelector('main').append(turn);};
</script>`;
const chatHTML = `<!doctype html><meta charset="utf-8"><title>GPT fixture</title><form><div id="prompt-textarea" contenteditable="true"></div><input type="file" aria-label="Attach files"><button type="button" id="composer-submit-button" aria-label="Send">Send</button></form><script>
window.uploads=[];window.sent=[];document.querySelector('input').onchange=async event=>{for(const f of event.target.files){window.uploads.push({name:f.name,text:await f.text()});const tile=document.createElement('div');tile.className='file-tile';tile.setAttribute('role','group');tile.setAttribute('aria-label',f.name);tile.textContent=f.name;document.querySelector('form').append(tile);}};document.querySelector('button').onclick=()=>{window.sent.push(document.querySelector('#prompt-textarea').textContent);document.querySelector('#prompt-textarea').textContent='';};
</script>`;
let context, worker, control, source;
(async () => {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    ...(process.env.VIDSIFT_BROWSER_EXE ? { executablePath: process.env.VIDSIFT_BROWSER_EXE } : { channel: 'msedge' }),
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
  });
  context.on('request', request => { if (request.resourceType() === 'document' || request.url().includes('fixture')) report.requests.push({ url: request.url(), type: request.resourceType() }); });
  context.on('requestfailed', request => report.requests.push({ failed: request.url(), error: request.failure()?.errorText }));
  await context.route('https://www.bilibili.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Active source fixture</title><video></video>' }));
  await context.route('https://fixture.bilivideo.com/**', route => route.fulfill({ contentType: 'audio/mp4', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(path.join(root, 'test/sample.m4a')) }));
  const fixtureRoute = html => route => route.request().url().includes('/fixture-worker.js')
    ? route.fulfill({ contentType: 'application/javascript', body: `self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));self.addEventListener('fetch',event=>{if(new URL(event.request.url).pathname==='/fixture-delayed-image'){event.respondWith(new Promise(resolve=>setTimeout(()=>resolve(new Response('',{headers:{'Content-Type':'image/png'}})),30000)));return;}if(event.request.mode==='navigate')event.respondWith(new Response(${JSON.stringify(html)},{headers:{'Content-Type':'text/html'}}));});` })
    : route.fulfill({ contentType: 'text/html', body: html });
  await context.route('https://aistudio.google.com/**', fixtureRoute(aiHTML));
  await context.route('https://chatgpt.com/**', fixtureRoute(chatHTML));
  // Recovery for Playwright missing extension-created tabs' very first request:
  // install a fixture site worker before the real background-navigation test.
  // This changes only the isolated mock sites, never extension tabs.create.
  // Set VIDSIFT_HANDOFF_SITE_WORKER=0 only to reproduce the cold first-request
  // interception diagnostic; that mode may reach the real site's login page.
  if (process.env.VIDSIFT_HANDOFF_SITE_WORKER !== '0') {
    report.fixtureSiteWorkers = true;
    for (const domain of ['https://aistudio.google.com/', 'https://chatgpt.com/']) {
      const warm = await context.newPage();
      await warm.goto(domain);
      await warm.evaluate(async () => { await navigator.serviceWorker.register('/fixture-worker.js', { scope: '/' }); await navigator.serviceWorker.ready; });
      await warm.close();
    }
  }
  control = await context.newPage();
  await control.goto(`chrome-extension://${id}/options.html`);
  source = await context.newPage();
  await source.goto(sourceURL);
  await source.bringToFront();
  worker = context.serviceWorkers().find(candidate => candidate.url().includes(id)) || await context.waitForEvent('serviceworker');
  await worker.evaluate(() => {
    globalThis.__handoff = { created: [], updates: [] };
    chrome.tabs.onCreated.addListener(tab => __handoff.created.push({ id: tab.id, active: tab.active, url: tab.url, pendingUrl: tab.pendingUrl }));
    chrome.tabs.onUpdated.addListener((id, info) => __handoff.updates.push({ id, ...info }));
  });
  const sourceTab = await control.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), sourceURL);
  assert.ok(sourceTab);
  assert.equal(sourceTab.active, true);
  await control.evaluate(({ sourceTab, sourceURL }) => {
    window.__notes = [];
    window.__port = chrome.runtime.connect({ name: 'bilibili-subtitle' });
    window.__port.onMessage.addListener(message => window.__notes.push(message));
    window.__port.postMessage({ type: 'START_TASK', taskType: 'aistudio', sourceUrl: sourceURL,
      openerTabId: sourceTab.id, biliTabId: sourceTab.id, duration: 20, bgOpen: true, tempChat: false,
      videoTitle: 'Background fixture', bvid: 'BV1uLpn6AEtS',
      audioUrls: { baseUrl: 'https://fixture.bilivideo.com/audio.m4a' } });
  }, { sourceTab, sourceURL });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    report.notifications = await control.evaluate(() => window.__notes);
    if (report.notifications.some(note => ['DONE', 'ERROR'].includes(note.type))) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  report.navigation = await worker.evaluate(() => globalThis.__handoff);
  report.activeTabs = await control.evaluate(() => chrome.tabs.query({ active: true }));
  report.pages = await Promise.all(context.pages().map(async page => ({ url: page.url(),
    state: await page.evaluate(() => ({ ready: document.readyState, title: document.title, uploads: window.uploads, sent: window.sent, dropReadyState:window.dropReadyState, text: document.body?.innerText?.slice(0, 500) })).catch(error => ({ error: error.message })) })));
  assert.equal(report.activeTabs.some(tab => tab.id === sourceTab.id), true, 'background targets must leave the source active');
  const ai = report.pages.find(page => page.url.startsWith('https://aistudio.google.com/'));
  assert.ok(ai, 'AI Studio target created');
  assert.equal(ai.state.uploads?.length, 1, 'audio payload reached actual navigation target');
  assert.equal(ai.state.sent?.length, 1, 'prompt sent once');
  assert.ok(ai.state.sent[0].length > 0);
  if(slowResource){assert.notEqual(ai.state.dropReadyState,'complete');report.checks.push('upload begins while an unrelated image keeps the document loading');}
  const gpt = report.pages.find(page => page.url.startsWith('https://chatgpt.com/'));
  assert.equal(gpt?.state.uploads?.length, 1, 'complete transcript forwarded');
  assert.match(gpt.state.uploads[0].text, /Complete synthetic transcript/);
  assert.equal(gpt.state.sent.length, 1);
  assert.ok(report.navigation.created.every(tab => tab.active === false));
  assert.ok(report.notifications.some(note => note.type === 'DONE'));
  report.checks.push('unmodified inactive tabs.create navigates both targets', 'active source remains active', 'one audio upload and prompt receipt', 'one full SRT GPT handoff');
  const taskPopup=await context.newPage();const aiPage=context.pages().find(page=>page.url().startsWith('https://aistudio.google.com/'));
  await aiPage.bringToFront();await taskPopup.goto(`chrome-extension://${id}/popup.html`);
  await taskPopup.waitForFunction(()=>document.querySelector('#runBtn').textContent==='视频任务已结束');
  assert.match(await taskPopup.locator('#statusText').textContent(),/ChatGPT/);
  assert.equal(await taskPopup.locator('#runBtn').isDisabled(),true);
  report.checks.push('popup opened on AI Studio resolves retained video task result instead of unsupported-page message');
  report.passed = true;
})().catch(error => { report.passed = false; report.error = error.stack; process.exitCode = 1; })
  .finally(async () => {
    if (context) await context.close();
    // Receipts retain counts and prompt lengths, never the user's prompt text.
    for (const page of report.pages || []) {
      if (page.state.sent) page.state.sent = page.state.sent.map(text => ({ length: text.length }));
    }
    fs.writeFileSync(path.join(art, 'background-handoff-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  });
