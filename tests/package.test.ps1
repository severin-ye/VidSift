$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
$packageScript=Join-Path $project 'scripts/Package.ps1'
$version=(Get-Content (Join-Path $project 'package.json') -Raw|ConvertFrom-Json).version
$zip=Join-Path $project "dist/VidSift-$version-standalone.zip"
$source=Get-Item -LiteralPath (Join-Path $project 'popup.html')
$previousTime=$source.LastWriteTimeUtc
function Get-PackageHash([string]$packagePath){
 $algorithm=[Security.Cryptography.SHA256]::Create()
 try{return [Convert]::ToBase64String($algorithm.ComputeHash([IO.File]::ReadAllBytes($packagePath)))}finally{$algorithm.Dispose()}
}
try {
 & $packageScript | Out-Null
 $first=Get-PackageHash $zip
 $source.LastWriteTimeUtc=$previousTime.AddDays(2)
 & $packageScript | Out-Null
 $second=Get-PackageHash $zip
 if($first -ne $second){throw 'Source modification time changed ZIP bytes; retry would replace the same version'}
 Add-Type -AssemblyName System.IO.Compression.FileSystem
 $archive=[IO.Compression.ZipFile]::OpenRead($zip)
 try {
  if(!($archive.Entries|Where-Object FullName -eq 'manifest.json')){throw 'ZIP lacks root manifest'}
  foreach($entry in $archive.Entries){
   if($entry.FullName.EndsWith('/')){continue}
   if($entry.FullName -match '(^|/)(\.git|\.serena|\.agent-status|\.task-artifacts|node_modules)(/|$)'){throw 'Private or development artifact in ZIP'}
   $input=$entry.Open();$output=New-Object IO.MemoryStream
   try {$input.CopyTo($output);$actual=$output.ToArray()}finally{$input.Dispose();$output.Dispose()}
   $expected=[IO.File]::ReadAllBytes((Join-Path $project $entry.FullName))
   if([Convert]::ToBase64String($actual) -ne [Convert]::ToBase64String($expected)){throw "Export differs from source: $($entry.FullName)"}
  }
 }finally{$archive.Dispose()}
 Write-Output 'PASS deterministic ZIP / root manifest / exact source bytes / no private state'
}finally{$source.LastWriteTimeUtc=$previousTime}
