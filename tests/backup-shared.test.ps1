$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
. (Join-Path $project 'installer/NativeHost.Common.ps1')
$root=Join-Path $project ('.task-artifacts/shared-copy-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$source=Join-Path $root 'data.log';$target=Join-Path $root 'copy.log'
[IO.File]::WriteAllText($source,'test-only stable database bytes')
$writer=[IO.File]::Open($source,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite)
try {
 $hash=Get-SharedHash $source
 Copy-SharedFile -Source $source -Destination $target
 if($hash -ne (Get-FileHash -LiteralPath $target).Hash){throw 'shared copy bytes changed'}
 Write-Output 'PASS read-sharing backup copies stable writer-open files without closing browser'
}finally{$writer.Dispose();Remove-Item -LiteralPath $source,$target -ErrorAction SilentlyContinue;Remove-Item -LiteralPath $root -ErrorAction SilentlyContinue}
