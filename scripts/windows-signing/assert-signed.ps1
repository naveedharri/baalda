# Fails unless every listed file carries an Authenticode signature that is intact.
#
#   ./assert-signed.ps1 -Path <dir> [-Include *.exe,*.msi] [-Exclude uninstall.exe]
#                       [-Expect <n>] [-RequireTrusted] [-Recurse]
#
# Without -RequireTrusted an untrusted certificate is accepted: SignPath's TEST
# certificate is self-signed, so Windows reports it as not trusted (usually
# UnknownError) even though the signature itself is fine. A missing signer,
# NotSigned, HashMismatch (the file changed after signing),
# NotSupportedFileFormat and Incompatible always fail. Production should pass
# -RequireTrusted, which accepts only Valid.
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string[]]$Include = @('*.exe', '*.msi'),
  [string[]]$Exclude = @(),
  [int]$Expect = -1,
  [switch]$RequireTrusted,
  [switch]$Recurse
)
$ErrorActionPreference = 'Stop'

$files = Get-ChildItem -Path $Path -File -Recurse:$Recurse |
  Where-Object { $name = $_.Name; ($Include | Where-Object { $name -like $_ }) -and -not ($Exclude | Where-Object { $name -like $_ }) }

if ($Expect -ge 0 -and @($files).Count -ne $Expect) {
  Write-Host "::error::expected $Expect file(s) in $Path, found $(@($files).Count): $($files.Name -join ', ')"
  exit 1
}
if (@($files).Count -eq 0) {
  Write-Host "::error::no files to check in $Path"
  exit 1
}

$bad = 0
foreach ($f in $files) {
  $s = Get-AuthenticodeSignature -FilePath $f.FullName
  $subject = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { '(none)' }
  $thumb = if ($s.SignerCertificate) { $s.SignerCertificate.Thumbprint } else { '' }
  Write-Host ("{0}: {1} | signer {2} {3} | {4}" -f $f.FullName, $s.Status, $subject, $thumb, $s.StatusMessage)
  $broken = @('NotSigned', 'HashMismatch', 'NotSupportedFileFormat', 'Incompatible')
  $ok = $s.SignerCertificate -and $(if ($RequireTrusted) { $s.Status -eq 'Valid' } else { $broken -notcontains [string]$s.Status })
  if (-not $ok) {
    Write-Host "::error file=$($f.Name)::signature check failed: $($s.Status) $($s.StatusMessage)"
    $bad++
  }
}
if ($bad -gt 0) { exit 1 }
