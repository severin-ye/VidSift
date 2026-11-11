[CmdletBinding()]
param([switch]$DryRun)
$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'gstack-check.ps1')
function Invoke-ReleaseStep([string]$program,[string[]]$releaseArguments){
 & $program @releaseArguments
 if($LASTEXITCODE -ne 0){throw "$program failed with exit code $LASTEXITCODE; release stopped"}
}
Push-Location $project
$previousToken=[Environment]::GetEnvironmentVariable('GITHUB_TOKEN','Process')
$previousRepository=[Environment]::GetEnvironmentVariable('GITHUB_REPOSITORY','Process')
$previousTag=[Environment]::GetEnvironmentVariable('RELEASE_TAG','Process')
try {
 $version=(Get-Content package.json -Raw|ConvertFrom-Json).version
 if($version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$'){throw 'Invalid package version'}
 $tag="v$version"
 $remoteUrl=(& git remote get-url origin)
 if($LASTEXITCODE -ne 0){throw 'Git origin is required'}
 if($remoteUrl -notmatch '^(https://github\.com/|git@github\.com:)([\w.-]+/[\w.-]+?)(\.git)?$'){throw 'Origin must identify a GitHub repository'}
 $repository=$Matches[2]
 if($DryRun){
  [pscustomobject]@{Version=$version;Tag=$tag;Repository=$repository;Steps=@('check clean main','validate version tag','run checks','build reproducible ZIP','push tag','upload and verify','remove older managed ZIP assets')}
  return
 }
 $branch=(& git branch --show-current)
 if($branch -ne 'main'){throw 'Run the release from the clean main branch'}
 $dirty=(& git status --porcelain=v1 --untracked-files=all)
 if($LASTEXITCODE -ne 0 -or $dirty){throw 'Commit project changes before release; uncommitted or unknown files are present'}
 Invoke-ReleaseStep git @('fetch','origin','--tags')
 $head=(& git rev-parse HEAD)
 $existing=(& git tag --list $tag)
 if($existing){
  $tagged=(& git rev-parse "$tag^{commit}")
  if($tagged -ne $head){throw 'Version tag already belongs to another commit; increment the version rather than replace it'}
 }
 Invoke-GstackCheck -Label 'vidsift-release-check' -Command 'npm.cmd run check'
 & (Join-Path $project 'tests/package.test.ps1')
 if(!$?){throw 'ZIP integrity checks failed'}
 $releaseToken=$previousToken
 if(!$releaseToken){
  if(!(Get-Command gh -ErrorAction SilentlyContinue)){throw 'Install GitHub CLI and run gh auth login first'}
  $releaseToken=(& gh auth token)
  if($LASTEXITCODE -ne 0 -or !$releaseToken){throw 'GitHub authentication is required; run gh auth login'}
 }
 # Credentials exist only in the child-process environment and are never printed.
 [Environment]::SetEnvironmentVariable('GITHUB_TOKEN',$releaseToken,'Process')
 [Environment]::SetEnvironmentVariable('GITHUB_REPOSITORY',$repository,'Process')
 [Environment]::SetEnvironmentVariable('RELEASE_TAG',$tag,'Process')
 Invoke-ReleaseStep git @('push','origin','main')
 if(!$existing){Invoke-ReleaseStep git @('tag','-a',$tag,'-m',"VidSift $tag test release")}
 Invoke-ReleaseStep git @('push','origin',$tag)
 Invoke-ReleaseStep node @('scripts/publish-release.cjs')
}finally{
 [Environment]::SetEnvironmentVariable('GITHUB_TOKEN',$previousToken,'Process')
 [Environment]::SetEnvironmentVariable('GITHUB_REPOSITORY',$previousRepository,'Process')
 [Environment]::SetEnvironmentVariable('RELEASE_TAG',$previousTag,'Process')
 $releaseToken=$null
 Pop-Location
}
