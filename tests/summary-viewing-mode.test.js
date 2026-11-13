const {test}=require('node:test'),assert=require('node:assert/strict');
const {viewingMode}=require('../summary-reminder.js');
function fixture(){const nodes={};return {nodes,doc:{fullscreenElement:null,webkitFullscreenElement:null,querySelector:selector=>nodes[selector]||null},win:{innerWidth:1200,innerHeight:800}};}
test('native fullscreen, YouTube theater and B站网页全屏 hide the entire reminder',()=>{
 const f=fixture();assert.equal(viewingMode(f.doc,f.win),false);f.doc.fullscreenElement={};assert.equal(viewingMode(f.doc,f.win),true);f.doc.fullscreenElement=null;
 f.nodes['ytd-watch-flexy[theater], ytd-watch-flexy[fullscreen]']={};assert.equal(viewingMode(f.doc,f.win),true);delete f.nodes['ytd-watch-flexy[theater], ytd-watch-flexy[fullscreen]'];
 f.nodes['.bpx-state-web, .bpx-state-fullscreen, .bilibili-player-mode-webfullscreen, .bilibili-player-mode-fullscreen']={};assert.equal(viewingMode(f.doc,f.win),true);
});
test('viewport-sized video hides the reminder, ordinary playback does not',()=>{
 const f=fixture();let rect={width:800,height:450};f.nodes.video={getBoundingClientRect:()=>rect};assert.equal(viewingMode(f.doc,f.win),false);rect={width:1200,height:760};assert.equal(viewingMode(f.doc,f.win),true);
});
test('active expanded video is detected after an offscreen retained SPA video',()=>{
 const f=fixture(),offscreen={getBoundingClientRect:()=>({width:400,height:700,top:-900,bottom:-200})},active={getBoundingClientRect:()=>({width:1200,height:800,top:0,bottom:800})};
 f.nodes.video=offscreen;f.doc.querySelectorAll=()=>[offscreen,active];assert.equal(viewingMode(f.doc,f.win),true);
});
