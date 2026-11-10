[CmdletBinding(SupportsShouldProcess=$true)]
param([Parameter(Mandatory=$true)][string]$ProjectRoot,[string]$Version,[string]$InstallRoot=(Join-Path $env:LOCALAPPDATA 'VidSift'),[string]$RegistryStatePath,[switch]$DryRun)
. (Join-Path $PSScriptRoot 'NativeHost.Common.ps1')
$ProjectRoot=[IO.Path]::GetFullPath($ProjectRoot);$InstallRoot=[IO.Path]::GetFullPath($InstallRoot)
if(!$PSBoundParameters.ContainsKey('Version')){$Version=([IO.File]::ReadAllText((Join-Path $ProjectRoot 'package.json'))|ConvertFrom-Json).version}
if($Version -notmatch '^\d+\.\d+\.\d+$'){throw 'Version must be numeric x.y.z'}
$runtime=Join-Path $InstallRoot 'runtime'
# Every installation gets a new immutable release and dependency environment;
# uv's wheel/download cache is shared, never an older installed venv.
$dependencyInput=(Get-FileHash -LiteralPath (Join-Path $ProjectRoot 'requirements-native.txt') -Algorithm SHA256).Hash
$dependencyKey='py312-'+$dependencyInput.Substring(0,16).ToLower()
$installationId=[guid]::NewGuid().ToString('N')
$release=Join-Path $InstallRoot "releases/$Version/native/$installationId"
$manifest=Join-Path $release 'com.vidsift.media.json'
$venv=Join-Path $runtime ('envs/'+$dependencyKey+'-'+$installationId);$python=Join-Path $venv 'Scripts/python.exe'
$launcher=Join-Path $release 'native-launcher.exe'
$plan=[pscustomobject]@{HostName='com.vidsift.media';Origin='chrome-extension://kggdkncbamdlhhihfkeldbbkppkgihad/';Runtime=$runtime;Release=$release;Manifest=$manifest;RegistryKeys=$script:NativeKeys;PythonPath=$python;LauncherPath=$launcher;DependencyKey=$dependencyKey}
if(!(Test-Path -LiteralPath (Join-Path $ProjectRoot 'native/host.py'))){throw 'native/host.py missing'}
if($DryRun -or !$PSCmdlet.ShouldProcess($InstallRoot,'Install per-user VidSift Native Messaging host; retain rollback receipt')){return $plan}
$uv=(Get-Command uv -ErrorAction Stop).Source
$csc=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe';if(!(Test-Path -LiteralPath $csc)){throw '.NET Framework C# compiler not found'}
if((Test-Path -LiteralPath $release) -or (Test-Path -LiteralPath $venv)){throw 'Refusing to modify an existing release or dependency environment'}
New-Item -ItemType Directory -Path $runtime,$release,(Join-Path $runtime 'bin') -Force|Out-Null
$pointer=Join-Path $runtime 'current.json';$previous=Read-NativePointer $pointer
$state=Read-NativeRegistry $RegistryStatePath
$backup=Join-Path $InstallRoot ('backups/native-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $backup -Force|Out-Null
$receipt=[ordered]@{Version=$Version;InstallRoot=$InstallRoot;RegistryState=@($state);PreviousPointer=$previous;CreatedAt=(Get-Date).ToUniversalTime().ToString('o');Applied=$false}
Write-JsonFile (Join-Path $backup 'rollback.json') $receipt

if(!(Test-Path -LiteralPath $python)){Invoke-Checked $uv @('venv','--managed-python','--python','3.12',$venv)}
$pythonVersion=& $python -c "import sys; print('%s.%s' % sys.version_info[:2])";if($LASTEXITCODE -ne 0 -or $pythonVersion.Trim() -ne '3.12'){throw 'Shared runtime must use Python 3.12'}
Assert-IsolatedPython -Python $python -ExpectedRoot $venv
Invoke-Checked $uv @('pip','install','--python',$python,'-r',(Join-Path $ProjectRoot 'requirements-native.txt'))
$ffmpeg=Join-Path $runtime 'bin/ffmpeg.exe'
if(!(Test-Path -LiteralPath $ffmpeg)){
  $candidate=$env:VIDSIFT_FFMPEG;if(!$candidate){$found=Get-Command ffmpeg -ErrorAction SilentlyContinue;if($found){$candidate=$found.Source}}
  if($candidate -and (Test-Path -LiteralPath $candidate)){Copy-Item -LiteralPath $candidate -Destination $ffmpeg;$source="Existing binary: $candidate"}
  else {
    Invoke-Checked $uv @('pip','install','--python',$python,'imageio-ffmpeg>=0.6,<0.7')
    $candidate=& $python -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())';if($LASTEXITCODE -ne 0){throw 'Cannot locate imageio-ffmpeg binary'}
    Copy-Item -LiteralPath $candidate.Trim() -Destination $ffmpeg
    $source='imageio-ffmpeg 0.6 distribution; https://github.com/imageio/imageio-ffmpeg ; bundled FFmpeg license applies; inspect ffmpeg -L receipt'
    $licensePaths=& $python -c "import importlib.metadata as m; d=m.distribution('imageio-ffmpeg'); [print(d.locate_file(p)) for p in d.files if 'license' in str(p).lower()]"
    foreach($license in $licensePaths){if(Test-Path -LiteralPath $license){Copy-Item -LiteralPath $license -Destination (Join-Path $backup ('imageio-'+[IO.Path]::GetFileName($license)))}}
  }
  $savedErrorPreference=$ErrorActionPreference
  try { $ErrorActionPreference='Continue';$licenseText=& $ffmpeg -L 2>&1|Out-String } finally { $ErrorActionPreference=$savedErrorPreference }
  [IO.File]::WriteAllText((Join-Path $runtime 'bin/ffmpeg-license.txt'),$licenseText)
  Write-JsonFile (Join-Path $runtime 'bin/ffmpeg-source.json') @{Source=$source;SHA256=(Get-FileHash -LiteralPath $ffmpeg -Algorithm SHA256).Hash;InstalledAt=(Get-Date).ToUniversalTime().ToString('o')}
}
Invoke-Checked $ffmpeg @('-version')
foreach($name in @('host.py','__init__.py','THIRD_PARTY.md')){ $from=Join-Path $ProjectRoot "native/$name";$to=Join-Path $release $name;if(Test-Path -LiteralPath $from){if((Test-Path -LiteralPath $to) -and (Get-FileHash -LiteralPath $from).Hash -ne (Get-FileHash -LiteralPath $to).Hash){throw "Release $Version already has different $name; use a new version"};Copy-Item -LiteralPath $from -Destination $to -Force}}
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'requirements-native.txt') -Destination $release -Force
$launcher=Join-Path $release 'native-launcher.exe';$stagedLauncher=$launcher
Invoke-Checked $csc @('/nologo','/target:winexe','/reference:System.Web.Extensions.dll',"/out:$stagedLauncher",(Join-Path $PSScriptRoot 'NativeLauncher.cs'))
# Launcher lives only in this fresh release; old launchers are never replaced.
$config=@{PythonPath=$python;HostPath=(Join-Path $release 'host.py');FfmpegPath=$ffmpeg;LauncherPath=$launcher}
Write-JsonFile (Join-Path $release 'current.json') $config
Write-JsonFile $manifest @{name=$plan.HostName;description='VidSift per-user media extraction host';path=$launcher;type='stdio';allowed_origins=@($plan.Origin)}
$validate=$null
if(!$RegistryStatePath){$validate={Assert-NativeExternalVisibility -Pointer $pointer -Configuration $config -Manifest $manifest}}
Set-NativeActivation -Pointer $pointer -Configuration $config -Manifest $manifest -RegistryStatePath $RegistryStatePath -Validate $validate
$receipt.Applied=$true;Write-JsonFile (Join-Path $backup 'rollback.json') $receipt
[pscustomobject]@{Installed=$true;ExternalVisibilityVerified=(!$RegistryStatePath);Version=$Version;Manifest=$manifest;Runtime=$runtime;Release=$release;PythonPath=$python;LauncherPath=$launcher;RollbackReceipt=(Join-Path $backup 'rollback.json')}
