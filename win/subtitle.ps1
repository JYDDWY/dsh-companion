# subtitle.ps1 -- desktop subtitle overlay for dsh-companion.
#
# Always-on-top, frameless, draggable text window that shows what the companion
# is saying (like music-player lyrics). The DSH plugin writes a JSON state file;
# this window polls it and renders the text.
#
# Usage:
#   powershell -NoProfile -STA -ExecutionPolicy Bypass -File subtitle.ps1 `
#       -StateFile <json path> [-PositionFile <json path>]
#
# State JSON:
#   { "text":"...", "at": 1712345678901, "ttlSec": 8,
#     "fontSize": 28, "fontFamily": "Microsoft YaHei",
#     "color": "#ffffff", "bgOpacity": 0.45, "opacity": 0.92 }
# Position JSON: { "x": 100, "y": 40 }  (saved automatically when dragged)

param(
  [Parameter(Mandatory = $true)][string]$StateFile,
  [string]$PositionFile = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName PresentationCore

if (-not (Test-Path $StateFile)) {
  New-Item -ItemType File -Path $StateFile -Force | Out-Null
  Set-Content -Path $StateFile -Value '{}' -Encoding UTF8
}

function Read-State {
  try {
    $raw = [System.IO.File]::ReadAllText($StateFile, [System.Text.Encoding]::UTF8)
    if (-not $raw.Trim()) { return $null }
    return $raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Read-Position {
  if (-not $PositionFile -or -not (Test-Path $PositionFile)) { return $null }
  try {
    $raw = [System.IO.File]::ReadAllText($PositionFile, [System.Text.Encoding]::UTF8)
    if (-not $raw.Trim()) { return $null }
    return $raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$window = New-Object System.Windows.Window
$window.WindowStyle = 'None'
$window.AllowsTransparency = $true
$window.Background = [System.Windows.Media.Brushes]::Transparent
$window.Topmost = $true
$window.ShowInTaskbar = $false
$window.ShowActivated = $false
$window.ResizeMode = 'NoResize'
$window.SizeToContent = 'WidthAndHeight'
$window.Width = [Math]::Min(980, [Math]::Max(420, $screen.Width * 0.72))

$border = New-Object System.Windows.Controls.Border
$border.CornerRadius = New-Object System.Windows.CornerRadius(12)
$border.Padding = New-Object System.Windows.Thickness(18, 10, 18, 10)
$border.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(115, 8, 10, 18))

$text = New-Object System.Windows.Controls.TextBlock
$text.Foreground = [System.Windows.Media.Brushes]::White
$text.FontSize = 28
$text.FontFamily = New-Object System.Windows.Media.FontFamily('Microsoft YaHei')
$text.TextWrapping = 'Wrap'
$text.TextAlignment = 'Center'
$text.MaxWidth = [Math]::Min(940, [Math]::Max(380, $screen.Width * 0.68))

$border.Child = $text
$window.Content = $border

# 初始位置：屏幕顶部居中，或用户上次拖到的位置
$restored = Read-Position
$window.WindowStartupLocation = 'Manual'
if ($restored -and $null -ne $restored.x -and $null -ne $restored.y) {
  $window.Left = [double]$restored.x
  $window.Top = [double]$restored.y
} else {
  $window.Left = $screen.Left + ($screen.Width - $window.Width) / 2
  $window.Top = $screen.Top + 42
}

$window.Background = [System.Windows.Media.Brushes]::Transparent
$window.Opacity = 1.0

$script:lastText = ''
$script:lastAt = 0
$script:dragging = $false

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(150)
$timer.Add_Tick({
  $state = Read-State
  if ($null -eq $state) { return }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $stateText = [string]$state.text
  $at = [double]($state.at)
  $ttl = [double]($state.ttlSec)
  if (-not $ttl -or $ttl -le 0) { $ttl = 8 }
  $visible = $stateText -and $at -gt 0 -and ($now - $at) -le ($ttl * 1000)
  if (-not $visible) {
    if ($window.Visibility -ne 'Hidden') { $window.Visibility = 'Hidden' }
    return
  }
  if ($stateText -ne $script:lastText -or $at -ne $script:lastAt) {
    $text.Text = $stateText
    $script:lastText = $stateText
    $script:lastAt = $at
    try {
      $size = [double]$state.fontSize
      if ($size -ge 10 -and $size -le 120) { $text.FontSize = $size }
    } catch { }
    try {
      if ($state.fontFamily) { $text.FontFamily = New-Object System.Windows.Media.FontFamily([string]$state.fontFamily) }
    } catch { }
    try {
      if ($state.color) { $text.Foreground = (New-Object System.Windows.Media.BrushConverter).ConvertFromString([string]$state.color) }
    } catch { }
    try {
      $bg = [double]$state.bgOpacity
      if ($bg -ge 0 -and $bg -le 1) {
        $border.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb([byte]($bg * 255), 8, 10, 18))
      }
    } catch { }
    try {
      $op = [double]$state.opacity
      if ($op -ge 0.1 -and $op -le 1) { $window.Opacity = $op }
    } catch { }
    $window.Visibility = 'Visible'
    # 位置可能因内容宽度变化而偏移，保持左边缘不动
  }
})
$timer.Start()

# 拖动：按住标题区域（整块）拖，松手后保存位置
$border.Add_MouseLeftButtonDown({
  $script:dragging = $true
  try { $window.DragMove() } catch { }
  $script:dragging = $false
  if ($PositionFile) {
    try {
      $payload = @{ x = [int]$window.Left; y = [int]$window.Top } | ConvertTo-Json -Compress
      [System.IO.File]::WriteAllText($PositionFile, $payload, [System.Text.Encoding]::UTF8)
    } catch { }
  }
})

$app = New-Object System.Windows.Application
$app.Add_Exit({ $timer.Stop() })
$window.Add_Closed({ $timer.Stop(); $app.Shutdown() })
[void]$app.Run($window)
