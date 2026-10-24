# list-fonts.ps1 -- print installed WPF font family names, one per line.
#
# Used by the companion plugin to populate the subtitle font dropdown.
# Keep this file ASCII-only: it is launched with Windows PowerShell 5.1.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore

$utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$names = [System.Windows.Media.Fonts]::SystemFontFamilies |
  ForEach-Object { [string]$_.Source } |
  Where-Object { $_ -and $_.Trim() } |
  Sort-Object -Unique

foreach ($name in $names) {
  [Console]::WriteLine($name)
}
