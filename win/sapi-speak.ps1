# sapi-speak.ps1 -- offline Windows SAPI speech fallback for dsh-companion.
# ASCII ONLY (Windows PowerShell 5.1 reads BOM-less .ps1 with the OEM code page).
#
# Usage:
#   powershell -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File sapi-speak.ps1 `
#       -TextFile <utf8 text file> [-VoiceName "Microsoft Huihui Desktop"] [-Rate -2..2]
#
# Reads the text as UTF-8 (the host half writes it), synthesizes synchronously to the
# default audio device, then exits. Killing this process stops the speech.

param(
  [Parameter(Mandatory = $true)][string]$TextFile,
  [string]$VoiceName = '',
  [int]$Rate = 0,
  [int]$Volume = 100
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

if (-not (Test-Path $TextFile)) { throw "text file not found: $TextFile" }
$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
if (-not $text.Trim()) { exit 0 }

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $synth.Volume = [Math]::Max(0, [Math]::Min(100, $Volume)) } catch { }
try {
  $chosen = $null
  if ($VoiceName) {
    try { $synth.SelectVoice($VoiceName); $chosen = $VoiceName } catch { $chosen = $null }
  }
  if (-not $chosen) {
    # Prefer a Chinese voice so Chinese lines are not read by an English voice.
    $zh = $synth.GetInstalledVoices() | Where-Object {
      $_.Enabled -and ($_.VoiceInfo.Culture.Name -like 'zh-*')
    } | Select-Object -First 1
    if ($zh) {
      try { $synth.SelectVoice($zh.VoiceInfo.Name); $chosen = $zh.VoiceInfo.Name } catch { }
    }
  }
  if (-not $chosen) {
    $first = $synth.GetInstalledVoices() | Where-Object { $_.Enabled } | Select-Object -First 1
    if ($first) { try { $synth.SelectVoice($first.VoiceInfo.Name) } catch { } }
  }
  $synth.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
  $synth.Speak($text)
}
finally {
  $synth.Dispose()
}
exit 0
