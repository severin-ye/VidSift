$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
. (Join-Path $project 'installer/NativeHost.Common.ps1')
$root=Join-Path ([IO.Path]::GetTempPath()) ("vidsift-visibility-O'Brien-"+[guid]::NewGuid().ToString('N'))
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$script:fileCalls=@();$script:registryCalls=@();$script:failure=''
function Get-CimInstance {
  [CmdletBinding()]param($Namespace,$ClassName,$Filter)
  if($Namespace -ne 'root/cimv2' -or $ClassName -ne 'CIM_DataFile'){throw 'Unexpected file provider'}
  $script:fileCalls+=@($Filter)
  if($script:failure -eq 'file-provider'){throw 'mock file provider unavailable'}
  foreach($path in $script:visiblePaths){
    $expected="Name='"+$path.Replace('\','\\').Replace("'","\'")+"'"
    if($Filter -eq $expected){if($script:failure -eq $path){return};return [pscustomobject]@{Name=$path}}
  }
  throw "Unexpected file filter or WQL escaping: $Filter"
}
function Invoke-CimMethod {
  [CmdletBinding()]param($Namespace,$ClassName,$MethodName,$Arguments)
  if($Namespace -ne 'root/default' -or $ClassName -ne 'StdRegProv' -or $MethodName -ne 'GetStringValue'){throw 'Unexpected registry provider'}
  if($Arguments.hDefKey -ne [uint32]2147483651 -or $Arguments.sValueName -ne ''){throw 'Expected HKEY_USERS default value read'}
  $expected=@($script:NativeKeys|ForEach-Object{$sid+'\'+$_.Substring(6)})
  if($Arguments.sSubKeyName -notin $expected){throw 'Query escaped the exact current-user Native host keys'}
  $script:registryCalls+=@($Arguments.sSubKeyName)
  if($script:failure -eq 'registry-provider'){throw 'mock registry provider unavailable'}
  if($script:failure -eq $Arguments.sSubKeyName){return [pscustomobject]@{ReturnValue=2;sValue=$null}}
  if($script:failure -eq 'wrong-registry'){return [pscustomobject]@{ReturnValue=0;sValue='C:\old-manifest.json'}}
  return [pscustomobject]@{ReturnValue=0;sValue=$manifest}
}
function Assert-Rejected([scriptblock]$Action,[string]$Expected){
  $failed=$false
  try {& $Action}catch{if($_.Exception.Message -notmatch $Expected){throw};$failed=$true}
  if(!$failed){throw "Expected rejection: $Expected"}
}
try {
  New-Item -ItemType Directory -Path $root -Force|Out-Null
  $pointer=Join-Path $root 'pointer.json';$manifest=Join-Path $root 'com.vidsift.media.json'
  $config=@{LauncherPath=(Join-Path $root 'launcher.exe');PythonPath=(Join-Path $root 'python.exe');HostPath=(Join-Path $root 'host.py');FfmpegPath=(Join-Path $root 'ffmpeg.exe')}
  Write-JsonFile $manifest @{path=$config.LauncherPath}
  $script:visiblePaths=@($pointer,$manifest,(Join-Path $root 'current.json'))+@($config.Values)
  Assert-NativeExternalVisibility -Pointer $pointer -Configuration $config -Manifest $manifest
  if($script:fileCalls.Count -ne 7 -or $script:registryCalls.Count -ne 2){throw 'Expected seven external file paths and Chrome/Edge registrations'}
  foreach($path in $script:visiblePaths){$script:failure=$path;Assert-Rejected {Assert-NativeExternalVisibility $pointer $config $manifest} 'cannot see'}
  foreach($key in $script:NativeKeys){$script:failure=$sid+'\'+$key.Substring(6);Assert-Rejected {Assert-NativeExternalVisibility $pointer $config $manifest} 'provider result 2'}
  $script:failure='wrong-registry';Assert-Rejected {Assert-NativeExternalVisibility $pointer $config $manifest} 'expected Native host registration'
  $script:failure='file-provider';Assert-Rejected {Assert-NativeExternalVisibility $pointer $config $manifest} 'file visibility query failed.*mock file provider unavailable'
  $script:failure='registry-provider';Assert-Rejected {Assert-NativeExternalVisibility $pointer $config $manifest} 'registry visibility query failed.*mock registry provider unavailable'
  $script:failure='';$config.HostPath='relative-host.py';Assert-Rejected {Assert-NativeExternalVisibility $pointer $config $manifest} 'absolute HostPath';$config.HostPath=Join-Path $root 'host.py'
  Write-JsonFile $manifest @{path='C:\wrong-launcher.exe'};Assert-Rejected {Assert-NativeExternalVisibility $pointer $config $manifest} 'manifest launcher path';Write-JsonFile $manifest @{path=$config.LauncherPath}
  $adapter=Join-Path $root 'registry-adapter.json'
  Write-JsonFile $pointer @{Previous='preserve bytes'}
  $previousPointer=Get-Content $pointer -Raw
  $oldRegistry=@($script:NativeKeys|ForEach-Object{[pscustomobject]@{Key=$_;Exists=$true;HasDefault=$true;Value='old manifest'}})
  Write-JsonFile $adapter $oldRegistry;$previousRegistry=Get-Content $adapter -Raw
  $script:failure='wrong-registry'
  Assert-Rejected {Set-NativeActivation -Pointer $pointer -Configuration $config -Manifest $manifest -RegistryStatePath $adapter -Validate {Assert-NativeExternalVisibility $pointer $config $manifest}} 'expected Native host registration'
  if((Get-Content $pointer -Raw) -ne $previousPointer -or (Get-Content $adapter -Raw) -ne $previousRegistry){throw 'Validation failure did not restore pointer and registry adapter'}
  Remove-Item -LiteralPath $pointer
  Assert-Rejected {Set-NativeActivation -Pointer $pointer -Configuration $config -Manifest $manifest -RegistryStatePath $adapter -Validate {throw 'mock verifier failure'}} 'mock verifier failure'
  if(Test-Path -LiteralPath $pointer){throw 'Failed activation left a new pointer'}
  # File adapters do not invoke the real OS verifier by default.
  Set-NativeActivation -Pointer $pointer -Configuration $config -Manifest $manifest -RegistryStatePath $adapter
  if(!(Test-Path -LiteralPath $pointer)){throw 'Adapter activation failed'}
  Write-Output 'PASS external visibility mock: exact CIM files/WQL, same-user HKU keys, missing/mismatch/provider failures, transactional rollback and adapter bypass'
}finally{
  $resolved=[IO.Path]::GetFullPath($root)
  if(!$resolved.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe visibility test cleanup'}
  if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
