$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
$entry=Join-Path $project 'scripts/Release.ps1'
if(!(Test-Path -LiteralPath $entry)){throw 'Local release entry is missing: release still needs separate Agent operations'}
$beforeTags=(& git -C $project tag --list | Out-String)
$beforeFiles=(& git -C $project status --porcelain=v1 --untracked-files=all | Out-String)
$plan=& $entry -DryRun
$version=(Get-Content (Join-Path $project 'package.json') -Raw|ConvertFrom-Json).version
if($plan.Tag -ne "v$version"){throw 'DryRun is not bound to package version'}
if($plan.Repository -ne 'severin-ye/VidSift'){throw 'Wrong publication repository'}
if($beforeTags -ne (& git -C $project tag --list | Out-String)){throw 'DryRun changed tags'}
if($beforeFiles -ne (& git -C $project status --porcelain=v1 --untracked-files=all | Out-String)){throw 'DryRun changed files'}
Write-Output 'PASS local release DryRun version/repository/no Git or file mutations'
