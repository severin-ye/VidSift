const test = require('node:test');
const assert = require('node:assert/strict');
const audio = require('../audio-settings');
test('audio defaults and untrusted values stay inside supported settings', () => {
  for (const value of [null, [], {bitrate:'8k',channels:'surround',sourceBitrate:0}]) {
    assert.deepEqual(audio.normalize(value), audio.DEFAULTS);
  }
  assert.deepEqual(audio.normalize({bitrate:'96k',channels:'keep',sourceBitrate:'128',url:'private'}), {bitrate:'96k',channels:'keep',sourceBitrate:128});
  assert.equal(audio.STORAGE_KEY, 'audioSettings');
});

test('saving and resetting audio settings leaves other settings and drafts intact', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {value:'', disabled:false, handlers:{}, classList:{toggle(){}}, addEventListener(type, handler){this.handlers[type]=handler;}});
    return elements.get(id);
  }
  element('promptTextarea').value = 'unsaved prompt draft';
  element('screenshot-interval').value = '17';
  const stored = {customPrompt:'saved prompt',screenshotSettings:{interval:9},audioSettings:{...audio.DEFAULTS,bitrate:'128k'}};
  const code = fs.readFileSync(require.resolve('../options.js'),'utf8').split('// Audio settings are saved/reset independently; other drafts remain untouched.')[1];
  vm.runInNewContext(code, {AudioSettings:audio, document:{getElementById:element}, chrome:{storage:{local:{
    get:async key=>({[key]:stored[key]}),set:async values=>Object.assign(stored,values),remove:async key=>{delete stored[key];}
  }}}});
  await new Promise(resolve=>setImmediate(resolve));
  element('audio-bitrate').value='96k';
  await element('audio-save').handlers.click();
  assert.equal(stored.audioSettings.bitrate,'96k');
  await element('audio-reset').handlers.click();
  assert.equal(stored.audioSettings,undefined);
  assert.equal(stored.customPrompt,'saved prompt');
  assert.deepEqual(stored.screenshotSettings,{interval:9});
  assert.equal(element('promptTextarea').value,'unsaved prompt draft');
  assert.equal(element('screenshot-interval').value,'17');
});
