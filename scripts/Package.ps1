[CmdletBinding()]param()
$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
Push-Location $projectRoot
try {
 & node scripts/version.cjs
 if($LASTEXITCODE -ne 0){throw 'Version check failed'}
 & node scripts/check.cjs
 if($LASTEXITCODE -ne 0){throw 'Asset/identity check failed'}
 $releaseVersion=(Get-Content package.json -Raw | ConvertFrom-Json).version
 $extensionId='kggdkncbamdlhhihfkeldbbkppkgihad'
 $dist=Join-Path $projectRoot 'dist'
 New-Item -ItemType Directory -Force -Path $dist | Out-Null
 $stage=Join-Path $dist ('VidSift-'+$releaseVersion+'-standalone')
 if(Test-Path -LiteralPath $stage){
  $resolved=[IO.Path]::GetFullPath($stage)
  if(!$resolved.StartsWith([IO.Path]::GetFullPath($dist).TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe package stage'}
  $oldManifest=Join-Path $stage 'manifest.json'
  if(!(Test-Path -LiteralPath $oldManifest) -or (Get-Content $oldManifest -Raw|ConvertFrom-Json).name -notin @('VidSift','通用总结扩展','知行视频总结')){throw 'Refusing to replace an unrecognized stage'}
  Remove-Item -LiteralPath $resolved -Recurse -Force
 }
 New-Item -ItemType Directory -Force -Path $stage | Out-Null
 $items=@('manifest.json','background.js','background-video.js','video-library.js','background-library.js','popup.js','popup.html','popup.css','options.html','options.js','screenshot-settings.js','attachment-utils.js','attachment-transfer.js','audio-settings.js','task-diagnostics.js','error-reporter.js','background-errors.js','conversation-binding.js','native-client.js','platforms.js','video-workflow.js','source-guard.js','page-bridge.js','douyin-source.js','platform-content.js','bilibili-content.js','bilibili-content-main.js','chatgpt-content.js','chatgpt-library-main.js','aistudio-content.js','aistudio-transcript.js','offscreen.js','offscreen.html','prompt_chatgpt.txt','prompt_aistudio.txt','PRIVACY_POLICY.md','README.md','INSTALL.md','CHANGELOG.md','LICENSE','THIRD_PARTY.md','设计对齐稿','icons','lib','test','installer','requirements-native.txt','package.json')
 $items+=@('douyin-local-settings.js','local-transcription.js','local-media-cache.js','offscreen-local.js','whisper-worker.js','options-local.js')
 foreach($item in $items){
  if(!(Test-Path -LiteralPath $item)){throw "Package input missing: $item"}
  Copy-Item -LiteralPath $item -Destination $stage -Recurse -Force
 }
 New-Item -ItemType Directory -Path (Join-Path $stage 'native'),(Join-Path $stage 'docs') -Force | Out-Null
 foreach($name in @('host.py','__init__.py','THIRD_PARTY.md')){Copy-Item -LiteralPath (Join-Path 'native' $name) -Destination (Join-Path $stage 'native')}
 Copy-Item -LiteralPath 'docs/README.upstream.md' -Destination (Join-Path $stage 'docs')
 Copy-Item -LiteralPath 'docs/中文模型对比-2026-11-10.md' -Destination (Join-Path $stage 'docs')
 if(Test-Path -LiteralPath 'docs/superpowers'){Copy-Item -LiteralPath 'docs/superpowers' -Destination (Join-Path $stage 'docs') -Recurse}
 New-Item -ItemType Directory -Force -Path (Join-Path $stage 'scripts') | Out-Null
 Copy-Item -LiteralPath 'scripts/diagnostics.py' -Destination (Join-Path $stage 'scripts')
 $zip=Join-Path $dist ('VidSift-'+$releaseVersion+'-standalone.zip')
 Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
 $stream=[IO.File]::OpenRead($zip);$sha=[Security.Cryptography.SHA256]::Create()
 try{$hash=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','')}finally{$sha.Dispose();$stream.Dispose()}
 $receipt=@{version=$releaseVersion;extensionId=$extensionId;originalExtensionReplaced=$false;sha256=$hash;package=(Split-Path $zip -Leaf);status='test-package';acceptance='See README for real-site verification gaps'}
 [IO.File]::WriteAllText((Join-Path $dist 'receipt.json'),($receipt|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
 Write-Output $zip
 Write-Output ('SHA256 '+$hash)
}finally{Pop-Location}
