$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
$root=Join-Path ([IO.Path]::GetTempPath()) ('vidsift-installer-test-'+[guid]::NewGuid().ToString('N'))
try {
  $plan=& (Join-Path $project 'installer/Install-NativeHost.ps1') -ProjectRoot $project -Version '5.0.0' -InstallRoot $root -DryRun
  if($plan.HostName -ne 'com.vidsift.media'){throw 'wrong host name'}
  if($plan.Origin -ne 'chrome-extension://kggdkncbamdlhhihfkeldbbkppkgihad/'){throw 'wrong allowed origin'}
  if(Test-Path -LiteralPath $root){throw 'DryRun mutated install root'}
  if($plan.RegistryKeys.Count -ne 2){throw 'Chrome and Edge required'}
  $second=& (Join-Path $project 'installer/Install-NativeHost.ps1') -ProjectRoot $project -Version '5.0.0' -InstallRoot $root -DryRun
  if($plan.Release -eq $second.Release -or $plan.PythonPath -eq $second.PythonPath){throw 'Same-version reinstall would overwrite an existing release/environment'}
  if(!$plan.LauncherPath.StartsWith($plan.Release,[StringComparison]::OrdinalIgnoreCase)){throw 'Launcher is not release-local'}
  if($plan.PythonPath.Replace('\','/') -notmatch 'envs/py312-[a-f0-9]{16}-'){throw 'Environment lacks dependency key'}
  Write-Output 'PASS installer dry-run paths/origin/no writes/immutable reinstall layout'
} finally { if(Test-Path -LiteralPath $root){Remove-Item -LiteralPath $root -Recurse -Force} }
