param(
  [switch]$Check,
  [switch]$UseCpu,
  [string]$PythonExe = '',
  [string]$PluginDir = ''
)

$ErrorActionPreference = 'Stop'
function Info($Message) { Write-Host ('[RVC] ' + $Message) }
function Fail($Message) { Write-Error ('[RVC] ' + $Message); exit 1 }
function Get-PythonVersion {
  param([string]$Executable, [string[]]$Arguments = @())
  try {
    # Read all output: Select-Object -First 1 prematurely terminates Python in
    # Windows PowerShell 5.1 and changes an otherwise successful exit code to -1.
    $output = & $Executable @Arguments -c "import sys;print('%d.%d' % sys.version_info[:2])" 2>$null
    if ($LASTEXITCODE -eq 0) { return [string](@($output)[0]) }
  } catch {
    # An unavailable py.exe runtime writes stderr; try the next candidate.
  }
  return ''
}

# Source archives keep optional service code outside services/voice so installing
# the base plugin never starts an unconfigured RVC service.
$payloadCandidates = @(
  (Join-Path $PSScriptRoot 'dsh-companion\services\voice'),
  (Join-Path $PSScriptRoot 'voice-enhancement')
)
$payload = $payloadCandidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'voice_service.py') } | Select-Object -First 1
if (-not $payload) { Fail 'Voice service payload not found. Extract the complete public enhancement ZIP first.' }

if (-not $PluginDir) {
  $taskDshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
  $pluginCandidates = @(
    $PSScriptRoot,
    (Join-Path $PSScriptRoot 'dsh-companion'),
    (Join-Path $taskDshHome 'profiles\desktop\node_modules\@jyddwy\dsh-companion'),
    (Join-Path $taskDshHome 'profiles\web\node_modules\@jyddwy\dsh-companion'),
    (Join-Path $taskDshHome 'profiles\desktop\node_modules\dsh-companion'),
    (Join-Path $taskDshHome 'profiles\web\node_modules\dsh-companion')
  )
  $PluginDir = $pluginCandidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'package.json') } | Select-Object -First 1
}
if (-not $PluginDir) { Fail 'Base plugin not found. Install it first, or pass -PluginDir with its full directory.' }
$PluginDir = [System.IO.Path]::GetFullPath($PluginDir)
$packageFile = Join-Path $PluginDir 'package.json'
if (-not (Test-Path -LiteralPath $packageFile)) { Fail ('Missing package.json: ' + $PluginDir) }
$packageInfo = [System.IO.File]::ReadAllText($packageFile) | ConvertFrom-Json
if ($packageInfo.name -notin @('dsh-companion', '@jyddwy/dsh-companion')) { Fail 'PluginDir must point to the dsh-companion base plugin.' }
if (-not (Test-Path -LiteralPath (Join-Path $PluginDir 'src\host\plugin.mjs')) -or -not (Test-Path -LiteralPath (Join-Path $PluginDir 'services\capture_server.py'))) { Fail 'This is a different project using the same unscoped package name.' }
$voiceDir = Join-Path $PluginDir 'services\voice'
$venvDir = Join-Path $voiceDir '.venv'
$venvPython = Join-Path $venvDir 'Scripts\python.exe'
Info ('Base plugin: ' + $PluginDir)
Info ('Voice service: ' + $voiceDir)

$taskDshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$pythonCandidates = @()
if ($PythonExe) { $pythonCandidates += $PythonExe }
if ($env:DSH_COMPANION_VOICE_PYTHON) { $pythonCandidates += $env:DSH_COMPANION_VOICE_PYTHON }
$pythonCandidates += (Join-Path $taskDshHome 'dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe')
$pythonCandidates += (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe')
$pythonCandidates += (Join-Path $env:ProgramFiles 'Python312\python.exe')
$basePython = ''
$baseArgs = @()
foreach ($candidate in $pythonCandidates) {
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
  $version = Get-PythonVersion $candidate
  if ($version -eq '3.12') { $basePython = $candidate; break }
}
if (-not $basePython -and (Get-Command py.exe -ErrorAction SilentlyContinue)) {
  $version = Get-PythonVersion 'py.exe' @('-3.12')
  if ($version -eq '3.12') { $basePython = 'py.exe'; $baseArgs = @('-3.12') }
}

$modelRoot = Join-Path $voiceDir 'rvc\assets'
$hubert = Join-Path $modelRoot 'hubert_base\pytorch_model.bin'
$rmvpe = Join-Path $modelRoot 'rmvpe\rmvpe.pt'
$weightsDir = Join-Path $modelRoot 'weights'
$voices = @(Get-ChildItem -LiteralPath $weightsDir -File -Filter '*.pth' -ErrorAction SilentlyContinue)
Info ('Python 3.12: ' + $(if ($basePython) { $basePython } else { 'NOT FOUND' }))
Info ('HuBERT weights: ' + $(if (Test-Path -LiteralPath $hubert) { 'present' } else { 'download required' }))
Info ('RMVPE weights: ' + $(if (Test-Path -LiteralPath $rmvpe) { 'present' } else { 'download required' }))
Info ('Voice model files: ' + $voices.Count)

if ($Check) {
  Info 'Check mode: no files copied, no dependencies installed, no models downloaded.'
  if (-not $basePython -or -not (Test-Path -LiteralPath $venvPython) -or -not (Test-Path -LiteralPath $hubert) -or -not (Test-Path -LiteralPath $rmvpe) -or $voices.Count -eq 0) { exit 2 }
  exit 0
}
if (-not $basePython) { Fail 'Python 3.12 is required for the bundled dependencies. Use -PythonExe with a Python 3.12 executable.' }
if (-not (Test-Path -LiteralPath (Join-Path $payload 'rvc\infer\hubert.py'))) {
  Fail 'RVC runtime is absent from this source-only folder. Download the public voice enhancement ZIP from Releases and run its installer.'
}

if ([System.IO.Path]::GetFullPath($payload) -ne [System.IO.Path]::GetFullPath($voiceDir)) {
  New-Item -ItemType Directory -Path $voiceDir -Force | Out-Null
  foreach ($file in @(Get-ChildItem -LiteralPath $payload -File -Recurse)) {
    $relative = $file.FullName.Substring($payload.Length + 1)
    $target = Join-Path $voiceDir $relative
    # Keep user-created configuration and downloaded models on updates.
    if ((Test-Path -LiteralPath $target) -and ($relative -eq 'config.json' -or $relative -eq 'rvc\configs\config.json' -or $file.Extension -in @('.pth','.pt','.bin','.index','.safetensors','.onnx'))) { continue }
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $target -Force
  }
}
if (-not (Test-Path -LiteralPath $venvPython)) {
  & $basePython @baseArgs -m venv $venvDir
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $venvPython)) { Fail 'Failed to create the voice virtual environment.' }
}
$hasNvidia = $false
if (-not $UseCpu -and (Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue)) {
  & nvidia-smi.exe -L 2>$null | Out-Null
  $hasNvidia = $LASTEXITCODE -eq 0
}
$torchIndex = if ($hasNvidia) { 'https://download.pytorch.org/whl/cu128' } else { 'https://download.pytorch.org/whl/cpu' }
Info ('Installing dependencies from PyPI and PyTorch. This may download several GB: ' + $torchIndex)
& $venvPython -m pip install --upgrade pip --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { Fail 'pip update failed.' }
& $venvPython -m pip install torch torchaudio --index-url $torchIndex --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { Fail 'PyTorch installation failed. Check the network; for a CPU install rerun with -UseCpu.' }
& $venvPython -m pip install -r (Join-Path $voiceDir 'requirements-rvc.txt') --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { Fail 'RVC dependency installation failed.' }
& $venvPython -c "import torch,torchaudio,sounddevice,librosa,faiss,transformers;print('Dependencies OK')"
if ($LASTEXITCODE -ne 0) { Fail 'Dependency verification failed.' }
Info 'Dependencies installed. No model weights are bundled or automatically downloaded.'
Info 'Read docs/RVC-声线下载指南.md, download the general and voice models into services/voice/rvc/assets, then restart voice in the plugin settings.'
exit 0
