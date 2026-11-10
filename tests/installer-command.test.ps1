$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
. (Join-Path $project 'installer/NativeHost.Common.ps1')
$python=Join-Path $project '.task-artifacts/native-venv/Scripts/python.exe'
Invoke-Checked $python @('-c',"import sys; print('normal output'); sys.stderr.write('normal progress\n')")
if($ErrorActionPreference -ne 'Stop'){throw 'Error preference was not restored after success'}
$rejected=$false
try { Invoke-Checked $python @('-c',"import sys; sys.stderr.write('failure detail\n'); sys.exit(7)") }
catch { if($_.Exception.Message -notmatch 'Command failed \(7\)'){throw};$rejected=$true }
if(!$rejected){throw 'Nonzero native exit status was accepted'}
if($ErrorActionPreference -ne 'Stop'){throw 'Error preference was not restored after failure'}
$missing=$false
try { Invoke-Checked 'vidsift-command-that-does-not-exist' @() } catch { $missing=$true }
if(!$missing){throw 'Missing executable was accepted'}
Write-Output 'PASS native stderr progress, exit status and error preference restoration'
