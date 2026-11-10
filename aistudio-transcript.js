(function(root){
  'use strict';
  function seconds(clock, milliseconds=false) {
    const match=clock.match(milliseconds?/^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/:/^(\d{2,}):([0-5]\d):([0-5]\d)$/);
    if(!match)throw new Error('转写时间戳格式无效，未转交 GPT');
    return Number(match[1])*3600+Number(match[2])*60+Number(match[3])+(milliseconds?Number(match[4])/1000:0);
  }
  function normalizeTimingLine(line) {
    // Accept omitted hours only on a complete SRT timing line, never in speech.
    const timing=line?.match(/^(\d{2,}(?::[0-5]\d){1,2},\d{3})([ \t]+-->[ \t]+)(\d{2,}(?::[0-5]\d){1,2},\d{3})([ \t]*)$/);
    if(!timing)return line;
    function absoluteClock(clock) {
      if(clock.split(':').length===3)return clock;
      const [minutes,rest]=clock.split(':'),totalMinutes=Number(minutes);
      if(!Number.isSafeInteger(totalMinutes))return clock;
      return String(Math.floor(totalMinutes/60)).padStart(2,'0')+':'+String(totalMinutes%60).padStart(2,'0')+':'+rest;
    }
    return absoluteClock(timing[1])+timing[2]+absoluteClock(timing[3])+timing[4];
  }
  function parse(text,durationSeconds) {
    const duration=Number(durationSeconds);
    if(!Number.isFinite(duration)||duration<=0)throw new Error('缺少可靠音频时长，无法核验转写完整性，未转交 GPT');
    const raw=String(text||'').replace(/\r\n?/g,'\n').trim();
    const markers=[...raw.matchAll(/\[转写完成 (\d{2,}:[0-5]\d:[0-5]\d)\]/g)];
    if(markers.length!==1)throw new Error('转写缺少唯一完成标记，可能尚未完成或已截断，未转交 GPT');
    if(Math.abs(seconds(markers[0][1])-duration)>2)throw new Error('转写完成标记与音频时长不符，未转交 GPT');
    let body=raw.slice(0,markers[0].index).trim();
    const fenced=[...body.matchAll(/```(?:srt)?\s*\n([\s\S]*?)```/gi)];
    if(fenced.length>1)throw new Error('转写包含多个字幕代码块，未转交 GPT');
    if(fenced.length===1)body=fenced[0][1].trim();
    else body=body.replace(/^```(?:srt)?\s*\n/i,'').replace(/\n```\s*$/,'').trim();
    const start=body.search(/^1[ \t]*\n/m);
    if(start<0)throw new Error('未找到完整 SRT 字幕，未转交 GPT');
    body=body.slice(start).trim();
    // Keep the original separators and caption text while normalizing cue clocks.
    const sections=body.split(/(\n[ \t]*\n+)/);
    const blocks=sections.filter((_,index)=>index%2===0);
    let previousEnd=0,firstStart;
    for(let index=0;index<blocks.length;index++) {
      const lines=blocks[index].split('\n');
      lines[1]=normalizeTimingLine(lines[1]);
      sections[index*2]=lines.join('\n');
      if(lines[0].trim()!==String(index+1))throw new Error('SRT 字幕编号缺失或不连续，未转交 GPT');
      const timing=lines[1]?.match(/^(\d{2,}:[0-5]\d:[0-5]\d,\d{3})[ \t]+-->[ \t]+(\d{2,}:[0-5]\d:[0-5]\d,\d{3})[ \t]*$/);
      if(!timing)throw new Error('SRT 字幕时间戳无效，未转交 GPT');
      const begin=seconds(timing[1],true),end=seconds(timing[2],true);
      if(end<=begin||begin<previousEnd-0.25||end>duration+2)throw new Error('SRT 字幕时间范围不连续或超出音频，未转交 GPT');
      if(!lines.slice(2).join('\n').trim()||lines.slice(2).some(line=>line.includes('-->')||/^```/.test(line)))throw new Error('SRT 字幕内容缺失或格式不完整，未转交 GPT');
      if(index===0)firstStart=begin;
      previousEnd=end;
    }
    // Modest leading/trailing silence is allowed. Large gaps at the boundaries
    // are rejected rather than silently treating a partial response as complete.
    const tolerance=Math.max(2,Math.min(30,duration*0.05));
    if(firstStart>tolerance||previousEnd<duration-tolerance)throw new Error('字幕未覆盖音频首尾，可能是残稿或存在较长静音，需人工核验，未转交 GPT');
    return sections.join('');
  }
  const api={parse};root.VidSiftTranscript=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
