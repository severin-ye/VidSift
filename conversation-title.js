(function(root){
  'use strict';
  const labels={douyin:'抖音',bilibili:'B站',youtube:'YouTube'};
  function formatConversationTitle(rawTitle,source={}){
    const raw=String(rawTitle||'').trim();
    let platform=labels[source.platform]?source.platform:'';
    // Legacy Bilibili sends an already checked BV identity without a source object.
    if(!platform&&!source.platform&&/^BV\w+$/.test(source.videoId||''))platform='bilibili';
    const label=labels[platform];
    let title=raw.replace(/^(?:【(?:抖音(?:精选)?|B站|哔哩哔哩|bilibili|YouTube)】\s*)+/i,'');
    // Only a terminal metadata run is removed. Embedded emails, C# and hashtags
    // used as part of a sentence are left alone, as are tags followed by prose.
    title=title.replace(/(?:^|(?<=[\s。！？!?；;，,]))[#@][\p{L}\p{N}_-]+(?:\s*[#@][\p{L}\p{N}_-]+)*\s*$/u,'').trim();
    // A source identity is more useful than an empty headline or metadata alone.
    if(!title)title=String(source.videoId||'').trim();
    if(!title)return '';
    return (label?'【'+label+'】':'')+title;
  }
  root.VidSiftConversationTitle={formatConversationTitle};
  if(typeof module!=='undefined')module.exports=root.VidSiftConversationTitle;
})(globalThis);
