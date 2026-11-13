const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('chatgpt-content.js','utf8');
function fixture({temporary=false,read=()=>({}),dom=()=>({statuses:[],busy:false}),baseline=[]}={}){
 let now=0,reads=0;const context=vm.createContext({Date:{now:()=>now},AbortSignal,Set,document:{querySelectorAll:selector=>selector==='[role="status"]'?dom(now).statuses:[{textContent:'partially streamed reply'}],querySelector:selector=>{assert(selector.includes('button[aria-label="停止"]'));return dom(now).busy?{}:null;}},assertNotCancelled(){},getAccessToken:async()=> 'synthetic',_lastConversationTask:{requestMessageId:'current'},VidSiftConversationBinding:{verify:()=>({ok:true})},fetch:async(url,options)=>{assert(!options?.method||options.method==='GET','generation polling must not submit again');return {ok:true,json:async()=>{reads++;return read(now);}};},setTimeout(fn,ms){now+=ms;fn();}});
 vm.runInContext(source.slice(source.indexOf('  // A title or an older reply'),source.indexOf('  // Rename the conversation via')),context);
 return {context,wait:()=>context.waitForSummaryGeneration({taskId:'task',tempChat:temporary},{promise:Promise.resolve('owned')},context.createTemporaryGenerationTracker?.(baseline)),elapsed:()=>now,reads:()=>reads};
}
const data=(status,end_turn=true)=>({mapping:{u:{message:{id:'current',author:{role:'user'}}},reply:{parent:'u',message:{author:{role:'assistant'},status,end_turn}}}});
test('matching explicit failed and cancelled responses reject promptly without another submission',async()=>{for(const status of ['failed','cancelled','canceled','finished_with_error']){const f=fixture({read:()=>data(status)});await assert.rejects(f.wait(),/总结已发送.*(失败|停止).*没有重复发送/);assert.equal(f.reads(),1);}});
test('old failed reply cannot terminate current long thinking response',async()=>{const f=fixture({read:now=>{const d=data(now<130000?'in_progress':'finished_successfully',now>=130000);d.mapping.old={message:{id:'old',author:{role:'user'}}};d.mapping.oldReply={parent:'old',message:{author:{role:'assistant'},status:'failed',end_turn:true}};return d;}});await f.wait();assert(f.elapsed()>=130000);});
test('unknown and partial statuses remain pending until explicit successful end turn',async()=>{const f=fixture({read:now=>data(now<6000?'finished_partial':'finished_successfully',now>=6000)});await f.wait();assert.equal(f.elapsed(),6000);});
test('temporary stream pause with visible assistant text cannot complete before explicit status',async()=>{const done={textContent:'回答已完成'};const f=fixture({temporary:true,dom:now=>({statuses:now<9000?[]:[done],busy:now<1000})});await f.wait();assert.equal(f.elapsed(),9000);assert.equal(f.reads(),0);});
test('temporary completion status supports current DOM without assistant author attributes',async()=>{const done={textContent:'回答已完成'};const f=fixture({temporary:true,dom:()=>({statuses:[done],busy:false})});await f.wait();assert.equal(f.elapsed(),0);});
test('an old completion announcement cannot finish a new temporary task',async()=>{const old={textContent:'回答已完成'},fresh={textContent:'Response complete'};const f=fixture({temporary:true,baseline:[old],dom:now=>({statuses:now<6000?[old]:[old,fresh],busy:false})});await f.wait();assert.equal(f.elapsed(),6000);});
test('temporary explicit completion cannot override the visible localized stop control',async()=>{const done={textContent:'回答已完成'};const f=fixture({temporary:true,dom:now=>({statuses:[done],busy:now<5000})});await f.wait();assert.equal(f.elapsed(),5000);});
test('missing user message identity cannot claim a failed or completed response',()=>{const f=fixture();for(const status of ['failed','finished_successfully']){const d=data(status);delete d.mapping.u.message.id;assert.equal(f.context.taskResponseOutcome(d,undefined),null);}});
test('production generation rejection sends one negative target receipt',async()=>{
 const reports=[],errors=[],f=fixture({read:()=>data('cancelled')});
 Object.assign(f.context,{msg:{taskId:'task',tempChat:false},libraryBinding:{promise:Promise.resolve('owned')},temporaryFinished:null,reportTarget:(msg,ok,error)=>reports.push({ok,error}),showError:error=>errors.push(error)});
 const statement=source.match(/generation=waitForSummaryGeneration\(msg,libraryBinding,temporaryFinished\)\.then\([^\n]+/)[0];
 await vm.runInContext(statement,f.context);
 assert.equal(reports.length,1);assert.equal(reports[0].ok,false);assert.match(reports[0].error,/已停止/);assert.equal(errors.length,1);assert.equal(f.reads(),1);
});
