# install.ps1 —— dsh-companion（陪玩插件）安装 / 卸载脚本
#
# 用法（Windows PowerShell 或 pwsh 里执行）：
#   powershell -ExecutionPolicy Bypass -File install.ps1                  # 正式安装（推荐，需先完全退出 DSH）
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Hot             # 免重启安装（不显示在插件列表）
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall       # 卸载（两种方式都会清掉）
#   powershell -ExecutionPolicy Bypass -File install.ps1 -ProfileName web # 指定 profile
#   powershell -ExecutionPolicy Bypass -File install.ps1 -AllowRunning    # 允许 DSH 运行中安装（不保证成功）
#
# 正式安装（默认）：package.json 加 link: 依赖 + dsh.profile.bundles 追加包名，再跑 pnpm；
# 装完重启 DSH 后，设置 → 插件 → 已安装插件 里会出现 dsh-companion，可以启停/卸载/检查更新。
# 免重启安装（-Hot）：在 <profile>/cordis.patch.yml 里插一行 file 路径行，DSH 会热加载；
# 面板立即可用，但插件不会出现在「已安装插件」列表里。

param(
  [switch]$Uninstall,
  [switch]$Proper,
  [switch]$Hot,
  [switch]$AllowRunning,
  [string]$ProfileName = 'auto',
  [string]$PluginDir = $PSScriptRoot,
  [string]$DshHome = ''
)

$ErrorActionPreference = 'Stop'
# 默认正式安装；显式 -Hot 才走免重启
if (-not $Proper -and -not $Hot) { $Proper = $true }
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Step($text) { Write-Host ("[dsh-companion] " + $text) }
function Write-Warn($text) { Write-Host ("[dsh-companion] 注意：" + $text) -ForegroundColor Yellow }
function Write-Ok($text) { Write-Host ("[dsh-companion] " + $text) -ForegroundColor Green }
function Fail($text) { Write-Host ("[dsh-companion] 失败：" + $text) -ForegroundColor Red; exit 1 }

# ── 定位 DSH_HOME 与 profile ────────────────────────────────────────────
if (-not $DshHome) {
  if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME }
  elseif (Test-Path (Join-Path $env:USERPROFILE '.dsh')) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
  else { Fail "找不到 DSH 数据目录（%USERPROFILE%\.dsh）。请先安装并打开一次 DSH，再执行本脚本。" }
}

$profilesRoot = Join-Path $DshHome 'profiles'
$available = @()
if (Test-Path $profilesRoot) {
  $available = @(Get-ChildItem $profilesRoot -Directory | Where-Object {
    Test-Path (Join-Path $_.FullName 'package.json')
  } | ForEach-Object { $_.Name })
}

if ($ProfileName -eq 'auto') {
  if ($available -contains 'desktop') { $ProfileName = 'desktop' }
  elseif ($available -contains 'web') { $ProfileName = 'web' }
  elseif ($available.Count -gt 0) { $ProfileName = $available[0] }
  else { Fail "没有找到已初始化的 DSH profile（$profilesRoot）。请先打开一次 DSH 桌面端（或运行 dsh web），再执行本脚本。" }
}

$profileDir = Join-Path $profilesRoot $ProfileName
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$packagePath = Join-Path $profileDir 'package.json'
$pluginDirFull = [System.IO.Path]::GetFullPath($PluginDir)
$entryPath = (Join-Path $pluginDirFull 'index.js').Replace('\', '/')

$blockStart = '# === dsh-companion 安装块开始（install.ps1 生成，卸载时会整块删除）==='
$blockEnd = '# === dsh-companion 安装块结束 ==='

if (-not (Test-Path $pluginDirFull)) { Fail "找不到插件目录：$pluginDirFull" }
if (-not (Test-Path $packagePath)) {
  Fail ("这个 profile 还没初始化：$profileDir`n请先打开一次 DSH（桌面端或 dsh web），让它生成 profile，再执行本脚本。")
}
if (-not (Test-Path $patchPath)) {
  Set-Content -Path $patchPath -Value "# Your patch layer for this dsh profile.`r`n[]" -Encoding UTF8
}

function Backup-File($path) {
  if (-not (Test-Path $path)) { return }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = "$path.bak-$stamp"
  Copy-Item $path $backup -Force
  Write-Step ("已备份 " + (Split-Path $path -Leaf) + " → " + $backup)
}

function Read-Text($path) {
  if (-not (Test-Path $path)) { return '' }
  return [System.IO.File]::ReadAllText($path)
}

function Write-Text($path, $text) {
  [System.IO.File]::WriteAllText($path, $text, $utf8NoBom)
}

function Test-HotBlock($text) { return $text.Contains($blockStart) }

function Remove-HotBlock($text) {
  $lines = $text -split "`r?`n"
  $result = New-Object System.Collections.Generic.List[string]
  $inside = $false
  foreach ($line in $lines) {
    if ($line.Trim() -eq $blockStart) { $inside = $true; continue }
    if ($line.Trim() -eq $blockEnd) { $inside = $false; continue }
    if (-not $inside) { $result.Add($line) }
  }
  return ($result -join "`r`n")
}

function Format-YamlSingleQuoted($value) {
  return "'" + ($value -replace "'", "''") + "'"
}

function Normalize-PatchForAppend($text) {
  # 新初始化的 profile 里 cordis.patch.yml 可能只有注释和一行 []：
  # 直接往后面追加列表项会变成非法 YAML（[] 后面再跟 - insert），所以先把空的 [] 去掉。
  if (-not $text) { return '' }
  $lines = $text -split "`r?`n"
  $content = @($lines | Where-Object { $_.Trim() -ne '' -and -not $_.Trim().StartsWith('#') })
  if ($content.Count -eq 0) { return '' }
  if ($content.Count -eq 1 -and $content[0].Trim() -eq '[]') {
    $kept = New-Object System.Collections.Generic.List[string]
    foreach ($line in $lines) {
      if ($line.Trim() -ne '[]') { $kept.Add($line) }
    }
    return (($kept -join "`r`n").TrimEnd())
  }
  return $text
}

function Add-HotBlock($text) {
  # 路径用 YAML 单引号包起来：中文、空格、反斜杠都不用转义
  $blockLines = @(
    '',
    $blockStart,
    '- insert:',
    '    - id: dsh-companion',
    ('      name: ' + (Format-YamlSingleQuoted $entryPath)),
    $blockEnd,
    ''
  )
  $normalized = Normalize-PatchForAppend $text
  if (-not $normalized.Trim()) { return (($blockLines -join "`r`n").TrimStart("`r", "`n")) }
  return ($normalized.TrimEnd() + "`r`n" + ($blockLines -join "`r`n"))
}

function Get-Bundles($pkg) {
  if ($null -eq $pkg.dsh) { return @() }
  if ($null -eq $pkg.dsh.profile) { return @() }
  if ($null -eq $pkg.dsh.profile.bundles) { return @() }
  return @($pkg.dsh.profile.bundles)
}

function Set-Bundles($pkg, $bundles) {
  if ($null -eq $pkg.dsh) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
  if ($null -eq $pkg.dsh.profile) { $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force }
  $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
}

function Get-PnpmInvocation {
  $candidates = @()
  $runtimeRoots = @(
    (Join-Path $DshHome 'dsh-runtimes/dsh-primary-runtime/dependencies'),
    (Join-Path $env:USERPROFILE '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies')
  )
  foreach ($root in $runtimeRoots) {
    $node = Join-Path $root 'node/bin/node.exe'
    $pnpm = Join-Path $root 'pnpm/bin/pnpm.mjs'
    if ((Test-Path $node) -and (Test-Path $pnpm)) {
      return [pscustomobject]@{ node = $node; pnpm = $pnpm }
    }
  }
  $candidates = @(
    'E:\dsh_desktop\resources\runtime\primary-runtime',
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\primary-runtime'),
    (Join-Path ${env:ProgramFiles} 'DeepSeek Harness\resources\runtime\primary-runtime')
  )
  if ($env:DSH_DESKTOP_DIR) { $candidates = @((Join-Path $env:DSH_DESKTOP_DIR 'resources\runtime\primary-runtime')) + $candidates }
  foreach ($root in $candidates) {
    $node = Join-Path $root 'dependencies\node\bin\node.exe'
    $pnpm = Join-Path $root 'dependencies\pnpm\bin\pnpm.mjs'
    if ((Test-Path $node) -and (Test-Path $pnpm)) {
      return [pscustomobject]@{ node = $node; pnpm = $pnpm }
    }
  }
  return $null
}

function Assert-DshClosed {
  if ($AllowRunning) { return }
  $running = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
  if ($running.Count -gt 0) {
    Write-Warn 'DSH 似乎还在运行。正式安装会写 profile 并创建目录链接；如果失败会自动回退到免重启安装。建议装完重启一次 DSH 生效。'
  }
}

# ── 卸载 ────────────────────────────────────────────────────────────────
if ($Uninstall) {
  Write-Step "卸载：profile = $profileDir"
  $patchText = Read-Text $patchPath
  if (Test-HotBlock $patchText) {
    Backup-File $patchPath
    Write-Text $patchPath (Remove-HotBlock $patchText)
    Write-Step '已从 cordis.patch.yml 移除安装块（刷新或重启 DSH 后宿主侧卸载）'
  } else {
    Write-Step 'cordis.patch.yml 里没有安装块，跳过。'
  }

  $pkg = $null
  try { $pkg = Get-Content $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
  if ($null -ne $pkg) {
    $bundles = @(Get-Bundles $pkg) | Where-Object { $_ -ne 'dsh-companion' }
    $changed = ($bundles.Count -ne @(Get-Bundles $pkg).Count)
    if ($bundles.Count -ne @(Get-Bundles $pkg).Count) { Set-Bundles $pkg $bundles }
    if ($null -ne $pkg.dependencies -and ($pkg.dependencies.PSObject.Properties.Name -contains 'dsh-companion')) {
      $pkg.dependencies.PSObject.Properties.Remove('dsh-companion')
      $changed = $true
    }
    if ($changed) {
      Backup-File $packagePath
      Write-Text $packagePath ($pkg | ConvertTo-Json -Depth 100)
      Write-Step '已从 package.json 移除 bundle 与依赖（重启 DSH 后生效）。'
    }
    $linkPath = Join-Path (Join-Path $profileDir 'node_modules') 'dsh-companion'
    if (Test-Path $linkPath) {
      try {
        & cmd /c rmdir "$linkPath" 2>&1 | Out-Null
        Write-Step '已移除 node_modules 里的 dsh-companion 目录链接。'
      } catch { }
    }
  }
  Write-Ok '卸载完成。'
  exit 0
}

# ── 免重启安装 ──────────────────────────────────────────────────────────
if (-not $Proper) {
  Write-Step "免重启安装"
  Write-Step "DSH_HOME = $DshHome"
  Write-Step "profile   = $ProfileName"
  Write-Step "插件目录   = $pluginDirFull"
  $patchText = Read-Text $patchPath
  if (Test-HotBlock $patchText) {
    Write-Step '已经装过了（安装块存在），跳过插入。要换路径就先 -Uninstall 再装。'
  } else {
    Backup-File $patchPath
    Write-Text $patchPath (Add-HotBlock $patchText)
    Write-Step '已写入安装块（file 路径行）'
  }
  try {
    $pkg = Get-Content $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (@(Get-Bundles $pkg) -contains 'dsh-companion') {
      Write-Warn '这个 profile 的 bundles 里已经有 dsh-companion（之前正式安装过）。两种方式只能二选一：'
      Write-Warn '  先执行 install.ps1 -Proper -Uninstall，再跑本安装；否则同一个 id 两行会让整行都不生效。'
    }
  } catch { }
  Write-Ok '宿主半侧会在几秒内热加载（不需要关 DSH）。'
  Write-Ok '现在请按 Ctrl+R 刷新 DSH 窗口（或重启一次 DSH），右侧边栏 guide 里会出现「陪玩」。'
  Write-Step '验证：%USERPROFILE%\.dsh\dsh-companion\companion.log 里应出现「插件的 apply() 进入」。'
  exit 0
}

# ── 正式 bundle 安装 ────────────────────────────────────────────────────
Assert-DshClosed
Write-Step "正式安装：profile = $profileDir"
Write-Step "插件目录 = $pluginDirFull"

$patchText = Read-Text $patchPath
if (Test-HotBlock $patchText) {
  Backup-File $patchPath
  Write-Text $patchPath (Remove-HotBlock $patchText)
  Write-Step '已移除旧的免重启安装块，避免同一 id 双挂载。'
}

$originalPkgText = Read-Text $packagePath
$pkg = Get-Content $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
$bundles = @(Get-Bundles $pkg)
if (-not ($bundles -contains 'dsh-companion')) { $bundles += 'dsh-companion' }
Set-Bundles $pkg $bundles
if ($null -eq $pkg.dependencies) {
  $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
}
$pkg.dependencies | Add-Member -NotePropertyName 'dsh-companion' -NotePropertyValue ('link:' + $pluginDirFull.Replace('\', '/')) -Force
Backup-File $packagePath
Write-Text $packagePath ($pkg | ConvertTo-Json -Depth 100)
Write-Step '已更新 package.json（依赖 + bundles）。'

# 用「目录链接（junction）」把插件挂进 profile 的 node_modules。
# 不跑 pnpm：pnpm install 可能因 store 不一致重装整个 node_modules，
# 把用户其它插件一起搞坏（v1.9.1 真实事故），这里彻底避开。
$nodeModules = Join-Path $profileDir 'node_modules'
if (-not (Test-Path $nodeModules)) {
  New-Item -ItemType Directory -Path $nodeModules -Force | Out-Null
}
$linkPath = Join-Path $nodeModules 'dsh-companion'
$linked = $false
try {
  if (Test-Path $linkPath) {
    $existing = Get-Item $linkPath -Force
    if ($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
      & cmd /c rmdir "$linkPath" 2>&1 | Out-Null
    } else {
      throw "node_modules 里已经有非链接的 dsh-companion 目录，请先备份/删除它：$linkPath"
    }
  }
  & cmd /c mklink /J "$linkPath" "$pluginDirFull" 2>&1 | ForEach-Object { Write-Host $_ }
  $linked = Test-Path (Join-Path $linkPath 'package.json')
} catch {
  Write-Warn ("创建目录链接失败：" + $_.Exception.Message)
  $linked = $false
}

if (-not $linked) {
  Write-Warn '正式安装失败，自动回滚 package.json 并回退到免重启安装（插件不会出现在「已安装插件」列表里）。'
  Write-Text $packagePath $originalPkgText
  $patchText = Read-Text $patchPath
  if (-not (Test-HotBlock $patchText)) {
    Backup-File $patchPath
    Write-Text $patchPath (Add-HotBlock $patchText)
  }
  Write-Ok '已回退为免重启安装。刷新/重启 DSH 后右侧边栏会有「陪玩」。'
  exit 0
}

Write-Ok '安装完成。现在打开 DSH：设置 → 插件 → 已安装插件 里会出现 dsh-companion，右侧边栏也会出现「陪玩」。'
Write-Step '这次安装只增加了一个目录链接，没有改动或重装其它插件依赖。'
Write-Step '如果面板没出现：设置 → 插件 里确认 dsh-companion 已启用，然后刷新或重启一次 DSH。'
