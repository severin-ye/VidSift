const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),art=path.join(root,'.task-artifacts','groq-settings-browser');fs.mkdirSync(art,{recursive:true});
const profile=fs.mkdtempSync(path.join(art,'profile-')),id='kggdkncbamdlhhihfkeldbbkppkgihad';
const report={profile,dailyProfileUsed:false,checks:[]};let ctx;
fs.writeFileSync(path.join(art,'resource.json'),JSON.stringify({owner:'01a1cd4c',profile,purpose:'shared Groq migration/settings acceptance',cleanup:'close browser and delete this exact disposable profile'}));
(async()=>{try{
 ctx=await chromium.launchPersistentContext(profile,{headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--disable-extensions-except='+root,'--load-extension='+root]});
 const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('chrome-extension://'+id+'/options.html');
 await page.evaluate(()=>chrome.storage.local.set({transcribeService:'aistudio',douyinTranscribeService:'local',transcriptionDefaultsVersion:0,customPrompt:'retained prompt',audioSettings:{bitrate:'128k'},groqSettings:{model:'whisper-large-v3',timeoutSeconds:90}}));
 await page.reload();await page.locator('#radioGroq').waitFor();await page.waitForFunction(()=>document.querySelector('#radioGroq').checked&&document.querySelector('#groqModel').value==='whisper-large-v3');
 assert.equal(await page.locator('#douyinService').count(),0);assert.equal(await page.locator('#groqTimeout').inputValue(), '90');
 report.checks.push('old split choices migrate once to shared Groq, retaining model and timeout');
 await page.locator('#radioAIStudio').check();await page.waitForFunction(async()=>((await chrome.storage.local.get('transcribeService')).transcribeService==='aistudio'));await page.reload();await page.waitForFunction(()=>document.querySelector('#radioAIStudio').checked);
 report.checks.push('subsequent explicit service choice survives reload');
 await page.locator('#promptTextarea').fill('unsaved draft');await page.locator('#douyinLocalReset').click();await page.waitForFunction(()=>document.querySelector('#radioGroq').checked&&document.querySelector('#groqModel').value==='whisper-large-v3-turbo');
 assert.equal(await page.locator('#promptTextarea').inputValue(),'unsaved draft');const stored=await page.evaluate(()=>chrome.storage.local.get(['customPrompt','audioSettings']));assert.equal(stored.customPrompt,'retained prompt');assert.equal(stored.audioSettings.bitrate,'128k');
 assert.deepEqual(errors,[]);report.checks.push('shared-block reset preserves audio settings, saved prompt, and unsaved prompt draft');report.passed=true;
}catch(e){report.error=e.stack;process.exitCode=1;}finally{if(ctx)await ctx.close();assert(path.resolve(profile).startsWith(path.resolve(art)+path.sep));fs.rmSync(profile,{recursive:true,force:true});report.profileRemoved=!fs.existsSync(profile);fs.writeFileSync(path.join(art,'receipt.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}})();
