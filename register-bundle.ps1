# register-bundle.ps1 —— 兼容旧入口：现在只是调用 install.ps1。
#
# v1.9.1 及以前，这个脚本会跑 pnpm install 把插件登记成 profile 组合包。
# 但 pnpm 在 store 不一致时可能重装整个 node_modules，把其它插件一起搞坏
# （2026-10-22 真实事故），所以新安装器改用「目录链接（junction）」，
# 不再执行 pnpm。这个脚本保留下来只是为了兼容旧文档/旧快捷方式。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\register-bundle.ps1
#   powershell -ExecutionPolicy Bypass -File .\register-bundle.ps1 -Unregister
#   powershell -ExecutionPolicy Bypass -File .\register-bundle.ps1 -DshHome "C:\Users\你\.dsh"

param(
  [string]$DshHome = '',
  [string]$ProfileName = '',
  [string]$PluginDir = '',
  [switch]$Unregister
)

$ErrorActionPreference = 'Stop'
if (-not $PluginDir) { $PluginDir = $PSScriptRoot }
$installer = Join-Path $PluginDir 'install.ps1'
if (-not (Test-Path $installer)) { Write-Host "找不到 install.ps1：$installer" -ForegroundColor Red; exit 1 }

$arguments = @('-ExecutionPolicy', 'Bypass', '-File', $installer, '-PluginDir', $PluginDir)
if ($DshHome) { $arguments += @('-DshHome', $DshHome) }
if ($ProfileName) { $arguments += @('-ProfileName', $ProfileName) }
if ($Unregister) { $arguments += '-Uninstall' }

& powershell -NoProfile @arguments
exit $LASTEXITCODE
