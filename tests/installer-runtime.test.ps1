$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
. (Join-Path $project 'installer/NativeHost.Common.ps1')
$python=Join-Path $project '.task-artifacts/native-venv/Scripts/python.exe'
Assert-IsolatedPython -Python $python -ExpectedRoot (Split-Path (Split-Path $python -Parent) -Parent)
try { Assert-IsolatedPython -Python $python -ExpectedRoot (Join-Path $project '.task-artifacts/not-this-env'); throw 'Wrong prefix was accepted' } catch { if($_.Exception.Message -notmatch 'prefix|isolated|隔离'){throw} }
Write-Output 'PASS Python environment isolation before dependency installation'
