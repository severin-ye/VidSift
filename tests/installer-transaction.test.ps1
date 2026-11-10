$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
. (Join-Path $project 'installer/NativeHost.Common.ps1')
$root=Join-Path ([IO.Path]::GetTempPath()) ('vidsift-transaction-'+[guid]::NewGuid().ToString('N'))
try {
 New-Item -ItemType Directory -Path (Join-Path $root 'runtime'),(Join-Path $root 'releases/old/native') -Force|Out-Null
 $oldLauncher=Join-Path $root 'releases/old/native/native-launcher.exe';[IO.File]::WriteAllText($oldLauncher,'old actual launcher bytes')
 $oldPython=Join-Path $root 'runtime/old-env/python.exe';New-Item -ItemType Directory -Path (Split-Path $oldPython) -Force|Out-Null;[IO.File]::WriteAllText($oldPython,'old dependency environment')
 $pointer=Join-Path $root 'runtime/current.json';Write-JsonFile $pointer @{PythonPath=$oldPython;HostPath='old host'}
 $oldPointer=Get-Content $pointer -Raw;$oldHash=(Get-FileHash $oldLauncher).Hash;$oldPythonHash=(Get-FileHash $oldPython).Hash
 $receiptPath=Join-Path $root 'upgrade-rollback.json'
 Write-JsonFile $receiptPath @{PreviousPointer=(Read-NativePointer $pointer)}
 $receiptText=[IO.File]::ReadAllText($receiptPath)
 if($receiptText.Length -gt 4096 -or ($receiptText|ConvertFrom-Json).PreviousPointer -ne [string]$oldPointer){throw 'Upgrade receipt expanded provider metadata or lost the old pointer'}
 $adapter=Join-Path $root 'registry.json';$state=@($script:NativeKeys|ForEach-Object{[pscustomobject]@{Key=$_;Exists=$true;HasDefault=$true;Value='old manifest'}});Write-JsonFile $adapter $state
 Get-Command Set-NativeActivation -ErrorAction Stop | Out-Null
 $failed=$false
 try { Set-NativeActivation -Pointer $pointer -Configuration @{PythonPath='new python';HostPath='new host'} -Manifest 'new manifest' -RegistryStatePath $adapter -InjectFailureAfterRegistry }catch{$failed=$true}
 if(!$failed){throw 'Expected injected transaction failure'}
 if((Get-Content $pointer -Raw) -ne $oldPointer){throw 'Old release pointer changed'}
 if((Get-FileHash $oldLauncher).Hash -ne $oldHash -or (Get-FileHash $oldPython).Hash -ne $oldPythonHash){throw 'Old launcher/environment bytes changed'}
 $restored=Get-Content $adapter -Raw|ConvertFrom-Json;if($restored[0].Value -ne 'old manifest'){throw 'Registry was not restored'}
 Write-Output 'PASS failed activation restores registry/pointer and preserves actual old launcher/python hashes'
}finally{if(Test-Path $root){$resolved=[IO.Path]::GetFullPath($root);if(!$resolved.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe cleanup'};Remove-Item -LiteralPath $resolved -Recurse -Force}}
