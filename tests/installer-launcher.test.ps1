$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
. (Join-Path $project 'installer/NativeHost.Common.ps1')
$root=Join-Path ([IO.Path]::GetTempPath()) ('vidsift-launcher-test-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -Force|Out-Null
try {
  $launcher=Join-Path $root 'native-launcher.exe';$hostScript=Join-Path $root 'echo.py'
  $csc=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
  Invoke-Checked $csc @('/nologo','/target:winexe','/reference:System.Web.Extensions.dll',"/out:$launcher",(Join-Path $project 'installer/NativeLauncher.cs'))
  [IO.File]::WriteAllText($hostScript,"import sys`nassert sys.argv[1] == 'chrome-extension://kggdkncbamdlhhihfkeldbbkppkgihad/'`ndata = sys.stdin.buffer.read()`nsys.stdout.buffer.write(data)`nsys.stdout.buffer.flush()`nsys.stderr.write('origin accepted')`n")
  $python=Join-Path $project '.task-artifacts/native-venv/Scripts/python.exe'
  Write-JsonFile (Join-Path $root 'current.json') @{PythonPath=$python;HostPath=$hostScript}
  # .NET Framework's redirected stdin writer emits a BOM; Python keeps this binary fixture exact.
  $probe=Join-Path $root 'probe.py'
  [IO.File]::WriteAllText($probe,@"
import subprocess, sys
payload = bytes([0, 0, 0, 0, 255, 0, 128, 10, 13, 34, 92])
result = subprocess.run([sys.argv[1], 'chrome-extension://kggdkncbamdlhhihfkeldbbkppkgihad/'], input=payload, capture_output=True, timeout=15)
assert result.returncode == 0, result.stderr
assert result.stdout == payload, repr(result.stdout)
assert result.stderr == b'origin accepted', result.stderr
"@)
  Invoke-Checked $python @($probe,$launcher)
  Write-Output 'PASS compiled winexe binary stdin/stdout, origin and stderr forwarding'
} finally { $resolved=[IO.Path]::GetFullPath($root);if(!$resolved.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe test cleanup'};Remove-Item -LiteralPath $resolved -Recurse -Force }
