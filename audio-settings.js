(function(root) {
  'use strict';
  const DEFAULTS = Object.freeze({bitrate:'64k', channels:'mono', sourceBitrate:64});
  function normalize(value = {}) {
    value = value && typeof value === 'object' ? value : {};
    return {
      bitrate: ['32k','64k','96k','128k'].includes(value.bitrate) ? value.bitrate : DEFAULTS.bitrate,
      channels: ['mono','stereo','keep'].includes(value.channels) ? value.channels : DEFAULTS.channels,
      sourceBitrate: [32,64,96,128].includes(Number(value.sourceBitrate)) ? Number(value.sourceBitrate) : DEFAULTS.sourceBitrate
    };
  }
  const api = {DEFAULTS, STORAGE_KEY:'audioSettings', normalize};
  root.AudioSettings = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
