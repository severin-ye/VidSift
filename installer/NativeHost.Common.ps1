Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$script:NativeKeys=@('HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.vidsift.media','HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.vidsift.media')
function Write-JsonFile($Path,$Value) { $json=$Value|ConvertTo-Json -Depth 12; [IO.File]::WriteAllText($Path,$json,(New-Object Text.UTF8Encoding($false))) }
# Get-Content strings carry PSDrive/provider metadata in Windows PowerShell 5;
# serializing one in a rollback receipt recursively expands that entire graph.
function Read-NativePointer([string]$Path) { if(Test-Path -LiteralPath $Path){return [IO.File]::ReadAllText($Path)};return $null }
function Read-NativeRegistry($AdapterPath) {
  if($AdapterPath){ if(Test-Path -LiteralPath $AdapterPath){return @(Get-Content -LiteralPath $AdapterPath -Raw|ConvertFrom-Json)};return @($script:NativeKeys|ForEach-Object{[pscustomobject]@{Key=$_;Exists=$false;HasDefault=$false;Value=$null}}) }
  return @($script:NativeKeys|ForEach-Object { $exists=Test-Path -LiteralPath $_;$has=$false;$value=$null;if($exists){$key=Get-Item -LiteralPath $_;$has=$key.GetValueNames() -contains '';$value=$key.GetValue('',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)};[pscustomobject]@{Key=$_;Exists=$exists;HasDefault=$has;Value=$value;Kind=$(if($has){$key.GetValueKind('').ToString()}else{'String'})} })
}
function Set-NativeRegistry($State,$AdapterPath) {
  if($AdapterPath){Write-JsonFile $AdapterPath @($State);return}
  foreach($item in $State){
    if($script:NativeKeys -notcontains $item.Key -or !$item.Key.StartsWith('HKCU:\')){throw 'Unexpected per-user Native Messaging registry target'}
    $sub=$item.Key.Substring(6)
    if($item.Exists){
      $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($sub,$true)
      try{
        if($item.HasDefault){$kind=if($item.PSObject.Properties.Name -contains 'Kind'){$item.Kind}else{'String'};$key.SetValue('', $item.Value,[Enum]::Parse([Microsoft.Win32.RegistryValueKind],$kind))}
        else{$key.DeleteValue('', $false)}
      }finally{$key.Dispose()}
    }else{
      $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($sub,$true)
      if($null -ne $key){$empty=$false;try{$key.DeleteValue('', $false);$empty=$key.GetValueNames().Count -eq 0 -and $key.GetSubKeyNames().Count -eq 0}finally{$key.Dispose()};if($empty){[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($sub,$false)}}
    }
  }
}
function Assert-WithinRoot($Path,$Root) { $full=[IO.Path]::GetFullPath($Path);$base=[IO.Path]::GetFullPath($Root).TrimEnd('\')+'\';if(!$full.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)){throw "Path outside expected root: $full"};return $full }
function Invoke-Checked($Command,$Arguments) {
  $resolved=Get-Command $Command -ErrorAction Stop
  $savedErrorPreference=$ErrorActionPreference
  try {
    # Windows PowerShell 5 reports native stderr as ErrorRecord objects.
    # Native tools (uv/ffmpeg) use stderr for normal progress; exit status decides failure.
    $ErrorActionPreference='Continue'
    & $resolved @Arguments 2>&1 | Out-Host
    $exitCode=$LASTEXITCODE
  } finally { $ErrorActionPreference=$savedErrorPreference }
  if($exitCode -ne 0){throw "Command failed ($exitCode): $Command"}
}
function Assert-IsolatedPython([string]$Python,[string]$ExpectedRoot) {
  $details=& $Python -I -c "import sys,json; print(json.dumps({'prefix':sys.prefix,'base':sys.base_prefix}))"
  if($LASTEXITCODE -ne 0){throw 'Cannot inspect isolated Python prefix'}
  $info=$details|ConvertFrom-Json
  $expected=[IO.Path]::GetFullPath($ExpectedRoot).TrimEnd('\')
  if(![IO.Path]::GetFullPath($info.prefix).TrimEnd('\').Equals($expected,[StringComparison]::OrdinalIgnoreCase) -or $info.prefix -eq $info.base){throw 'Python prefix is not the expected isolated environment; global installation refused'}
}
function Get-SharedHash([string]$Path) {
  $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  $sha=[Security.Cryptography.SHA256]::Create()
  try {return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','')}finally{$sha.Dispose();$stream.Dispose()}
}
function Copy-SharedFile([string]$Source,[string]$Destination) {
  $input=[IO.File]::Open($Source,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  try{$output=[IO.File]::Open($Destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$input.CopyTo($output)}finally{$output.Dispose()}}finally{$input.Dispose()}
}
function Assert-NativeExternalVisibility {
  param([string]$Pointer,$Configuration,[string]$Manifest)
  # CIM providers run outside the caller's MSIX file/registry virtualization view.
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $paths=[ordered]@{Pointer=$Pointer;Manifest=$Manifest;ReleaseConfiguration=(Join-Path (Split-Path $Manifest -Parent) 'current.json')}
  foreach($name in @('LauncherPath','PythonPath','HostPath','FfmpegPath')){
    $paths[$name]=[string]$Configuration[$name]
  }
  foreach($entry in $paths.GetEnumerator()){
    $path=[string]$entry.Value
    if($path -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])'){throw "External visibility requires an absolute $($entry.Key) path: $path"}
    $absolute=[IO.Path]::GetFullPath($path)
    $escaped=$absolute.Replace('\','\\').Replace("'","\'")
    try { $files=@(Get-CimInstance -Namespace 'root/cimv2' -ClassName CIM_DataFile -Filter "Name='$escaped'" -ErrorAction Stop) }
    catch { throw "External file visibility query failed for $($entry.Key) '$absolute': $($_.Exception.Message)" }
    if($files.Count -ne 1 -or !([string]$files[0].Name).Equals($absolute,[StringComparison]::OrdinalIgnoreCase)){
      throw "External Windows environment cannot see $($entry.Key): $absolute"
    }
  }
  $installedManifest=Get-Content -LiteralPath $Manifest -Raw|ConvertFrom-Json
  if(!([string]$installedManifest.path).Equals([string]$Configuration['LauncherPath'],[StringComparison]::OrdinalIgnoreCase)){
    throw 'Native manifest launcher path does not match the activated configuration'
  }
  foreach($key in $script:NativeKeys){
    if($key -notin @('HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.vidsift.media','HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.vidsift.media')){throw 'Unexpected external registry verification target'}
    $subkey=$sid+'\'+$key.Substring(6)
    try { $result=Invoke-CimMethod -Namespace 'root/default' -ClassName StdRegProv -MethodName GetStringValue -Arguments @{hDefKey=[uint32]2147483651;sSubKeyName=$subkey;sValueName=''} -ErrorAction Stop }
    catch { throw "External registry visibility query failed for '$key' (user $sid): $($_.Exception.Message)" }
    if($null -eq $result -or $result.ReturnValue -ne 0 -or !([string]$result.sValue).Equals($Manifest,[StringComparison]::OrdinalIgnoreCase)){
      $code=if($null -eq $result){'no result'}else{[string]$result.ReturnValue}
      throw "External Windows environment cannot read the expected Native host registration '$key' (user $sid, provider result $code)"
    }
  }
}
function Set-NativeActivation {
  param([string]$Pointer,$Configuration,[string]$Manifest,[string]$RegistryStatePath,[switch]$InjectFailureAfterRegistry,[scriptblock]$Validate)
  if($InjectFailureAfterRegistry -and !$RegistryStatePath){throw 'Failure injection requires a file registry adapter'}
  $previous=Read-NativePointer $Pointer
  $previousRegistry=Read-NativeRegistry $RegistryStatePath
  try {
    Write-JsonFile $Pointer $Configuration
    $registered=@($script:NativeKeys|ForEach-Object{[pscustomobject]@{Key=$_;Exists=$true;HasDefault=$true;Value=$Manifest}})
    Set-NativeRegistry $registered $RegistryStatePath
    if($InjectFailureAfterRegistry){throw 'Injected activation failure after registry write'}
    if($Validate){& $Validate | Out-Null}
  }catch{
    Set-NativeRegistry $previousRegistry $RegistryStatePath
    if($null -ne $previous){[IO.File]::WriteAllText($Pointer,$previous,(New-Object Text.UTF8Encoding($false)))}elseif(Test-Path -LiteralPath $Pointer){Remove-Item -LiteralPath $Pointer}
    throw
  }
}
