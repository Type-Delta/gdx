param(
   [string]$tag
)

$version = $tag -replace '^v', ''
$lines = Get-Content CHANGELOG.md
$capturing = $false
$releaseNotes = @()
$pattern = '^## Version {0}($| )' -f [Regex]::Escape($version)
foreach ($line in $lines) {
   if ($line -match $pattern) {
      $capturing = $true
      continue
   }
   if ($capturing -and ($line -match "^## ")) {
      break
   }
   if ($capturing) {
      $releaseNotes += $line
   }
}
$releaseNotes | Out-File -FilePath release_notes.md -Encoding utf8
