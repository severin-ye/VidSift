$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
. (Join-Path $project 'installer/NativeHost.Common.ps1')
$testSub='Software\VidSiftTests\'+[guid]::NewGuid().ToString('N');$testKey='HKCU:\'+$testSub
$originalKeys=$script:NativeKeys;$script:NativeKeys=@($testKey)
try {
 Set-NativeRegistry @([pscustomobject]@{Key=$testKey;Exists=$true;HasDefault=$true;Value='test-manifest';Kind='ExpandString'}) $null
 $state=Read-NativeRegistry $null
 if($state[0].Value -ne 'test-manifest' -or $state[0].Kind -ne 'ExpandString'){throw 'Registry write/read-back failed'}
 Set-NativeRegistry @([pscustomobject]@{Key=$testKey;Exists=$false;HasDefault=$false;Value=$null}) $null
 if(Test-Path -LiteralPath $testKey){throw 'Registry rollback did not remove owned empty key'}
 Write-Output 'PASS actual HKCU writable default value, kind and rollback'
}finally{$script:NativeKeys=$originalKeys;[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($testSub,$false)}
