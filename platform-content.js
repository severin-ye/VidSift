(() => {
 'use strict';let lastUrl=location.href,lastKey=VidSiftPlatforms.identify(lastUrl)?.key;
 // Progress and cancellation belong to the extension popup, never the video page.
 chrome.runtime.onMessage.addListener((msg,_sender,reply)=>{
  if(['EXT_STATUS','EXT_ERROR','EXT_HIDE_STATUS'].includes(msg.type))reply({ok:true});
 });
 // SPA routes can change without a document navigation or a tab's load event.
 setInterval(()=>{const url=location.href,key=VidSiftPlatforms.identify(url)?.key;if(url!==lastUrl){if(key!==lastKey)chrome.runtime.sendMessage({type:'VIDSIFT_SOURCE_CHANGED',url}).catch(()=>{});lastUrl=url;lastKey=key;}},750);
})();
