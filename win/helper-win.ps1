# helper-win.ps1 -- Windows-side fallback helper for the dsh-companion plugin.
# ASCII ONLY. Windows PowerShell 5.1 reads a BOM-less .ps1 with the OEM code page;
# non-ASCII bytes in source can corrupt the script. Chinese window titles travel
# back as JSON data (UTF-8 file), never as source text.
#
# Adapted from dsh-game-pet (https://github.com/bigk5780/dsh, MIT License) and
# extended with: burst capture (one process captures N frames), JPEG encoding with
# max-long-edge scaling, and keyboard/mouse idle seconds.
#
# Modes (invoked by the host half with -File):
#   -Mode detect -Out <json>
#       Writes one JSON object (UTF-8 no BOM):
#       {"available":true,"hwnd":..,"pid":..,"process":"..","title":"..","class":"..",
#        "minimized":false,"fullscreen":true,"isFullscreen":true,"idleSec":12.3,
#        "rect":{"x":0,"y":0,"w":1920,"h":1080}}
#   -Mode burst -OutDir <dir> -Count 3 -IntervalMs 300 -MaxLongEdge 1280 -Quality 72 [-Hwnd 0]
#       Captures Count frames into <dir>/frame-0.jpg ... and writes <dir>/frames.json:
#       {"ok":true,"frames":[{"path":"..","width":..,"height":..,"bytes":..,"capturedAt":<ms>}],
#        "window":{...same as detect...},"elapsedMs":123}
#   -Mode capture -Out <png> [-Hwnd 0]     (legacy single full-window/screen PNG capture)

param(
  [Parameter(Mandatory = $true)][ValidateSet('detect', 'capture', 'burst')][string]$Mode,
  [string]$Out = '',
  [string]$OutDir = '',
  [long]$Hwnd = 0,
  [int]$Count = 1,
  [int]$IntervalMs = 0,
  [int]$MaxLongEdge = 1280,
  [int]$Quality = 72
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = $utf8 } catch { }

$script:Source = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class DshCompanionWin
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("user32.dll")]
    private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct LASTINPUTINFO
    {
        public uint cbSize;
        public uint dwTime;
    }

    private static readonly IntPtr PerMonitorV2 = new IntPtr(-4);
    private static readonly IntPtr PerMonitorV1 = new IntPtr(-3);

    private static IntPtr TrySetContext(IntPtr context)
    {
        try { return SetThreadDpiAwarenessContext(context); }
        catch (EntryPointNotFoundException) { return IntPtr.Zero; }
        catch (DllNotFoundException) { return IntPtr.Zero; }
    }

    private static IntPtr EnterPerMonitorContext()
    {
        IntPtr previous = TrySetContext(PerMonitorV2);
        if (previous == IntPtr.Zero) previous = TrySetContext(PerMonitorV1);
        if (previous == IntPtr.Zero)
            throw new InvalidOperationException("could not enter a per-monitor DPI awareness context");
        return previous;
    }

    private static void RestoreContext(IntPtr previous)
    {
        try { SetThreadDpiAwarenessContext(previous); } catch { }
    }

    private static double IdleSeconds()
    {
        LASTINPUTINFO info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        if (!GetLastInputInfo(ref info)) return 0;
        uint now = (uint)Environment.TickCount;
        uint idle = now - info.dwTime;
        return idle / 1000.0;
    }

    // Returns tab-separated foreground window facts.
    public static string ForegroundRaw()
    {
        IntPtr previous = EnterPerMonitorContext();
        try
        {
            IntPtr hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return null;

            int length = GetWindowTextLength(hwnd);
            StringBuilder title = new StringBuilder(length + 2);
            GetWindowText(hwnd, title, title.Capacity);

            StringBuilder cls = new StringBuilder(256);
            GetClassName(hwnd, cls, cls.Capacity);

            uint pid = 0;
            GetWindowThreadProcessId(hwnd, out pid);

            RECT rect;
            bool hasRect = GetWindowRect(hwnd, out rect);

            bool fullscreen = false;
            IntPtr monitor = MonitorFromWindow(hwnd, 2);
            if (monitor != IntPtr.Zero)
            {
                MONITORINFO info = new MONITORINFO();
                info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
                if (GetMonitorInfo(monitor, ref info))
                {
                    fullscreen = hasRect
                        && rect.Left <= info.rcMonitor.Left && rect.Top <= info.rcMonitor.Top
                        && rect.Right >= info.rcMonitor.Right && rect.Bottom >= info.rcMonitor.Bottom;
                }
            }

            double idle = IdleSeconds();
            return string.Join("\t", new string[] {
                hwnd.ToInt64().ToString(),
                pid.ToString(),
                IsIconic(hwnd) ? "1" : "0",
                fullscreen ? "1" : "0",
                hasRect ? rect.Left.ToString() : "0",
                hasRect ? rect.Top.ToString() : "0",
                hasRect ? (rect.Right - rect.Left).ToString() : "0",
                hasRect ? (rect.Bottom - rect.Top).ToString() : "0",
                cls.ToString(),
                title.ToString(),
                idle.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture)
            });
        }
        finally { RestoreContext(previous); }
    }

    private static Rectangle TargetBounds(long hwndValue)
    {
        if (hwndValue != 0)
        {
            RECT rect;
            if (!GetWindowRect(new IntPtr(hwndValue), out rect))
                throw new InvalidOperationException("GetWindowRect failed for hwnd " + hwndValue);
            return Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom);
        }
        return System.Windows.Forms.SystemInformation.VirtualScreen;
    }

    private static Bitmap Grab(Rectangle bounds)
    {
        if (bounds.Width <= 0 || bounds.Height <= 0)
            throw new InvalidOperationException("the capture region has no drawable area");
        Bitmap bitmap = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format24bppRgb);
        using (Graphics graphics = Graphics.FromImage(bitmap))
        {
            graphics.CopyFromScreen(bounds.X, bounds.Y, 0, 0, bounds.Size);
        }
        return bitmap;
    }

    private static Bitmap Scale(Bitmap source, int maxLongEdge)
    {
        if (maxLongEdge <= 0) return source;
        int longEdge = Math.Max(source.Width, source.Height);
        if (longEdge <= maxLongEdge) return source;
        double factor = (double)maxLongEdge / longEdge;
        int width = Math.Max(1, (int)Math.Round(source.Width * factor));
        int height = Math.Max(1, (int)Math.Round(source.Height * factor));
        Bitmap scaled = new Bitmap(width, height, PixelFormat.Format24bppRgb);
        using (Graphics graphics = Graphics.FromImage(scaled))
        {
            graphics.CompositingQuality = CompositingQuality.HighSpeed;
            graphics.InterpolationMode = InterpolationMode.Bilinear;
            graphics.PixelOffsetMode = PixelOffsetMode.HighSpeed;
            graphics.DrawImage(source, 0, 0, width, height);
        }
        source.Dispose();
        return scaled;
    }

    private static void SaveJpeg(Bitmap bitmap, string path, int quality)
    {
        ImageCodecInfo codec = null;
        foreach (ImageCodecInfo candidate in ImageCodecInfo.GetImageEncoders())
        {
            if (candidate.MimeType == "image/jpeg") { codec = candidate; break; }
        }
        if (codec == null) throw new InvalidOperationException("no JPEG encoder available");
        EncoderParameters parameters = new EncoderParameters(1);
        parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
        bitmap.Save(path, codec, parameters);
    }

    // Burst capture: returns newline separated rows "path\tw\th\tbytes\tepochMs".
    public static string Burst(string outDir, int count, int intervalMs, int maxLongEdge, int quality, long hwndValue)
    {
        System.IO.Directory.CreateDirectory(outDir);
        var rows = new StringBuilder();
        var stopwatch = Stopwatch.StartNew();
        for (int index = 0; index < count; index++)
        {
            string path = System.IO.Path.Combine(outDir, "frame-" + index + ".jpg");
            int width = 0, height = 0;
            long bytes = 0;
            IntPtr previous = EnterPerMonitorContext();
            try
            {
                Rectangle bounds = TargetBounds(hwndValue);
                Bitmap bitmap = Grab(bounds);
                try
                {
                    Bitmap final = Scale(bitmap, maxLongEdge);
                    try
                    {
                        SaveJpeg(final, path, quality);
                        width = final.Width;
                        height = final.Height;
                        bytes = new System.IO.FileInfo(path).Length;
                    }
                    finally { if (!object.ReferenceEquals(final, bitmap)) final.Dispose(); }
                }
                finally { bitmap.Dispose(); }
            }
            finally { RestoreContext(previous); }

            long epochMs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
            if (rows.Length > 0) rows.Append("\n");
            rows.Append(path + "\t" + width + "\t" + height + "\t" + bytes + "\t" + epochMs);

            if (index < count - 1 && intervalMs > 0)
            {
                int elapsed = (int)stopwatch.ElapsedMilliseconds;
                int wait = intervalMs - (elapsed - index * intervalMs);
                if (wait > 0) Thread.Sleep(wait);
            }
        }
        return rows.ToString();
    }

    public static string CapturePng(string outputPath, long hwndValue)
    {
        IntPtr previous = EnterPerMonitorContext();
        try
        {
            Rectangle bounds = TargetBounds(hwndValue);
            using (Bitmap bitmap = Grab(bounds))
            {
                bitmap.Save(outputPath, ImageFormat.Png);
            }
            return "ok";
        }
        finally { RestoreContext(previous); }
    }
}
'@

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition $script:Source -ReferencedAssemblies 'System.Windows.Forms.dll', 'System.Drawing.dll' -ErrorAction Stop

function Write-JsonFile([string]$path, $payload) {
  if (-not $path) { return }
  [System.IO.File]::WriteAllText($path, ($payload | ConvertTo-Json -Compress -Depth 6), $utf8)
}

function Get-WindowObject {
  $line = [DshCompanionWin]::ForegroundRaw()
  if (-not $line) {
    return [ordered]@{ available = $false; error = 'no foreground window' }
  }
  $parts = $line -split "`t"
  $procId = [int]$parts[1]
  $procName = ''
  try { $procName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { $procName = '' }
  return [ordered]@{
    available    = $true
    hwnd         = [int64]$parts[0]
    pid          = $procId
    process      = $procName
    minimized    = ($parts[2] -eq '1')
    fullscreen   = ($parts[3] -eq '1')
    isFullscreen = ($parts[3] -eq '1')
    rect         = [ordered]@{ x = [int]$parts[4]; y = [int]$parts[5]; w = [int]$parts[6]; h = [int]$parts[7] }
    class        = $parts[8]
    title        = $parts[9]
    idleSec      = [double]::Parse($parts[10], [System.Globalization.CultureInfo]::InvariantCulture)
  }
}

if ($Mode -eq 'capture') {
  if (-not $Out) { throw 'capture requires -Out <png path>' }
  [void][DshCompanionWin]::CapturePng($Out, $Hwnd)
  exit 0
}

if ($Mode -eq 'burst') {
  if (-not $OutDir) { throw 'burst requires -OutDir <directory>' }
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $raw = [DshCompanionWin]::Burst($OutDir, [Math]::Max(1, $Count), [Math]::Max(0, $IntervalMs), $MaxLongEdge, $Quality, $Hwnd)
  $frames = @()
  foreach ($row in ($raw -split "`n")) {
    if (-not $row.Trim()) { continue }
    $p = $row -split "`t"
    $frames += [ordered]@{
      path       = $p[0]
      width      = [int]$p[1]
      height     = [int]$p[2]
      bytes      = [int64]$p[3]
      capturedAt = [int64]$p[4]
    }
  }
  $payload = [ordered]@{
    ok        = ($frames.Count -gt 0)
    frames    = $frames
    window    = Get-WindowObject
    elapsedMs = [int]$stopwatch.ElapsedMilliseconds
  }
  if ($Out) { Write-JsonFile $Out $payload } else { Write-Output ($payload | ConvertTo-Json -Compress -Depth 6) }
  exit 0
}

# detect
$payload = Get-WindowObject
if ($Out) { Write-JsonFile $Out $payload } else { Write-Output ($payload | ConvertTo-Json -Compress -Depth 6) }
exit 0
