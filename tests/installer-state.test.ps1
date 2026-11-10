$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
. (Join-Path $project 'installer/NativeHost.Common.ps1')
$root=Join-Path ([IO.Path]::GetTempPath()) ('vidsift-installer-state-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -Force|Out-Null
try {
  $source=Join-Path $root 'installed';$profile=Join-Path $root 'profile';$backup=Join-Path $root 'backup'
  New-Item -ItemType Directory -Path $source,$profile -Force|Out-Null
  Write-JsonFile (Join-Path $source 'manifest.json') @{version='4.12.0'}
  [IO.File]::WriteAllText((Join-Path $source 'source.js'),'original')
  $store=Join-Path $profile 'Local Extension Settings/nigiglinogpocaonjlenipdhhlmnkmee'
  New-Item -ItemType Directory -Path $store -Force|Out-Null
  [IO.File]::WriteAllText((Join-Path $store '000001.log'),'private settings')
  $result=& (Join-Path $project 'installer/Backup-Original.ps1') -InstalledExtensionRoot $source -ProfileRoot $profile -BackupRoot $backup
  if(!$result.FileIntegrityPassed -or $result.ConsistencyVerified){throw 'Invalid backup integrity/consistency claim'}
  if((Get-Content -LiteralPath (Join-Path $backup 'local/000001.log') -Raw) -ne 'private settings'){throw 'Settings not backed up'}
  $locked=[IO.File]::Open((Join-Path $store '000001.log'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try { $failed=& (Join-Path $project 'installer/Backup-Original.ps1') -InstalledExtensionRoot $source -ProfileRoot $profile -BackupRoot (Join-Path $root 'locked-backup');if($failed.FileIntegrityPassed -or $failed.Failures.Count -eq 0){throw 'Locked file incorrectly claimed verified'} }finally{$locked.Dispose()}
  $runtime=Join-Path $root 'runtime';New-Item -ItemType Directory -Path $runtime -Force|Out-Null
  [IO.File]::WriteAllText((Join-Path $runtime 'current.json'),'new-pointer')
  $old=@($script:NativeKeys|ForEach-Object{[pscustomobject]@{Key=$_;Exists=$false;HasDefault=$false;Value=$null}})
  $receipt=Join-Path $root 'rollback.json';Write-JsonFile $receipt @{InstallRoot=$root;RegistryState=$old;PreviousPointer='old-pointer'}
  $adapter=Join-Path $root 'registry.json';Write-JsonFile $adapter @()
  $rolled=& (Join-Path $project 'installer/Rollback-NativeHost.ps1') -Receipt $receipt -RegistryStatePath $adapter -Confirm:$false
  if(!$rolled.RolledBack -or (Get-Content (Join-Path $runtime 'current.json') -Raw) -ne 'old-pointer'){throw 'Pointer rollback failed'}
  if(!(Test-Path (Join-Path $store '000001.log'))){throw 'Browser data was removed'}
  Write-Output 'PASS original hashes, private settings, locked-file failure, adapter rollback, preserved browser data'
} finally { $resolved=[IO.Path]::GetFullPath($root);if(!$resolved.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe test cleanup'};Remove-Item -LiteralPath $resolved -Recurse -Force }
