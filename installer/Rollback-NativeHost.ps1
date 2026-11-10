[CmdletBinding(SupportsShouldProcess=$true)]
param([Parameter(Mandatory=$true)][string]$Receipt,[string]$RegistryStatePath,[switch]$DryRun)
. (Join-Path $PSScriptRoot 'NativeHost.Common.ps1')
$data=Get-Content -LiteralPath $Receipt -Raw|ConvertFrom-Json
$pointer=Assert-WithinRoot (Join-Path $data.InstallRoot 'runtime/current.json') $data.InstallRoot
$allowed=@($script:NativeKeys)
foreach($item in $data.RegistryState){if($allowed -notcontains $item.Key){throw 'Receipt contains unexpected registry target'}}
if($DryRun -or !$PSCmdlet.ShouldProcess($data.InstallRoot,'Restore native registry and release pointer; preserve browser data and runtime')){return [pscustomobject]@{Pointer=$pointer;RegistryKeys=$allowed;BrowserDataUntouched=$true}}
Set-NativeRegistry $data.RegistryState $RegistryStatePath
if($null -ne $data.PreviousPointer){[IO.File]::WriteAllText($pointer,$data.PreviousPointer,(New-Object Text.UTF8Encoding($false)))}elseif(Test-Path -LiteralPath $pointer){Remove-Item -LiteralPath $pointer}
[pscustomobject]@{RolledBack=$true;BrowserDataUntouched=$true;Receipt=$Receipt}
