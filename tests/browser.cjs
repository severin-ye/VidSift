// Isolated standalone-package acceptance. No daily profile or login state used.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const project=path.resolve(__dirname,'..'),artifacts=path.join(project,'.task-artifacts');
fs.mkdirSync(artifacts,{recursive:true});
const ID='kggdkncbamdlhhihfkeldbbkppkgihad',OLD_ID='nigiglinogpocaonjlenipdhhlmnkmee';
const extension=process.env.VIDSIFT_EXTENSION_ROOT||project,original=process.env.VIDSIFT_ORIGINAL_EXTENSION;
const profile=fs.mkdtempSync(path.join(artifacts,'standalone-profile-'));
const evidence={startedAt:new Date().toISOString(),extension,extensionId:ID,originalId:OLD_ID,checks:[],profile,privateProfileUsed:false};
let context;
(async()=>{
 const extensions=original?[extension,original]:[extension];
 context=await chromium.launchPersistentContext(profile,{headless:true,...(process.env.VIDSIFT_BROWSER_EXE?{executablePath:process.env.VIDSIFT_BROWSER_EXE}:{channel:'chromium'}),args:[`--disable-extensions-except=${extensions.join(',')}`,`--load-extension=${extensions.join(',')}`]});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`chrome-extension://${ID}/options.html`);
 await page.locator('#screenshot-interval').waitFor();await page.waitForFunction(()=>!document.querySelector('#screenshot-save').disabled);
 const state=await page.evaluate(async()=>({id:chrome.runtime.id,version:chrome.runtime.getManifest().version,local:await chrome.storage.local.get(null)}));
 assert.equal(state.id,ID);assert.equal(state.version,require('../package.json').version);assert.equal(state.local.customPrompt,undefined);
 evidence.checks.push('standalone identity and clean independent storage');
 assert.equal(await page.locator('#screenshot-enabled').isChecked(),false);assert.equal(await page.locator('#screenshot-interval').inputValue(),'5');assert.equal(await page.locator('#screenshot-maxCollages').inputValue(),'15');
 await page.evaluate(()=>chrome.storage.local.set({customPrompt:'standalone canary'}));
 await page.locator('#screenshot-interval').fill('9');await page.locator('#screenshot-enabled').check();await page.locator('#screenshot-save').click();
 await page.waitForFunction(async()=>(await chrome.storage.local.get('screenshotSettings')).screenshotSettings?.interval===9);
 await page.locator('#screenshot-reset').click();await page.waitForFunction(async()=>!(await chrome.storage.local.get('screenshotSettings')).screenshotSettings);
 assert.equal(await page.evaluate(async()=>(await chrome.storage.local.get('customPrompt')).customPrompt),'standalone canary');
 evidence.checks.push('screenshots default off / 5 seconds / 15 collages; isolated reset preserves prompt');
 if(original){
  const legacy=await context.newPage();await legacy.goto(`chrome-extension://${OLD_ID}/options.html`);
  assert.equal(await legacy.evaluate(()=>chrome.runtime.getManifest().version),'4.12.0');
  await legacy.evaluate(()=>chrome.storage.local.set({customPrompt:'original canary'}));
  assert.equal(await page.evaluate(async()=>(await chrome.storage.local.get('customPrompt')).customPrompt),'standalone canary');
  assert.equal(await legacy.evaluate(async()=>(await chrome.storage.local.get('customPrompt')).customPrompt),'original canary');
  evidence.checks.push('original 4.12.0 and VidSift loaded together; settings separated by identity');await legacy.close();
 }else evidence.originalCoexistence='Not Run: set VIDSIFT_ORIGINAL_EXTENSION to an original 4.12.0 unpacked snapshot';
 if(process.env.VIDSIFT_NATIVE_TEST==='1'){
  const native=await page.evaluate(()=>chrome.runtime.sendMessage({type:'VIDSIFT_NATIVE_STATUS'}));
  assert.equal(native?.ok,true,JSON.stringify(native));assert.equal(native.ffmpeg,true);evidence.native=native;
  evidence.checks.push('standalone browser Native Messaging diagnostics');
 }
 await page.screenshot({path:path.join(artifacts,'standalone-settings.png'),fullPage:true});
 const popup=await context.newPage();await popup.goto(`chrome-extension://${ID}/popup.html`);
 await popup.waitForFunction(()=>document.querySelector('#screenshotCheckbox')!==null);assert.equal(await popup.locator('#screenshotCheckbox').isChecked(),false);
 assert.deepEqual(errors,[]);evidence.checks.push('settings and popup render without JavaScript errors');evidence.passed=true;
})().catch(e=>{evidence.passed=false;evidence.error=e.stack;process.exitCode=1;}).finally(async()=>{
 if(context)await context.close();evidence.completedAt=new Date().toISOString();
 fs.writeFileSync(path.join(artifacts,'standalone-browser-results.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
});
