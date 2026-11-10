const fs=require('node:fs');const path=require('node:path');process.chdir(path.resolve(__dirname,'..'));
const pkg=require('../package.json');if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg.version))throw Error('版本必须为三段整数');
const manifest=JSON.parse(fs.readFileSync('manifest.json','utf8'));
if(process.argv.includes('--sync')){manifest.version=pkg.version;fs.writeFileSync('manifest.json',JSON.stringify(manifest,null,2)+'\n');}
else if(manifest.version!==pkg.version)throw Error('package.json 与 manifest.json 版本不一致');
console.log('Version '+pkg.version+' verified');
