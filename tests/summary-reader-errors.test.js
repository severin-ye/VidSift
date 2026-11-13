const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('invalid ChatGPT response never returns a body excerpt to the video page',async()=>{
 let receive;const privateBody='private-summary-body-fragment';
 const ctx=vm.createContext({URL,AbortSignal,TextDecoder,location:{href:'https://chatgpt.com/'},VidSiftSummaryVerification:{inspectSummary:()=>{throw Error('should not inspect malformed data');}},chrome:{runtime:{id:'fixture',onMessage:{addListener:fn=>receive=fn}}},fetch:async url=>url==='/api/auth/session'?{ok:true,json:async()=>({accessToken:'synthetic'})}:{ok:true,headers:{get:()=>null},text:async()=>privateBody}});
 vm.runInContext(fs.readFileSync('summary-verifier-content.js','utf8'),ctx);
 const result=await new Promise(resolve=>receive({type:'VIDSIFT_VERIFY_SAVED_SUMMARY',id:'11111111-2222-4333-8444-555555555555'},{id:'fixture'},resolve));
 assert.equal(result.ok,false);assert.equal(JSON.stringify(result).includes(privateBody),false);assert.match(result.error,/响应.*无效|无法解析/);
});
