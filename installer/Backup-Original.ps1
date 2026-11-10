[CmdletBinding(SupportsShouldProcess=$true)]
param([Parameter(Mandatory=$true)][string]$InstalledExtensionRoot,[Parameter(Mandatory=$true)][string]$ProfileRoot,[Parameter(Mandatory=$true)][string]$BackupRoot,[string]$ExtensionId='nigiglinogpocaonjlenipdhhlmnkmee',[string]$ExpectedVersion='4.12.0',[switch]$DryRun)
. (Join-Path $PSScriptRoot 'NativeHost.Common.ps1')
if($ExtensionId -notmatch '^[a-p]{32}$'){throw 'Invalid extension ID'}
$InstalledExtensionRoot=[IO.Path]::GetFullPath($InstalledExtensionRoot);$ProfileRoot=[IO.Path]::GetFullPath($ProfileRoot);$BackupRoot=[IO.Path]::GetFullPath($BackupRoot)
$manifest=Get-Content -LiteralPath (Join-Path $InstalledExtensionRoot 'manifest.json') -Raw|ConvertFrom-Json
if($manifest.version -ne $ExpectedVersion){throw "Expected installed $ExpectedVersion but found $($manifest.version)"}
$locations=[ordered]@{source=$InstalledExtensionRoot;local=(Join-Path $ProfileRoot "Local Extension Settings/$ExtensionId");sync=(Join-Path $ProfileRoot "Sync Extension Settings/$ExtensionId");indexeddb=(Join-Path $ProfileRoot "IndexedDB/chrome-extension_$($ExtensionId)_0.indexeddb.leveldb");database=(Join-Path $ProfileRoot "databases/chrome-extension_$($ExtensionId)_0")}
foreach($path in $locations.Values){$sourceFull=[IO.Path]::GetFullPath($path).TrimEnd('\');if($BackupRoot.Equals($sourceFull,[StringComparison]::OrdinalIgnoreCase) -or $BackupRoot.StartsWith($sourceFull+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'BackupRoot must not be inside a source directory'}}
if($DryRun -or !$PSCmdlet.ShouldProcess($BackupRoot,'Copy original extension and extension-specific browser stores with hashes; do not modify originals')){return [pscustomobject]@{BackupRoot=$BackupRoot;Sources=$locations;Version=$manifest.version;ConsistencyVerified=$false}}
if(Test-Path -LiteralPath $BackupRoot){throw 'BackupRoot already exists; use a new explicit path'}
New-Item -ItemType Directory -Path $BackupRoot -Force|Out-Null
function Get-BackupSourceFiles([string]$Path) {
  $pending=New-Object 'System.Collections.Generic.Stack[string]';$pending.Push($Path)
  while($pending.Count -gt 0) {
    foreach($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force -ErrorAction Stop) {
      if(($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw "Reparse point not followed: $($entry.FullName)"}
      if($entry.PSIsContainer){$pending.Push($entry.FullName)}else{$entry}
    }
  }
}
$records=New-Object System.Collections.Generic.List[object]
$failures=New-Object System.Collections.Generic.List[string]
foreach($entry in $locations.GetEnumerator()){
  $source=$entry.Value
  if(!(Test-Path -LiteralPath $source)){ $records.Add([pscustomobject]@{Area=$entry.Key;Source=$source;Status='NotPresent'});continue }
  $destination=Join-Path $BackupRoot $entry.Key;New-Item -ItemType Directory -Path $destination -Force|Out-Null
  try{$beforeFiles=@(Get-BackupSourceFiles $source)}catch{$failures.Add("Cannot enumerate $source : $($_.Exception.Message)");continue}
  foreach($file in $beforeFiles){
    $relative=$file.FullName.Substring($source.TrimEnd('\').Length).TrimStart('\')
    $target=Assert-WithinRoot (Join-Path $destination $relative) $BackupRoot
    try{
      if(($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Reparse-point source is not copied'}
      if($entry.Key -ne 'source' -and $file.Name -eq 'LOCK' -and $file.Length -eq 0){[IO.File]::WriteAllBytes($target,[byte[]]@());$records.Add([pscustomobject]@{Area=$entry.Key;Source=$file.FullName;RelativePath=$relative;Status='LockMarkerRecreated';Note='Zero-byte process lock is recreated; no user data omitted'});continue}
      $beforeHash=Get-SharedHash $file.FullName
      New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force|Out-Null
      Copy-SharedFile -Source $file.FullName -Destination $target
      $afterHash=Get-SharedHash $file.FullName
      $copyHash=(Get-FileHash -LiteralPath $target -Algorithm SHA256 -ErrorAction Stop).Hash
      $stable=$beforeHash -eq $afterHash -and $beforeHash -eq $copyHash
      if(!$stable){$failures.Add("Source changed or hash mismatch: $($file.FullName)")}
      $records.Add([pscustomobject]@{Area=$entry.Key;Source=$file.FullName;RelativePath=$relative;SHA256Before=$beforeHash;SHA256After=$afterHash;SHA256Copy=$copyHash;Status=$(if($stable){'CopiedVerified'}else{'ChangedDuringCopy'})})
    }catch{$failures.Add("Copy failed: $($file.FullName): $($_.Exception.Message)");$records.Add([pscustomobject]@{Area=$entry.Key;Source=$file.FullName;Status='CopyFailed';Error=$_.Exception.Message})}
  }
  try{
    $afterFiles=@(Get-BackupSourceFiles $source)
    $beforeNames=@($beforeFiles | ForEach-Object FullName);$afterNames=@($afterFiles | ForEach-Object FullName)
    $difference=if($beforeNames.Count -eq 0 -and $afterNames.Count -eq 0){$null}elseif($beforeNames.Count -eq 0 -or $afterNames.Count -eq 0){$true}else{Compare-Object $beforeNames $afterNames}
    if($difference){$failures.Add("Source file list changed during copy: $source")}
  }catch{$failures.Add("Final source enumeration failed: $source")}
}
$result=[ordered]@{Version=$manifest.version;ExtensionId=$ExtensionId;CreatedAt=(Get-Date).ToUniversalTime().ToString('o');BackupRoot=$BackupRoot;FileIntegrityPassed=($failures.Count -eq 0);ConsistencyVerified=$false;ConsistencyNote='File hashes cannot prove a cross-file consistent browser database snapshot; browser lock failures and source changes are recorded. Shared browser caches are deliberately not copied.';Failures=@($failures.ToArray());Files=@($records.ToArray())}
Write-JsonFile (Join-Path $BackupRoot 'backup-receipt.json') $result
[pscustomobject]$result
