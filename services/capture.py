#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""dsh-capture — Windows 屏幕/游戏截图服务（DSH 陪玩插件用）

零第三方依赖：只用 Python 标准库 + ctypes 直接调用 Win32 / GDI / GDI+
（gdiplus.dll 随 Windows 自带）。系统 Python 3.13 直接可跑，无需 pip install。

能力
----
- 截取：主显示器 / 指定显示器 / 虚拟桌面（全部显示器拼合）/ 前台窗口 / 指定 HWND / 按 exe 名找窗口
- 输出 JPEG：长边缩放（max_side）或缩放系数（scale），质量 1-100 可配；GDI+ 编码
- 一次调用连拍 N 帧（帧间隔 ms 可配），返回帧路径 + 可选 base64
- 同时返回前台窗口元信息（标题 / 进程 exe / PID / 窗口矩形 / 最大化 / 全屏 / 显示器 / DPI）
  + 显示器拓扑 + 疑似游戏启发式判断
- 全黑帧检测（缩略图亮度均值 / 标准差 / 暗像素比例），窗口模式失败自动降级
  BitBlt(screen) -> BitBlt(no CAPTUREBLT) -> PrintWindow(PW_RENDERFULLCONTENT)
- DPI 感知：优先 Per-Monitor V2，其次 Per-Monitor / System；坐标一律为物理像素

接口形态（三种，详见 README.md）
--------------------------------
1) 一次性 CLI：`python capture.py --json --count 3 --interval-ms 300`
   一行 JSON 到 stdout，诊断信息走 stderr。
2) 常驻 stdio NDJSON：`python capture.py --serve stdio`
   插件把子进程 stdin/stdout 当请求/响应对，避免每次冷启动 Python 的开销（推荐）。
3) 极简 HTTP：`python capture.py --serve http --port 8765`
   GET/POST /capture /info /health。

示例
----
  python capture.py --json --count 3 --interval-ms 300
  python capture.py --json --mode window --exe RimWorld --max-side 1600 --base64
  python capture.py --json --mode foreground --bench 10
  python capture.py --info
  python capture.py --serve stdio

作者：DSH 陪玩项目 capture-service（2026-10）；许可证：随项目。
"""

from __future__ import annotations

import argparse
import base64
import ctypes
import ctypes.wintypes as w
import json
import math
import os
import platform
import random
import re
import sys
import threading
import time
import traceback
from pathlib import Path

if sys.platform != "win32":  # pragma: no cover
    raise SystemExit("dsh-capture 只支持 Windows（依赖 user32/gdi32/gdiplus）")

__version__ = "1.0.0"
SCHEMA = "dsh.capture/1"
SCRIPT_DIR = Path(__file__).resolve().parent

# --------------------------------------------------------------------------------------
# Win32 常量
# --------------------------------------------------------------------------------------
SRCCOPY = 0x00CC0020
CAPTUREBLT = 0x40000000
SRCCOPY_CAPTUREBLT = SRCCOPY | CAPTUREBLT
HALFTONE = 4
COLORONCOLOR = 3
DIB_RGB_COLORS = 0
BI_RGB = 0

PW_RENDERFULLCONTENT = 0x00000002
GWLP_STYLE = -16
GWLP_EXSTYLE = -20
WS_CAPTION = 0x00C00000
WS_POPUP = 0x80000000
WS_VISIBLE = 0x10000000
WS_MINIMIZE = 0x20000000

MONITOR_DEFAULTTOPRIMARY = 1
MONITOR_DEFAULTTONEAREST = 2
MONITORINFOF_PRIMARY = 1
MDT_EFFECTIVE_DPI = 0

DWMWA_EXTENDED_FRAME_BOUNDS = 9
DWMWA_CLOAKED = 14

WDA_NONE = 0x0
WDA_MONITOR = 0x1
WDA_EXCLUDEFROMCAPTURE = 0x11

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

CURSOR_SHOWING = 0x00000001
DI_NORMAL = 0x0003

SM_XVIRTUALSCREEN = 76
SM_YVIRTUALSCREEN = 77
SM_CXVIRTUALSCREEN = 78
SM_CYVIRTUALSCREEN = 79

MAX_COUNT = 120
MAX_SIDE_LIMIT = 7680
MAX_INTERVAL_MS = 60000

# 疑似游戏的简单启发式清单（只做提示，不做结论）
KNOWN_GAME_CLASSES = {
    "unitywndclass",
    "unrealwindow",
    "glfw30",
    "glfw",
    "rimworld",
}
# 明确的非游戏进程：命中就否决“疑似游戏”（避免 Steam/浏览器/办公软件被误判）
KNOWN_NON_GAME_EXES = {
    "steamwebhelper.exe",
    "steam.exe",
    "explorer.exe",
    "dwm.exe",
    "searchhost.exe",
    "notepad.exe",
    "mspaint.exe",
    "msedge.exe",
    "chrome.exe",
    "firefox.exe",
    "qq.exe",
    "wechat.exe",
    "weixin.exe",
    "code.exe",
    "devenv.exe",
    "windowsterminal.exe",
    "powershell.exe",
    "cmd.exe",
    "taskmgr.exe",
    "wt.exe",
}
KNOWN_GAME_EXES = {
    "rimworld.exe",
    "cs2.exe",
    "dota2.exe",
    "eldenring.exe",
    "genshinimpact.exe",
    "starrail.exe",
    "minecraft.exe",
    "terraria.exe",
    "stardew valley.exe",
    "stardewvalley.exe",
}

# --------------------------------------------------------------------------------------
# Win32 结构体
# --------------------------------------------------------------------------------------
LONG = w.LONG
DWORD = w.DWORD
HANDLE = w.HANDLE
HWND = w.HWND
HDC = w.HDC
HBITMAP = getattr(w, "HBITMAP", ctypes.c_void_p)
HGDIOBJ = getattr(w, "HGDIOBJ", ctypes.c_void_p)
HPALETTE = getattr(w, "HPALETTE", ctypes.c_void_p)
HMONITOR = getattr(w, "HMONITOR", ctypes.c_void_p)
LPCWSTR = ctypes.c_wchar_p
BOOL = w.BOOL
UINT = w.UINT


class RECT(ctypes.Structure):
    _fields_ = [("left", LONG), ("top", LONG), ("right", LONG), ("bottom", LONG)]

    def width(self) -> int:
        return self.right - self.left

    def height(self) -> int:
        return self.bottom - self.top

    def as_tuple(self):
        return (self.left, self.top, self.right, self.bottom)

    def as_dict(self):
        return {
            "left": self.left,
            "top": self.top,
            "right": self.right,
            "bottom": self.bottom,
            "width": self.width(),
            "height": self.height(),
        }


class POINT(ctypes.Structure):
    _fields_ = [("x", LONG), ("y", LONG)]


class MONITORINFOEXW(ctypes.Structure):
    _fields_ = [
        ("cbSize", DWORD),
        ("rcMonitor", RECT),
        ("rcWork", RECT),
        ("dwFlags", DWORD),
        ("szDevice", w.WCHAR * 32),
    ]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", DWORD),
        ("biWidth", LONG),
        ("biHeight", LONG),
        ("biPlanes", w.WORD),
        ("biBitCount", w.WORD),
        ("biCompression", DWORD),
        ("biSizeImage", DWORD),
        ("biXPelsPerMeter", LONG),
        ("biYPelsPerMeter", LONG),
        ("biClrUsed", DWORD),
        ("biClrImportant", DWORD),
    ]


class RGBQUAD(ctypes.Structure):
    _fields_ = [
        ("rgbBlue", w.BYTE),
        ("rgbGreen", w.BYTE),
        ("rgbRed", w.BYTE),
        ("rgbReserved", w.BYTE),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", RGBQUAD * 1)]


class CURSORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", DWORD),
        ("flags", DWORD),
        ("hCursor", HANDLE),
        ("ptScreenPos", POINT),
    ]


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", UINT),
        ("dwTime", DWORD),
    ]


class ICONINFO(ctypes.Structure):
    _fields_ = [
        ("fIcon", BOOL),
        ("xHotspot", DWORD),
        ("yHotspot", DWORD),
        ("hbmMask", HBITMAP),
        ("hbmColor", HBITMAP),
    ]


class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", ctypes.c_uint32),
        ("Data2", ctypes.c_uint16),
        ("Data3", ctypes.c_uint16),
        ("Data4", ctypes.c_ubyte * 8),
    ]


CLSID = GUID


class GdiplusStartupInput(ctypes.Structure):
    _fields_ = [
        ("GdiplusVersion", ctypes.c_uint32),
        ("DebugEventCallback", ctypes.c_void_p),
        ("SuppressBackgroundThread", BOOL),
        ("SuppressExternalCodecs", BOOL),
    ]


class EncoderParameter(ctypes.Structure):
    _fields_ = [
        ("ParameterGuid", GUID),
        ("NumberOfValues", ctypes.c_ulong),
        ("Type", ctypes.c_ulong),
        ("Value", ctypes.c_void_p),
    ]


class EncoderParameters(ctypes.Structure):
    _fields_ = [("Count", ctypes.c_uint32), ("Parameter", EncoderParameter * 1)]


# --------------------------------------------------------------------------------------
# DLL 绑定
# --------------------------------------------------------------------------------------
user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
dwmapi = ctypes.WinDLL("dwmapi", use_last_error=True)
gdiplus = ctypes.WinDLL("gdiplus", use_last_error=True)
try:
    shcore = ctypes.WinDLL("shcore", use_last_error=True)
except OSError:  # pragma: no cover - Win7 没有 shcore
    shcore = None

# user32
user32.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
user32.SetProcessDpiAwarenessContext.restype = BOOL
if hasattr(user32, "SetProcessDpiAwareness"):
    user32.SetProcessDpiAwareness.argtypes = [ctypes.c_int]
    user32.SetProcessDpiAwareness.restype = ctypes.c_long
user32.SetProcessDPIAware.argtypes = []
user32.SetProcessDPIAware.restype = BOOL

MonitorEnumProc = ctypes.WINFUNCTYPE(BOOL, HMONITOR, HDC, ctypes.POINTER(RECT), w.LPARAM)
user32.EnumDisplayMonitors.argtypes = [HDC, ctypes.POINTER(RECT), MonitorEnumProc, w.LPARAM]
user32.EnumDisplayMonitors.restype = BOOL
user32.GetMonitorInfoW.argtypes = [HMONITOR, ctypes.POINTER(MONITORINFOEXW)]
user32.GetMonitorInfoW.restype = BOOL
user32.MonitorFromWindow.argtypes = [HWND, DWORD]
user32.MonitorFromWindow.restype = HMONITOR
user32.GetSystemMetrics.argtypes = [ctypes.c_int]
user32.GetSystemMetrics.restype = ctypes.c_int
user32.GetForegroundWindow.argtypes = []
user32.GetForegroundWindow.restype = HWND
user32.GetWindowTextW.argtypes = [HWND, LPCWSTR, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int
user32.GetWindowTextLengthW.argtypes = [HWND]
user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetClassNameW.argtypes = [HWND, LPCWSTR, ctypes.c_int]
user32.GetClassNameW.restype = ctypes.c_int
user32.GetWindowRect.argtypes = [HWND, ctypes.POINTER(RECT)]
user32.GetWindowRect.restype = BOOL
user32.GetClientRect.argtypes = [HWND, ctypes.POINTER(RECT)]
user32.GetClientRect.restype = BOOL
user32.GetWindowThreadProcessId.argtypes = [HWND, ctypes.POINTER(DWORD)]
user32.GetWindowThreadProcessId.restype = DWORD
user32.IsWindowVisible.argtypes = [HWND]
user32.IsWindowVisible.restype = BOOL
user32.IsWindow.argtypes = [HWND]
user32.IsWindow.restype = BOOL
user32.IsIconic.argtypes = [HWND]
user32.IsIconic.restype = BOOL
user32.IsZoomed.argtypes = [HWND]
user32.IsZoomed.restype = BOOL
user32.GetWindowLongPtrW.argtypes = [HWND, ctypes.c_int]
user32.GetWindowLongPtrW.restype = ctypes.c_void_p
user32.GetWindowDisplayAffinity.argtypes = [HWND, ctypes.POINTER(DWORD)]
user32.GetWindowDisplayAffinity.restype = BOOL
user32.GetDC.argtypes = [HWND]
user32.GetDC.restype = HDC
user32.GetWindowDC.argtypes = [HWND]
user32.GetWindowDC.restype = HDC
user32.ReleaseDC.argtypes = [HWND, HDC]
user32.ReleaseDC.restype = ctypes.c_int
user32.PrintWindow.argtypes = [HWND, HDC, UINT]
user32.PrintWindow.restype = BOOL
user32.GetDesktopWindow.argtypes = []
user32.GetDesktopWindow.restype = HWND
user32.GetCursorInfo.argtypes = [ctypes.POINTER(CURSORINFO)]
user32.GetCursorInfo.restype = BOOL
user32.GetIconInfo.argtypes = [HANDLE, ctypes.POINTER(ICONINFO)]
user32.GetIconInfo.restype = BOOL
user32.DrawIconEx.argtypes = [HDC, ctypes.c_int, ctypes.c_int, HANDLE, ctypes.c_int, ctypes.c_int, UINT, HANDLE, UINT]
user32.DrawIconEx.restype = BOOL
user32.GetLastInputInfo.argtypes = [ctypes.POINTER(LASTINPUTINFO)]
user32.GetLastInputInfo.restype = BOOL
EnumWindowsProc = ctypes.WINFUNCTYPE(BOOL, HWND, w.LPARAM)
user32.EnumWindows.argtypes = [EnumWindowsProc, w.LPARAM]
user32.EnumWindows.restype = BOOL
if hasattr(user32, "GetDpiForWindow"):
    user32.GetDpiForWindow.argtypes = [HWND]
    user32.GetDpiForWindow.restype = UINT

# gdi32
gdi32.CreateCompatibleDC.argtypes = [HDC]
gdi32.CreateCompatibleDC.restype = HDC
gdi32.CreateCompatibleBitmap.argtypes = [HDC, ctypes.c_int, ctypes.c_int]
gdi32.CreateCompatibleBitmap.restype = HBITMAP
gdi32.SelectObject.argtypes = [HDC, HGDIOBJ]
gdi32.SelectObject.restype = HGDIOBJ
gdi32.DeleteObject.argtypes = [HGDIOBJ]
gdi32.DeleteObject.restype = BOOL
gdi32.DeleteDC.argtypes = [HDC]
gdi32.DeleteDC.restype = BOOL
gdi32.BitBlt.argtypes = [HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, HDC, ctypes.c_int, ctypes.c_int, DWORD]
gdi32.BitBlt.restype = BOOL
gdi32.StretchBlt.argtypes = [HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, DWORD]
gdi32.StretchBlt.restype = BOOL
gdi32.SetStretchBltMode.argtypes = [HDC, ctypes.c_int]
gdi32.SetStretchBltMode.restype = ctypes.c_int
gdi32.SetBrushOrgEx.argtypes = [HDC, ctypes.c_int, ctypes.c_int, ctypes.POINTER(POINT)]
gdi32.SetBrushOrgEx.restype = BOOL
gdi32.GetDIBits.argtypes = [HDC, HBITMAP, UINT, UINT, ctypes.c_void_p, ctypes.POINTER(BITMAPINFO), UINT]
gdi32.GetDIBits.restype = ctypes.c_int

# dwmapi
dwmapi.DwmGetWindowAttribute.argtypes = [HWND, DWORD, ctypes.c_void_p, DWORD]
dwmapi.DwmGetWindowAttribute.restype = ctypes.c_long
dwmapi.DwmIsCompositionEnabled.argtypes = [ctypes.POINTER(BOOL)]
dwmapi.DwmIsCompositionEnabled.restype = ctypes.c_long

# shcore
if shcore is not None:
    shcore.GetDpiForMonitor.argtypes = [HMONITOR, ctypes.c_int, ctypes.POINTER(UINT), ctypes.POINTER(UINT)]
    shcore.GetDpiForMonitor.restype = ctypes.c_long
    shcore.SetProcessDpiAwareness.argtypes = [ctypes.c_int]
    shcore.SetProcessDpiAwareness.restype = ctypes.c_long

# kernel32
kernel32.OpenProcess.argtypes = [DWORD, BOOL, DWORD]
kernel32.OpenProcess.restype = HANDLE
kernel32.CloseHandle.argtypes = [HANDLE]
kernel32.CloseHandle.restype = BOOL
kernel32.QueryFullProcessImageNameW.argtypes = [HANDLE, DWORD, LPCWSTR, ctypes.POINTER(DWORD)]
kernel32.QueryFullProcessImageNameW.restype = BOOL
kernel32.GetTickCount64.argtypes = []
kernel32.GetTickCount64.restype = ctypes.c_ulonglong

# gdiplus
GdiplusStartupInputPtr = ctypes.POINTER(GdiplusStartupInput)
gdiplus.GdiplusStartup.argtypes = [ctypes.POINTER(ctypes.c_size_t), GdiplusStartupInputPtr, ctypes.c_void_p]
gdiplus.GdiplusStartup.restype = ctypes.c_int
gdiplus.GdiplusShutdown.argtypes = [ctypes.c_size_t]
gdiplus.GdiplusShutdown.restype = None
gdiplus.GdipCreateBitmapFromHBITMAP.argtypes = [HBITMAP, HPALETTE, ctypes.POINTER(ctypes.c_void_p)]
gdiplus.GdipCreateBitmapFromHBITMAP.restype = ctypes.c_int
gdiplus.GdipDisposeImage.argtypes = [ctypes.c_void_p]
gdiplus.GdipDisposeImage.restype = ctypes.c_int
gdiplus.GdipSaveImageToFile.argtypes = [ctypes.c_void_p, LPCWSTR, ctypes.POINTER(CLSID), ctypes.POINTER(EncoderParameters)]
gdiplus.GdipSaveImageToFile.restype = ctypes.c_int

GUID_QUALITY = GUID(
    0x1D5BE4B5,
    0xFA4A,
    0x452D,
    (ctypes.c_ubyte * 8)(0x9C, 0xDD, 0x5D, 0xB3, 0x51, 0x05, 0xE7, 0xEB),
)
CLSID_JPEG_FALLBACK = CLSID(
    0x557CF401,
    0x1A04,
    0x11D3,
    (ctypes.c_ubyte * 8)(0x9A, 0x73, 0x00, 0x00, 0xF8, 0x1E, 0xF3, 0x2E),
)
ENCODER_PARAMETER_VALUE_TYPE_LONG = 4

# --------------------------------------------------------------------------------------
# 全局状态
# --------------------------------------------------------------------------------------
_CAPTURE_LOCK = threading.Lock()
_DPI_STATE = {"done": False, "mode": "unknown"}
_GDIP_STATE = {"token": ctypes.c_size_t(0), "started": False, "jpeg_clsid": None}
_GDIP_LOCK = threading.Lock()


class CaptureError(Exception):
    """带机器可读 code 的捕获错误。"""

    def __init__(self, code: str, message: str, detail=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


# --------------------------------------------------------------------------------------
# 基础工具
# --------------------------------------------------------------------------------------
def _iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()) + f".{int(time.time() * 1000) % 1000:03d}+08:00"


def _rect_dict(r: RECT) -> dict:
    return r.as_dict()


def _scale_rect(rect: dict, factor: float) -> dict:
    if factor <= 0 or math.isclose(factor, 1.0):
        return rect
    return {
        "left": int(round(rect["left"] * factor)),
        "top": int(round(rect["top"] * factor)),
        "right": int(round(rect["right"] * factor)),
        "bottom": int(round(rect["bottom"] * factor)),
        "width": int(round(rect["width"] * factor)),
        "height": int(round(rect["height"] * factor)),
    }


# --------------------------------------------------------------------------------------
# DPI / 显示器
# --------------------------------------------------------------------------------------
def init_dpi_awareness() -> str:
    """设置进程 DPI 感知（越高越好）。必须在读取任何坐标之前调用。"""
    if _DPI_STATE["done"]:
        return _DPI_STATE["mode"]
    mode = "unknown"
    # 1) Per-Monitor V2  (Win10 1703+)
    try:
        if user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
            mode = "per_monitor_v2"
    except (AttributeError, OSError):
        pass
    # 2) Per-Monitor (Win8.1+)
    if mode == "unknown" and shcore is not None:
        try:
            rc = shcore.SetProcessDpiAwareness(2)
            if rc in (0, -2147024891):  # 0=OK, 0x80070005=已经设置过
                mode = "per_monitor"
        except (AttributeError, OSError, ctypes.ArgumentError):
            pass
    # 3) System DPI aware
    if mode == "unknown":
        try:
            if user32.SetProcessDPIAware():
                mode = "system"
        except (AttributeError, OSError):
            pass
    if mode == "unknown":
        mode = "unaware"
    _DPI_STATE["done"] = True
    _DPI_STATE["mode"] = mode
    return mode


def _monitor_dpi(handle) -> tuple:
    dx = UINT(0)
    dy = UINT(0)
    if shcore is not None:
        try:
            if shcore.GetDpiForMonitor(handle, MDT_EFFECTIVE_DPI, ctypes.byref(dx), ctypes.byref(dy)) == 0:
                return (int(dx.value), int(dy.value))
        except (OSError, ctypes.ArgumentError):
            pass
    return (96, 96)


def get_monitors() -> list:
    """枚举显示器（物理像素坐标，虚拟桌面坐标系）。"""
    monitors = []

    def _cb(hmon, hdc, lprc, lparam):
        mi = MONITORINFOEXW()
        mi.cbSize = ctypes.sizeof(MONITORINFOEXW)
        if user32.GetMonitorInfoW(hmon, ctypes.byref(mi)):
            dpi_x, dpi_y = _monitor_dpi(hmon)
            monitors.append(
                {
                    "handle": int(hmon or 0),
                    "device": mi.szDevice,
                    "primary": bool(mi.dwFlags & MONITORINFOF_PRIMARY),
                    "rect": mi.rcMonitor.as_dict(),
                    "work_rect": mi.rcWork.as_dict(),
                    "dpi": {"x": dpi_x, "y": dpi_y},
                    "scale": {"x": round(dpi_x / 96.0, 4), "y": round(dpi_y / 96.0, 4)},
                }
            )
        return True

    try:
        user32.EnumDisplayMonitors(None, None, MonitorEnumProc(_cb), 0)
    except (OSError, ctypes.ArgumentError):
        pass
    for idx, m in enumerate(monitors):
        m["index"] = idx
        m["label"] = f"#{idx} {m['device']} {'(primary)' if m['primary'] else ''}".strip()
        m.pop("handle", None)
    return monitors


def get_virtual_screen() -> dict:
    x = user32.GetSystemMetrics(SM_XVIRTUALSCREEN)
    y = user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
    cx = user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)
    cy = user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)
    return {
        "left": x,
        "top": y,
        "right": x + cx,
        "bottom": y + cy,
        "width": cx,
        "height": cy,
    }


def get_dwm_composition() -> bool:
    enabled = BOOL(0)
    try:
        if dwmapi.DwmIsCompositionEnabled(ctypes.byref(enabled)) == 0:
            return bool(enabled.value)
    except (OSError, ctypes.ArgumentError):
        pass
    return False


def get_idle_seconds() -> float | None:
    """系统键鼠空闲秒数（GetLastInputInfo；全系统级，不区分窗口）。失败返回 None。"""
    lii = LASTINPUTINFO()
    lii.cbSize = ctypes.sizeof(LASTINPUTINFO)
    try:
        if not user32.GetLastInputInfo(ctypes.byref(lii)):
            return None
        now_lo = int(kernel32.GetTickCount64()) & 0xFFFFFFFF
        delta_ms = (now_lo - int(lii.dwTime)) & 0xFFFFFFFF
        # 49.7 天回绕时按 0 处理（几乎不可能遇到，防御一下）
        if delta_ms > 0x7FFFFFFF:
            delta_ms = 0
        return round(delta_ms / 1000.0, 2)
    except (OSError, ctypes.ArgumentError, TypeError):
        return None


def resolve_monitor(spec) -> dict | None:
    """spec: 'primary' / 'all' / 'virtual' / 数字索引。返回显示器 dict；all/virtual 返回 None 表示用虚拟桌面。"""
    monitors = get_monitors()
    if not monitors:
        raise CaptureError("no_monitor", "EnumDisplayMonitors 没有返回任何显示器")
    if spec is None:
        spec = "primary"
    s = str(spec).strip().lower()
    if s in ("primary", "0", ""):
        for m in monitors:
            if m["primary"]:
                return m
        return monitors[0]
    if s in ("all", "virtual", "desktop", "-1"):
        return None
    try:
        idx = int(s)
    except ValueError:
        raise CaptureError("bad_monitor", f"无法识别的显示器选择: {spec!r}（可用 primary/all/索引）")
    if idx < 0 or idx >= len(monitors):
        raise CaptureError(
            "bad_monitor",
            f"显示器索引 {idx} 越界（本机共 {len(monitors)} 台: 0..{len(monitors) - 1}）",
        )
    return monitors[idx]


# --------------------------------------------------------------------------------------
# 窗口信息
# --------------------------------------------------------------------------------------
def _get_process_exe(pid: int) -> tuple:
    """返回 (exe 文件名, 完整路径)；失败返回 ('', '')。"""
    if not pid:
        return ("", "")
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return ("", "")
    try:
        buf = ctypes.create_unicode_buffer(2048)
        size = DWORD(2048)
        if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            full = buf.value
            return os.path.basename(full), full
        return ("", "")
    finally:
        kernel32.CloseHandle(h)


def _get_window_text(hwnd) -> str:
    length = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(max(length + 2, 2))
    user32.GetWindowTextW(hwnd, buf, len(buf))
    return buf.value


def _get_class_name(hwnd) -> str:
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def _dwm_frame_rect(hwnd) -> RECT | None:
    """DWM 可见边框（Win10 起不含透明拖拽边框，比 GetWindowRect 准）。"""
    rect = RECT()
    try:
        status = dwmapi.DwmGetWindowAttribute(
            hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, ctypes.byref(rect), ctypes.sizeof(rect)
        )
        if status == 0 and rect.width() > 0 and rect.height() > 0:
            return rect
    except (OSError, ctypes.ArgumentError):
        pass
    return None


def _dwm_cloaked(hwnd) -> bool:
    val = DWORD(0)
    try:
        if dwmapi.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, ctypes.byref(val), ctypes.sizeof(val)) == 0:
            return bool(val.value)
    except (OSError, ctypes.ArgumentError):
        pass
    return False


def _window_display_affinity(hwnd) -> int:
    val = DWORD(0)
    try:
        if user32.GetWindowDisplayAffinity(hwnd, ctypes.byref(val)):
            return int(val.value)
    except (OSError, ctypes.ArgumentError):
        pass
    return 0


def _monitor_index_for_rect(monitors: list, rect: dict) -> int | None:
    cx = rect["left"] + rect["width"] // 2
    cy = rect["top"] + rect["height"] // 2
    for m in monitors:
        r = m["rect"]
        if r["left"] <= cx < r["right"] and r["top"] <= cy < r["bottom"]:
            return m["index"]
    return None


def _overlap_ratio_of(rect: dict, target: dict) -> float:
    """rect 覆盖 target 的面积比例（0..1）。"""
    ix1 = max(rect["left"], target["left"])
    iy1 = max(rect["top"], target["top"])
    ix2 = min(rect["right"], target["right"])
    iy2 = min(rect["bottom"], target["bottom"])
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    area = max(1, target["width"] * target["height"])
    return inter / area


def _guess_game(win: dict) -> dict:
    """简单启发式：返回 {suspected, score, reasons}。"""
    score = 0
    reasons = []
    exe = (win.get("exe") or "").lower()
    exe_path = (win.get("exe_path") or "").lower()
    cls = (win.get("class_name") or "").lower()
    if exe in KNOWN_NON_GAME_EXES:
        reasons.append(f"exe 在明确非游戏名单: {exe}，否决")
        return {"suspected": False, "score": 0, "reasons": reasons}
    if exe_path and ("\\steamapps\\common\\" in exe_path or "\\steam\\steamapps\\" in exe_path):
        score += 3
        reasons.append("exe 位于 Steam steamapps\\common 目录")
    if exe in KNOWN_GAME_EXES:
        score += 2
        reasons.append(f"exe 命中已知游戏名单: {exe}")
    if cls in KNOWN_GAME_CLASSES:
        score += 2
        reasons.append(f"窗口类名像游戏引擎: {cls}")
    if win.get("fullscreen"):
        score += 2
        reasons.append("窗口覆盖整块显示器（全屏/无边框）")
    elif win.get("maximized"):
        score += 1
        reasons.append("窗口已最大化")
    if win.get("borderless") and win.get("fullscreen"):
        score += 1
        reasons.append("无标题栏且铺满屏幕")
    if "\\steam\\" in exe_path:
        score += 1
        reasons.append("exe 位于 Steam 安装目录")
    suspected = score >= 3
    return {"suspected": bool(suspected), "score": score, "reasons": reasons}


def get_window_info(hwnd, foreground_hwnd=None) -> dict | None:
    """采集单个窗口的元信息。"""
    if not hwnd or not user32.IsWindow(hwnd):
        return None
    try:
        hwnd_int = int(hwnd)
    except (TypeError, ValueError):
        return None
    monitors = get_monitors()
    title = _get_window_text(hwnd)
    class_name = _get_class_name(hwnd)
    pid = DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    exe, exe_path = _get_process_exe(int(pid.value))

    legacy = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(legacy))
    frame = _dwm_frame_rect(hwnd) or legacy
    client = RECT()
    user32.GetClientRect(hwnd, ctypes.byref(client))

    style = 0
    exstyle = 0
    try:
        s = user32.GetWindowLongPtrW(hwnd, GWLP_STYLE)
        style = int(s) if s else 0
        e = user32.GetWindowLongPtrW(hwnd, GWLP_EXSTYLE)
        exstyle = int(e) if e else 0
    except (OSError, ctypes.ArgumentError, TypeError):
        pass

    visible = bool(user32.IsWindowVisible(hwnd))
    minimized = bool(user32.IsIconic(hwnd))
    maximized = bool(user32.IsZoomed(hwnd))
    cloaked = _dwm_cloaked(hwnd)
    affinity = _window_display_affinity(hwnd)

    mon_handle = user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
    mon_idx = None
    mon_info = None
    # 用窗口可见边框的中心点匹配枚举出的显示器
    frame_dict = frame.as_dict()
    mon_idx = _monitor_index_for_rect(monitors, frame_dict)
    if mon_idx is not None:
        mon_info = monitors[mon_idx]
    # DPI（优先 GetDpiForWindow）
    dpi_x, dpi_y = (96, 96)
    if hasattr(user32, "GetDpiForWindow"):
        try:
            dval = int(user32.GetDpiForWindow(hwnd))
            if dval > 0:
                dpi_x = dpi_y = dval
        except (OSError, ctypes.ArgumentError):
            pass
    if (dpi_x, dpi_y) == (96, 96) and mon_info is not None:
        dpi_x, dpi_y = mon_info["dpi"]["x"], mon_info["dpi"]["y"]

    covers_monitor = False
    if mon_info is not None:
        covers_monitor = _overlap_ratio_of(frame_dict, mon_info["rect"]) >= 0.97
    screen = get_virtual_screen()
    fullscreen = bool(covers_monitor and visible and not minimized)
    borderless = bool(fullscreen and not (style & WS_CAPTION))
    has_caption = bool(style & WS_CAPTION)
    is_foreground = foreground_hwnd is not None and hwnd == foreground_hwnd

    info = {
        "hwnd": hwnd_int,
        "hex": f"0x{hwnd_int:X}",
        "title": title,
        "class_name": class_name,
        "pid": int(pid.value),
        "exe": exe,
        "exe_path": exe_path,
        "rect": legacy.as_dict(),  # GetWindowRect（含不可见边框）
        "frame_rect": frame_dict,  # DWM 可见边框; 截图用的就是它
        "client_rect": client.as_dict(),
        "visible": visible,
        "minimized": minimized,
        "maximized": maximized,
        "has_caption": has_caption,
        "style": f"0x{style:08X}",
        "exstyle": f"0x{exstyle:08X}",
        "dwm_cloaked": cloaked,
        "display_affinity": affinity,
        "display_affinity_name": {0: "none", 1: "monitor", 0x11: "exclude_from_capture"}.get(affinity, f"0x{affinity:X}"),
        "fullscreen": fullscreen,
        "borderless": borderless,
        "covers_monitor": covers_monitor,
        "is_foreground": is_foreground,
        "monitor_index": mon_idx,
        "monitor_device": mon_info["device"] if mon_info else None,
        "monitor_rect": mon_info["rect"] if mon_info else None,
        "dpi": {"x": dpi_x, "y": dpi_y},
        "scale": round(dpi_x / 96.0, 4),
        "idle_sec": get_idle_seconds(),
        "virtual_screen": screen,
        "capture_rect": frame_dict,
    }
    if mon_info:
        info["monitor_rect"] = mon_info["rect"]
    info["game_guess"] = _guess_game(info)
    return info


def get_foreground_window() -> int:
    try:
        return int(user32.GetForegroundWindow() or 0)
    except (OSError, TypeError):
        return 0


def find_window_by_exe(pattern: str) -> int:
    """按 exe 名/路径子串找最适合截图的可见顶层窗口。

    优先级：当前前台匹配窗口 > 面积最大的可见未最小化窗口（标题非空优先）。
    """
    if not pattern:
        raise CaptureError("bad_exe", "exe 匹配串为空")
    pat = pattern.strip().lower()
    fg = get_foreground_window()
    found = []

    def _cb(hwnd, lparam):
        try:
            if not user32.IsWindowVisible(hwnd):
                return True
            pid = DWORD(0)
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            exe, exe_path = _get_process_exe(int(pid.value))
            if not exe and not exe_path:
                return True
            hay = f"{exe} {exe_path}".lower()
            if pat not in hay:
                return True
            r = RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(r))
            if r.width() <= 0 or r.height() <= 0:
                return True
            title = _get_window_text(hwnd)
            found.append(
                {
                    "hwnd": int(hwnd),
                    "title": title,
                    "exe": exe,
                    "area": r.width() * r.height(),
                    "minimized": bool(user32.IsIconic(hwnd)),
                }
            )
        except (OSError, ctypes.ArgumentError):
            pass
        return True

    user32.EnumWindows(EnumWindowsProc(_cb), 0)
    if not found:
        return 0
    for f in found:
        if f["hwnd"] == fg:
            return f["hwnd"]
    candidates = [f for f in found if not f["minimized"]]
    if not candidates:
        candidates = found
    candidates.sort(key=lambda f: (bool(f["title"]), f["area"]), reverse=True)
    return candidates[0]["hwnd"]


# --------------------------------------------------------------------------------------
# GDI 截图原语
# --------------------------------------------------------------------------------------
class Grab:
    """一次原始抓取（内存位图 + DC）。用完必须 close()。"""

    __slots__ = ("mem_dc", "bmp", "old", "width", "height", "src_rect", "method", "attempt", "_close_extra")

    def __init__(self, mem_dc, bmp, old, width, height, src_rect, method):
        self.mem_dc = mem_dc
        self.bmp = bmp
        self.old = old
        self.width = width
        self.height = height
        self.src_rect = src_rect
        self.method = method
        self.attempt = {}
        self._close_extra = None

    def close(self):
        try:
            if self.mem_dc:
                if self.old:
                    gdi32.SelectObject(self.mem_dc, self.old)
                gdi32.DeleteDC(self.mem_dc)
                self.mem_dc = None
            if self.bmp:
                gdi32.DeleteObject(self.bmp)
                self.bmp = None
        finally:
            if self._close_extra is not None:
                try:
                    self._close_extra()
                except (OSError, ctypes.ArgumentError):
                    pass
                self._close_extra = None


def _make_mem_dc_bitmap(src_dc, width: int, height: int):
    mem_dc = gdi32.CreateCompatibleDC(src_dc)
    if not mem_dc:
        raise CaptureError("gdi_create_dc_failed", "CreateCompatibleDC 失败")
    bmp = gdi32.CreateCompatibleBitmap(src_dc, width, height)
    if not bmp:
        gdi32.DeleteDC(mem_dc)
        raise CaptureError("gdi_create_bitmap_failed", f"CreateCompatibleBitmap({width}x{height}) 失败")
    old = gdi32.SelectObject(mem_dc, bmp)
    return mem_dc, bmp, old


def grab_screen(rect: dict, use_captureblt: bool = True, method: str = "bitblt") -> Grab:
    """从桌面 DC 抓取虚拟桌面坐标系中的矩形区域（可含负坐标）。"""
    width, height = rect["width"], rect["height"]
    if width <= 0 or height <= 0:
        raise CaptureError("bad_rect", f"截图区域尺寸非法: {width}x{height}")
    screen_dc = user32.GetDC(None)
    if not screen_dc:
        raise CaptureError("gdi_no_screen_dc", "GetDC(NULL) 失败")
    try:
        mem_dc, bmp, old = _make_mem_dc_bitmap(screen_dc, width, height)
    except CaptureError:
        user32.ReleaseDC(None, screen_dc)
        raise
    flags = SRCCOPY_CAPTUREBLT if use_captureblt else SRCCOPY
    ok = gdi32.BitBlt(mem_dc, 0, 0, width, height, screen_dc, rect["left"], rect["top"], flags)
    if not ok:
        err = ctypes.get_last_error()
        gdi32.SelectObject(mem_dc, old)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(mem_dc)
        user32.ReleaseDC(None, screen_dc)
        raise CaptureError("bitblt_failed", f"BitBlt 失败 (GetLastError={err})")
    grab = Grab(mem_dc, bmp, old, width, height, dict(rect), method)
    grab._close_extra = lambda: user32.ReleaseDC(None, screen_dc)
    return grab


def grab_printwindow(hwnd, width: int, height: int, src_rect: dict | None = None, crop: dict | None = None) -> Grab:
    """PrintWindow 抓窗口内容（PW_RENDERFULLCONTENT），可再裁剪 crop（窗口局部坐标）。

    src_rect：报告用的“目标是哪块屏幕区域”（窗口在虚拟桌面上的位置）。
    crop：相对 PrintWindow 位图左上角的裁剪矩形（dict left/top/width/height）。
    """
    if width <= 0 or height <= 0:
        raise CaptureError("bad_rect", f"PrintWindow 尺寸非法: {width}x{height}")
    win_dc = user32.GetWindowDC(hwnd)
    if not win_dc:
        win_dc = user32.GetDC(hwnd)
        release = lambda: user32.ReleaseDC(hwnd, win_dc)
    else:
        release = lambda: user32.ReleaseDC(hwnd, win_dc)
    try:
        mem_dc, bmp, old = _make_mem_dc_bitmap(win_dc, width, height)
    except CaptureError:
        release()
        raise
    ok = user32.PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT)
    if not ok:
        gdi32.SelectObject(mem_dc, old)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(mem_dc)
        release()
        raise CaptureError("printwindow_failed", "PrintWindow(PW_RENDERFULLCONTENT) 返回失败")
    if crop and (crop["width"] != width or crop["height"] != height or crop["left"] or crop["top"]):
        crop_w, crop_h = crop["width"], crop["height"]
        if crop_w <= 0 or crop_h <= 0:
            gdi32.SelectObject(mem_dc, old)
            gdi32.DeleteObject(bmp)
            gdi32.DeleteDC(mem_dc)
            release()
            raise CaptureError("bad_crop", f"裁剪尺寸非法: {crop_w}x{crop_h}")
        crop_dc, crop_bmp, crop_old = _make_mem_dc_bitmap(mem_dc, crop_w, crop_h)
        ok2 = gdi32.BitBlt(
            crop_dc, 0, 0, crop_w, crop_h, mem_dc, crop["left"], crop["top"], SRCCOPY
        )
        gdi32.SelectObject(mem_dc, old)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(mem_dc)
        if not ok2:
            gdi32.SelectObject(crop_dc, crop_old)
            gdi32.DeleteObject(crop_bmp)
            gdi32.DeleteDC(crop_dc)
            release()
            raise CaptureError("bitblt_failed", "PrintWindow 后裁剪 BitBlt 失败")
        mem_dc, bmp, old, width, height = crop_dc, crop_bmp, crop_old, crop_w, crop_h
    grab = Grab(mem_dc, bmp, old, width, height, dict(src_rect or {"left": 0, "top": 0, "width": width, "height": height}), "printwindow")
    grab._close_extra = release
    return grab


def scale_grab(grab: Grab, max_side: int = 0, scale: float = 0.0) -> Grab:
    """按长边上限或倍率缩放抓取结果（HALFTONE 重采样），返回新 Grab，原 Grab 会被释放。"""
    factor = 1.0
    long_side = max(grab.width, grab.height)
    if scale and scale > 0:
        factor = float(scale)
    elif max_side and max_side > 0 and long_side > max_side:
        factor = max_side / float(long_side)
    if math.isclose(factor, 1.0):
        return grab
    factor = max(0.01, min(8.0, factor))
    tw = max(1, int(round(grab.width * factor)))
    th = max(1, int(round(grab.height * factor)))
    if tw == grab.width and th == grab.height:
        return grab
    try:
        mem_dc, bmp, old = _make_mem_dc_bitmap(grab.mem_dc, tw, th)
    except CaptureError:
        grab.close()
        raise
    gdi32.SetStretchBltMode(mem_dc, HALFTONE)
    gdi32.SetBrushOrgEx(mem_dc, 0, 0, None)
    ok = gdi32.StretchBlt(mem_dc, 0, 0, tw, th, grab.mem_dc, 0, 0, grab.width, grab.height, SRCCOPY)
    if not ok:
        err = ctypes.get_last_error()
        gdi32.SelectObject(mem_dc, old)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(mem_dc)
        grab.close()
        raise CaptureError("stretchblt_failed", f"StretchBlt 缩放失败 (GetLastError={err})")
    new_grab = Grab(mem_dc, bmp, old, tw, th, dict(grab.src_rect), grab.method + "+scale")
    new_grab.attempt = dict(grab.attempt)
    new_grab.attempt["scale_factor"] = round(factor, 4)
    grab.close()
    return new_grab


def draw_cursor(grab: Grab, src_rect: dict) -> bool:
    """把鼠标指针画到抓取结果上（截图默认不含指针）。成功返回 True。"""
    ci = CURSORINFO()
    ci.cbSize = ctypes.sizeof(CURSORINFO)
    if not user32.GetCursorInfo(ctypes.byref(ci)):
        return False
    if not (ci.flags & CURSOR_SHOWING) or not ci.hCursor:
        return False
    hot_x = hot_y = 0
    icon = ICONINFO()
    if user32.GetIconInfo(ci.hCursor, ctypes.byref(icon)):
        hot_x = int(icon.xHotspot)
        hot_y = int(icon.yHotspot)
        if icon.hbmMask:
            gdi32.DeleteObject(icon.hbmMask)
        if icon.hbmColor:
            gdi32.DeleteObject(icon.hbmColor)
    x = int(ci.ptScreenPos.x) - src_rect["left"] - hot_x
    y = int(ci.ptScreenPos.y) - src_rect["top"] - hot_y
    return bool(user32.DrawIconEx(grab.mem_dc, x, y, ci.hCursor, 0, 0, 0, None, DI_NORMAL))


def _pixel_stats(grab: Grab, sample_w: int = 128, sample_h: int = 80) -> dict:
    """把画面缩到小缩略图后统计亮度分布（黑帧检测）。"""
    sample_w = max(8, min(sample_w, grab.width))
    sample_h = max(8, min(sample_h, grab.height))
    thumb_dc = gdi32.CreateCompatibleDC(grab.mem_dc)
    if not thumb_dc:
        raise CaptureError("gdi_create_dc_failed", "缩略图 CreateCompatibleDC 失败")
    thumb_bmp = gdi32.CreateCompatibleBitmap(grab.mem_dc, sample_w, sample_h)
    if not thumb_bmp:
        gdi32.DeleteDC(thumb_dc)
        raise CaptureError("gdi_create_bitmap_failed", "缩略图 CreateCompatibleBitmap 失败")
    thumb_old = gdi32.SelectObject(thumb_dc, thumb_bmp)
    stats = None
    try:
        gdi32.SetStretchBltMode(thumb_dc, COLORONCOLOR)
        ok = gdi32.StretchBlt(
            thumb_dc, 0, 0, sample_w, sample_h, grab.mem_dc, 0, 0, grab.width, grab.height, SRCCOPY
        )
        if not ok:
            raise CaptureError("stretchblt_failed", "缩略图 StretchBlt 失败")
        gdi32.SelectObject(thumb_dc, thumb_old)
        n_px = sample_w * sample_h
        bmi = BITMAPINFO()
        bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bmi.bmiHeader.biWidth = sample_w
        bmi.bmiHeader.biHeight = -sample_h  # top-down
        bmi.bmiHeader.biPlanes = 1
        bmi.bmiHeader.biBitCount = 32
        bmi.bmiHeader.biCompression = BI_RGB
        buf = ctypes.create_string_buffer(n_px * 4)
        got = gdi32.GetDIBits(thumb_dc, thumb_bmp, 0, sample_h, buf, ctypes.byref(bmi), DIB_RGB_COLORS)
        if got != sample_h:
            raise CaptureError("getdibits_failed", f"GetDIBits 返回行数异常: {got}/{sample_h}")
        mv = memoryview(bytes(buf)).cast("I")
        total = 0
        total_sq = 0
        dark = 0
        cnt = 0
        min_lum = 255
        max_lum = 0
        for i in range(n_px):
            p = mv[i]
            lum = ((p & 0xFF) * 29 + ((p >> 8) & 0xFF) * 150 + ((p >> 16) & 0xFF) * 77) >> 8
            total += lum
            total_sq += lum * lum
            if lum < 8:
                dark += 1
            if lum < min_lum:
                min_lum = lum
            if lum > max_lum:
                max_lum = lum
            cnt += 1
        mean = total / cnt
        var = total_sq / cnt - mean * mean
        std = math.sqrt(max(0.0, var))
        is_black = bool(mean < 8.0 and std < 4.0)
        stats = {
            "mean": round(mean, 2),
            "std": round(std, 2),
            "dark_ratio": round(dark / cnt, 4),
            "min": int(min_lum),
            "max": int(max_lum),
            "samples": f"{sample_w}x{sample_h}",
            "is_black": is_black,
        }
        return stats
    finally:
        if stats is None:
            gdi32.SelectObject(thumb_dc, thumb_old)
        gdi32.DeleteObject(thumb_bmp)
        gdi32.DeleteDC(thumb_dc)


# --------------------------------------------------------------------------------------
# GDI+ JPEG 编码
# --------------------------------------------------------------------------------------
def _gdiplus_startup():
    with _GDIP_LOCK:
        if _GDIP_STATE["started"]:
            return
        token = ctypes.c_size_t(0)
        startup_input = GdiplusStartupInput()
        startup_input.GdiplusVersion = 1
        startup_input.DebugEventCallback = None
        startup_input.SuppressBackgroundThread = False
        startup_input.SuppressExternalCodecs = False
        status = gdiplus.GdiplusStartup(ctypes.byref(token), ctypes.byref(startup_input), None)
        if status != 0:
            raise CaptureError("gdiplus_startup_failed", f"GdiplusStartup 失败 status={status}")
        _GDIP_STATE["token"] = token
        _GDIP_STATE["started"] = True


def _jpeg_encoder_clsid() -> CLSID:
    """JPEG 编码器 CLSID。

    GDI+ 的 JPEG 编码器 CLSID 是固定的 {557CF401-1A04-11D3-9A73-0000F81EF32E}。
    不去枚举 ImageCodecInfo：该结构在 x64 上的实际 stride（104 字节）与公开头文件
    不符，按头文件布局解析会读到非法指针并让进程崩溃（本机实测），所以直接用固定 CLSID。
    """
    if _GDIP_STATE["jpeg_clsid"] is None:
        _GDIP_STATE["jpeg_clsid"] = CLSID_JPEG_FALLBACK
    return _GDIP_STATE["jpeg_clsid"]


def encode_jpeg(hbmp, out_path: str, quality: int) -> int:
    """用 GDI+ 把 HBITMAP 编码为 JPEG 文件，返回文件字节数。"""
    _gdiplus_startup()
    bitmap = ctypes.c_void_p()
    status = gdiplus.GdipCreateBitmapFromHBITMAP(hbmp, None, ctypes.byref(bitmap))
    if status != 0 or not bitmap:
        raise CaptureError("gdiplus_bitmap_failed", f"GdipCreateBitmapFromHBITMAP 失败 status={status}")
    try:
        q = ctypes.c_ulong(max(1, min(100, int(quality))))
        params = EncoderParameters()
        params.Count = 1
        params.Parameter[0].ParameterGuid = GUID_QUALITY
        params.Parameter[0].NumberOfValues = 1
        params.Parameter[0].Type = ENCODER_PARAMETER_VALUE_TYPE_LONG
        params.Parameter[0].Value = ctypes.cast(ctypes.byref(q), ctypes.c_void_p)
        clsid = _jpeg_encoder_clsid()
        status = gdiplus.GdipSaveImageToFile(bitmap, str(out_path), ctypes.byref(clsid), ctypes.byref(params))
        if status != 0:
            raise CaptureError("jpeg_encode_failed", f"GdipSaveImageToFile 失败 status={status}")
    finally:
        gdiplus.GdipDisposeImage(bitmap)
    try:
        return os.path.getsize(out_path)
    except OSError:
        return 0


# --------------------------------------------------------------------------------------
# 环境信息
# --------------------------------------------------------------------------------------
def environment_info() -> dict:
    init_dpi_awareness()
    monitors = get_monitors()
    os_ver = platform.platform()
    try:
        wv = sys.getwindowsversion()
        os_ver = f"Windows {wv.major}.{wv.minor} build {wv.build} ({platform.platform()})"
    except Exception:
        pass
    return {
        "os": os_ver,
        "python": sys.version.split()[0],
        "python_executable": sys.executable,
        "process_arch": platform.machine(),
        "dpi_awareness": _DPI_STATE["mode"],
        "virtual_screen": get_virtual_screen(),
        "monitors": monitors,
        "monitor_count": len(monitors),
        "dwm_composition": get_dwm_composition(),
        "gdiplus": "gdiplus.dll",
        "capture_service": {"name": "dsh-capture", "version": __version__, "schema": SCHEMA},
    }


# --------------------------------------------------------------------------------------
# 捕获编排
# --------------------------------------------------------------------------------------
DEFAULT_OPTIONS = {
    "mode": "desktop",  # desktop | window | foreground
    "monitor": "primary",  # primary | all | 数字索引
    "hwnd": None,
    "exe": None,
    "count": 1,
    "interval_ms": 300,
    "max_side": 1600,
    "scale": 0.0,
    "quality": 82,
    "outdir": None,
    "prefix": "cap",
    "base64": False,
    "save": True,
    "black_check": True,
    "method": "auto",  # auto | bitblt | printwindow
    "draw_cursor": False,
    "log_jsonl": None,
}

_METHOD_CANDIDATES = {
    "monitor": ["bitblt", "bitblt_nocaptureblt", "printwindow_desktop"],
    "window": ["bitblt", "printwindow"],
}

# 兼容常见的 camelCase 参数名（插件/HTTP 侧习惯），统一映射到内部 snake_case
KEY_ALIASES = {
    "intervalMs": "interval_ms",
    "interval": "interval_ms",
    "maxLongEdge": "max_side",
    "maxSide": "max_side",
    "outDir": "outdir",
    "drawCursor": "draw_cursor",
    "blackCheck": "black_check",
    "windowExe": "exe",
    "monitorIndex": "monitor",
    "infoOnly": "info_only",
}


def _normalize_options(raw: dict | None, base: dict | None = None) -> dict:
    opts = dict(DEFAULT_OPTIONS)
    if base:
        opts.update(base)
    if raw:
        for k, v in raw.items():
            if v is None:
                continue
            raw_key = str(k)
            key = KEY_ALIASES.get(raw_key, raw_key).replace("-", "_")
            if key in opts:
                opts[key] = v
    # 类型/范围校正
    def _as_int(key, cast=int):
        try:
            opts[key] = cast(opts[key])
        except (TypeError, ValueError):
            raise CaptureError("bad_request", f"参数 {key}={opts[key]!r} 不是合法整数")
        return opts[key]

    mode = str(opts["mode"]).strip().lower()
    if mode not in ("desktop", "monitor", "window", "foreground", "screen"):
        raise CaptureError("bad_request", f"不支持的 mode: {opts['mode']!r}（desktop/window/foreground）")
    opts["mode"] = {"monitor": "desktop", "screen": "desktop"}.get(mode, mode)
    if opts["mode"] == "foreground":
        opts["mode"] = "window"
        opts["hwnd"] = None
        opts["exe"] = None

    count = _as_int("count")
    if count < 1:
        raise CaptureError("bad_request", "count 至少为 1")
    opts["count"] = min(count, MAX_COUNT)
    interval = _as_int("interval_ms")
    if interval < 0:
        raise CaptureError("bad_request", "interval_ms 不能为负")
    opts["interval_ms"] = min(interval, MAX_INTERVAL_MS)
    max_side = _as_int("max_side")
    if max_side < 0:
        raise CaptureError("bad_request", "max_side 不能为负")
    opts["max_side"] = min(max_side, MAX_SIDE_LIMIT)
    try:
        opts["scale"] = float(opts["scale"] or 0)
    except (TypeError, ValueError):
        raise CaptureError("bad_request", f"scale={opts['scale']!r} 非法")
    quality = _as_int("quality")
    opts["quality"] = max(1, min(100, quality))
    if opts["outdir"]:
        opts["outdir"] = str(opts["outdir"])
    for key in ("base64", "save", "black_check", "draw_cursor"):
        opts[key] = bool(opts[key])
    method = str(opts["method"] or "auto").strip().lower()
    if method in ("screen", "gdi"):
        method = "bitblt"
    if method not in ("auto", "bitblt", "bitblt_nocaptureblt", "printwindow", "printwindow_desktop"):
        raise CaptureError("bad_request", f"不支持的 method: {opts['method']!r}")
    opts["method"] = method
    opts["prefix"] = str(opts["prefix"] or "cap")
    if opts["hwnd"] is not None and str(opts["hwnd"]).strip() != "":
        try:
            opts["hwnd"] = int(str(opts["hwnd"]), 0)
        except ValueError:
            raise CaptureError("bad_request", f"hwnd={opts['hwnd']!r} 非法（支持十进制或 0x 前缀）")
    else:
        opts["hwnd"] = None
    if opts["exe"] is not None:
        opts["exe"] = str(opts["exe"]).strip() or None
    return opts


def _resolve_target(opts: dict) -> dict:
    """决定抓谁：返回 target dict。"""
    mode = opts["mode"]
    if mode == "window":
        fg = get_foreground_window()
        hwnd = opts.get("hwnd")
        if not hwnd and opts.get("exe"):
            hwnd = find_window_by_exe(opts["exe"])
            if not hwnd:
                raise CaptureError("window_not_found", f"没有找到 exe 匹配 {opts['exe']!r} 的可见窗口")
        if not hwnd:
            hwnd = fg
            if not hwnd:
                raise CaptureError("no_foreground_window", "当前没有前台窗口（可能锁屏/桌面切换中）")
        if not user32.IsWindow(hwnd):
            raise CaptureError("window_not_found", f"HWND {hwnd} 不存在")
        if user32.IsIconic(hwnd):
            info = get_window_info(hwnd, fg)
            raise CaptureError(
                "window_minimized",
                f"目标窗口已最小化（{info['title'] if info else hwnd}），无法截图；请先恢复窗口",
                detail={"window": info},
            )
        info = get_window_info(hwnd, fg)
        if not info:
            raise CaptureError("window_info_failed", f"读取 HWND {hwnd} 信息失败")
        return {"kind": "window", "hwnd": hwnd, "window": info}
    # desktop / monitor 模式
    monitor = resolve_monitor(opts["monitor"])
    if monitor is None:
        rect = get_virtual_screen()
        return {
            "kind": "monitor",
            "monitor": None,
            "monitor_index": None,
            "monitor_device": "VIRTUAL(all)",
            "virtual_screen": True,
            "rect": rect,
        }
    return {
        "kind": "monitor",
        "monitor": monitor,
        "monitor_index": monitor["index"],
        "monitor_device": monitor["device"],
        "virtual_screen": False,
        "rect": dict(monitor["rect"]),
    }


def _clip_rect_to_virtual(rect: dict) -> tuple:
    """把窗口矩形裁到虚拟桌面范围内。返回 (clipped_rect, clipped_bool)。"""
    vs = get_virtual_screen()
    x1 = max(rect["left"], vs["left"])
    y1 = max(rect["top"], vs["top"])
    x2 = min(rect["right"], vs["right"])
    y2 = min(rect["bottom"], vs["bottom"])
    clipped = (x1, y1, x2, y2) != (rect["left"], rect["top"], rect["right"], rect["bottom"])
    if x2 <= x1 or y2 <= y1:
        return None, True
    return {"left": x1, "top": y1, "right": x2, "bottom": y2,
            "width": x2 - x1, "height": y2 - y1}, clipped


def _grab_candidates(target: dict, method: str) -> list:
    """按目标状态决定抓取方案顺序。

    窗口不在前台时，屏幕 BitBlt 只能截到“压在它上面”的内容（桌面/别的窗口），
    所以优先 PrintWindow（能绕过遮挡）；窗口在前台时优先屏幕 BitBlt（DWM 合成内容最真实）。
    两种顺序都以“黑帧检测失败后自动切下一个”兜底。
    """
    if method == "auto":
        if target["kind"] == "window":
            win = target.get("window") or {}
            # 全屏窗口：DWM“全屏优化”下屏幕 BitBlt 可能截到桌面/黑块（RimWorld 1.7 实测），
            # 优先 PrintWindow；PrintWindow 黑帧会自动回退 BitBlt。
            # 非前台窗口：BitBlt 只能截到遮挡物，也优先 PrintWindow。
            if win.get("fullscreen") or not win.get("is_foreground"):
                return ["printwindow", "bitblt"]
            return ["bitblt", "printwindow"]
        return list(_METHOD_CANDIDATES["monitor"])
    return [method]


def _grab_once(target: dict, method_name: str) -> tuple:
    """执行一次抓取，返回 (Grab, capture_rect, extras)。"""
    if target["kind"] == "monitor":
        rect = target["rect"]
        if method_name == "bitblt":
            return grab_screen(rect, use_captureblt=True, method="bitblt"), rect, {}
        if method_name == "bitblt_nocaptureblt":
            return grab_screen(rect, use_captureblt=False, method="bitblt_nocaptureblt"), rect, {}
        if method_name == "printwindow_desktop":
            vs = get_virtual_screen()
            crop = {
                "left": rect["left"] - vs["left"],
                "top": rect["top"] - vs["top"],
                "width": rect["width"],
                "height": rect["height"],
            }
            grab = grab_printwindow(
                user32.GetDesktopWindow(), vs["width"], vs["height"], src_rect=rect, crop=crop
            )
            return grab, rect, {"note": "PrintWindow(GetDesktopWindow) 后裁剪"}
        raise CaptureError("bad_method", f"monitor 模式不支持 method={method_name}")
    # window 模式
    info = target["window"]
    if method_name == "printwindow":
        legacy = info["rect"]
        w_, h_ = max(1, legacy["width"]), max(1, legacy["height"])
        grab = grab_printwindow(target["hwnd"], w_, h_, src_rect=info["frame_rect"])
        return grab, info["frame_rect"], {"note": "PrintWindow 不受遮挡影响，但部分 D3D 窗口会返回黑帧"}
    rect, clipped = _clip_rect_to_virtual(info["frame_rect"])
    if rect is None:
        raise CaptureError(
            "window_offscreen",
            "窗口完全在虚拟桌面之外，无法用屏幕 BitBlt 捕获",
            detail={"frame_rect": info["frame_rect"], "virtual_screen": get_virtual_screen()},
        )
    grab = grab_screen(rect, use_captureblt=(method_name != "bitblt_nocaptureblt"), method=method_name)
    extras = {}
    if clipped:
        extras["clipped_to_virtual_screen"] = True
        extras["requested_rect"] = info["frame_rect"]
    return grab, rect, extras


def _frame_filename(opts: dict, outdir: Path, monitor_tag: str, index: int) -> Path:
    prefix = re.sub(r"[^0-9A-Za-z_.-]", "_", opts["prefix"])[:48] or "cap"
    stamp = time.strftime("%Y%m%d_%H%M%S") + f"_{int(time.time() * 1000) % 1000:03d}"
    return outdir / f"{prefix}_{stamp}{monitor_tag}_f{index:02d}.jpg"


def _monitor_tag(target: dict) -> str:
    if target["kind"] == "window":
        return "_win"
    idx = target.get("monitor_index")
    if idx is None:
        return "_all"
    return f"_m{idx}"


def _capture_one_frame(target: dict, opts: dict, outdir: Path) -> dict:
    """抓一帧（含降级、黑帧检测、缩放、JPEG、可选 base64）。"""
    timing = {}
    t_frame0 = time.perf_counter()
    black_check = opts["black_check"]
    candidate_methods = _grab_candidates(target, opts["method"])
    attempts = []
    chosen = None  # (grab, cap_rect, extras, stats, method_name)
    grab_ms = 0.0
    stats_ms = 0.0
    last_error = None
    for method_name in candidate_methods:
        t_grab0 = time.perf_counter()
        try:
            grab, cap_rect, extras = _grab_once(target, method_name)
        except CaptureError as e:
            last_error = e
            grab_ms += (time.perf_counter() - t_grab0) * 1000
            attempts.append(
                {
                    "method": method_name,
                    "ok": False,
                    "error": e.code,
                    "message": e.message,
                    "grab_ms": round((time.perf_counter() - t_grab0) * 1000, 2),
                }
            )
            continue
        grab_ms += (time.perf_counter() - t_grab0) * 1000
        stats = None
        if black_check:
            t_stats0 = time.perf_counter()
            try:
                stats = _pixel_stats(grab)
            except CaptureError as e:
                stats = {"error": e.code, "is_black": None}
            stats_ms += (time.perf_counter() - t_stats0) * 1000
        is_black = bool(stats and stats.get("is_black"))
        attempts.append(
            {
                "method": method_name,
                "ok": True,
                "grab_ms": round((time.perf_counter() - t_grab0) * 1000, 2),
                "size": {"width": grab.width, "height": grab.height},
                "black": stats,
            }
        )
        if chosen is None:
            chosen = (grab, cap_rect, extras, stats, method_name)
        elif not is_black:
            # 新方案不黑，抛弃旧方案
            chosen[0].close()
            chosen = (grab, cap_rect, extras, stats, method_name)
        else:
            grab.close()
        if not is_black:
            break
    if chosen is None:
        raise last_error or CaptureError("capture_failed", "所有抓取方案均失败", detail={"attempts": attempts})
    if attempts:
        attempts[-1]["chosen"] = True
    grab, cap_rect, extras, stats, used_method = chosen
    timing["grab_ms"] = round(grab_ms, 2)
    timing["stats_ms"] = round(stats_ms, 2)

    src_w, src_h = grab.width, grab.height
    t_scale0 = time.perf_counter()
    scaled = False
    if opts["max_side"] or opts["scale"]:
        grab2 = scale_grab(grab, max_side=opts["max_side"], scale=opts["scale"])
        scaled = grab2 is not grab
        grab = grab2
    timing["scale_ms"] = round((time.perf_counter() - t_scale0) * 1000, 2)
    if opts["draw_cursor"]:
        draw_cursor(grab, cap_rect)

    outdir.mkdir(parents=True, exist_ok=True)
    save = opts["save"]
    frame_index = int(opts.get("_frame_index", 0))
    if save:
        out_path = _frame_filename(opts, outdir, _monitor_tag(target), frame_index)
    else:
        tmpdir = Path(os.environ.get("TEMP", str(outdir))) / "dsh-capture-tmp"
        tmpdir.mkdir(parents=True, exist_ok=True)
        out_path = tmpdir / f"dshcap_{os.getpid()}_{int(time.time() * 1000) % 1000000}_f{frame_index:02d}.jpg"
    t_jpeg0 = time.perf_counter()
    jpeg_bytes = encode_jpeg(grab.bmp, str(out_path), opts["quality"])
    timing["jpeg_ms"] = round((time.perf_counter() - t_jpeg0) * 1000, 2)

    b64 = None
    if opts["base64"]:
        t_b64_0 = time.perf_counter()
        with open(out_path, "rb") as f:
            raw = f.read()
        b64 = base64.b64encode(raw).decode("ascii")
        timing["base64_ms"] = round((time.perf_counter() - t_b64_0) * 1000, 2)
    if not save:
        try:
            os.remove(out_path)
        except OSError:
            pass

    out_w, out_h = grab.width, grab.height
    grab.close()
    timing["total_ms"] = round((time.perf_counter() - t_frame0) * 1000, 2)

    frame = {
        "index": frame_index,
        "path": str(out_path.resolve()) if save else None,
        "filename": out_path.name,
        "format": "jpeg",
        "mime": "image/jpeg",
        "width": out_w,
        "height": out_h,
        "src_width": src_w,
        "src_height": src_h,
        "scaled": scaled,
        "jpeg_quality": opts["quality"],
        "jpeg_bytes": jpeg_bytes,
        "captured_at": _iso_now(),
        "captured_at_ms": int(time.time() * 1000),
        "t_ms": opts.get("_t_ms", 0.0),
        "method": used_method,
        "attempts": attempts,
        "black": stats,
        "timing_ms": timing,
    }
    if b64 is not None:
        frame["base64"] = b64
    if extras:
        frame["capture_notes"] = extras
    return frame


def _summarize_timing(frames: list) -> dict:
    if not frames:
        return {}
    grabs = [f["timing_ms"].get("grab_ms", 0.0) for f in frames]
    jpegs = [f["timing_ms"].get("jpeg_ms", 0.0) for f in frames]
    totals = [f["timing_ms"].get("total_ms", 0.0) for f in frames]

    def _stat(values):
        vs = sorted(values)
        n = len(vs)
        if n == 0:
            return {}
        def pct(p):
            idx = min(n - 1, max(0, int(round(p / 100.0 * (n - 1)))))
            return round(vs[idx], 2)
        return {
            "min": round(vs[0], 2),
            "avg": round(sum(vs) / n, 2),
            "p50": pct(50),
            "p95": pct(95),
            "max": round(vs[-1], 2),
        }

    return {
        "frames": len(frames),
        "total_ms": _stat(totals),
        "grab_ms": _stat(grabs),
        "jpeg_ms": _stat(jpegs),
        "first_frame_ms": round(totals[0], 2),
        "fps_equiv": round(1000.0 / (sum(totals) / len(totals)), 2) if sum(totals) else None,
        "burst_wall_ms": round(frames[-1].get("t_ms", 0.0) + frames[-1]["timing_ms"].get("total_ms", 0.0), 2),
    }


def do_capture(opts: dict, info_only: bool = False) -> dict:
    """执行一次完整捕获请求，返回结果 dict（不会抛异常给调用方，异常转 error JSON）。"""
    started = time.perf_counter()
    ctx = {}
    result = {
        "ok": False,
        "schema": SCHEMA,
        "service": {"name": "dsh-capture", "version": __version__},
        "generated_at": _iso_now(),
        "options": {k: v for k, v in opts.items() if not str(k).startswith("_")},
        "environment": None,
        "window": None,
        "capture": None,
        "frames": [],
        "timing": {},
        "warnings": [],
        "error": None,
    }
    try:
        with _CAPTURE_LOCK:
            init_dpi_awareness()
            result["environment"] = environment_info()
            t_info = time.perf_counter()
            fg = get_foreground_window()
            fg_info = get_window_info(fg, fg) if fg else None
            result["window"] = fg_info
            result["timing_info_ms"] = round((time.perf_counter() - t_info) * 1000, 2)
            if info_only:
                result["ok"] = True
                result["timing"]["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 2)
                result["capture"] = {"mode": "info_only", "frames": 0}
                return result
            target = _resolve_target(opts)
            capture_meta = {
                "mode": opts["mode"],
                "target_kind": target["kind"],
                "monitor_index": target.get("monitor_index"),
                "monitor_device": target.get("monitor_device"),
                "virtual_screen": target.get("virtual_screen", False),
                "target_rect": target.get("rect"),
                "window": target.get("window"),
                "method_requested": opts["method"],
            }
            if target["kind"] == "window":
                win = target["window"]
                capture_meta["target_rect"] = win["frame_rect"]
                if win["display_affinity"] == WDA_EXCLUDEFROMCAPTURE:
                    result["warnings"].append(
                        {
                            "code": "window_excludes_capture",
                            "message": "该窗口设置了 WDA_EXCLUDEFROMCAPTURE（防截屏），抓到黑帧是预期行为",
                        }
                    )
                if win["minimized"]:
                    raise CaptureError("window_minimized", "目标窗口已最小化")
                if win["dwm_cloaked"]:
                    result["warnings"].append(
                        {"code": "window_cloaked", "message": "DWM 报告窗口被 cloaked（UWP 挂起/虚拟桌面），可能抓不到内容"}
                    )
                if win["is_foreground"] is False and opts["mode"] == "window":
                    result["warnings"].append(
                        {
                            "code": "window_not_foreground",
                            "message": "目标窗口不在前台：屏幕 BitBlt 会截到遮挡它的内容（桌面/别的窗口），已优先尝试 PrintWindow",
                        }
                    )
            result["capture"] = capture_meta

            outdir = Path(opts["outdir"]) if opts["outdir"] else (SCRIPT_DIR / "shots")
            frames = []
            burst_start = time.perf_counter()
            prev_sched = 0.0
            for i in range(opts["count"]):
                if i > 0 and opts["interval_ms"] > 0:
                    target_t = burst_start + i * (opts["interval_ms"] / 1000.0)
                    now = time.perf_counter()
                    if target_t > now:
                        time.sleep(target_t - now)
                opts_i = dict(opts)
                opts_i["_frame_index"] = i
                opts_i["_t_ms"] = round((time.perf_counter() - burst_start) * 1000, 2)
                frame = _capture_one_frame(target, opts_i, outdir)
                frame["index"] = i
                frame["t_ms"] = round((time.perf_counter() - burst_start) * 1000, 2)
                frames.append(frame)
                for wmsg in _frame_warnings(frame):
                    result["warnings"].append(wmsg)
            result["frames"] = frames
            burst_elapsed = round((time.perf_counter() - burst_start) * 1000, 2)
            result["timing"]["burst_elapsed_ms"] = burst_elapsed
            result["timing"]["frames"] = _summarize_timing(frames)
            result["timing"]["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 2)
            result["capture"]["frames"] = len(frames)
            if frames:
                result["capture"]["method_used"] = frames[0]["method"]
                result["capture"]["out_size"] = {"width": frames[0]["width"], "height": frames[0]["height"]}
                result["capture"]["scale_factor"] = round(frames[0]["width"] / max(1, frames[0]["src_width"]), 4)
            black_frames = [f for f in frames if f.get("black") and f["black"].get("is_black")]
            if black_frames and len(black_frames) == len(frames):
                result["warnings"].append(
                    {
                        "code": "all_frames_black",
                        "message": "所有帧均为全黑：可能是独占全屏/DX12 全屏优化/HDR/受保护内容，或窗口 WDA 防截屏",
                    }
                )
            if opts["method"] == "auto" and target["kind"] == "window":
                if frames and frames[0]["attempts"] and frames[0]["attempts"][0].get("black") and frames[0]["attempts"][0]["black"].get("is_black"):
                    result["warnings"].append(
                        {"code": "fallback_used", "message": "首选方案黑帧，已自动降级；详见 frames[].attempts"}
                    )
            result["ok"] = bool(frames)
            return result
    except CaptureError as e:
        result["error"] = {"code": e.code, "message": e.message, "detail": e.detail}
        result["timing"]["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 2)
        return result
    except Exception as e:  # noqa: BLE001 - 兜底，保证 JSON 契约
        result["error"] = {
            "code": "internal_error",
            "message": f"{type(e).__name__}: {e}",
            "traceback": traceback.format_exc(limit=6),
        }
        result["timing"]["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 2)
        return result


def _frame_warnings(frame: dict) -> list:
    out = []
    black = frame.get("black")
    if black and black.get("is_black"):
        out.append(
            {
                "code": "black_frame",
                "message": f"第 {frame['index']} 帧疑似全黑（mean={black.get('mean')}, std={black.get('std')}, method={frame['method']}）",
                "frame": frame["index"],
            }
        )
    failed = [a for a in frame.get("attempts", []) if not a.get("ok")]
    if failed and frame["index"] == 0:
        out.append(
            {
                "code": "some_methods_failed",
                "message": "部分抓取方案失败：" + ", ".join(f"{a['method']}({a.get('error')})" for a in failed),
                "frame": frame["index"],
            }
        )
    return out


def classify_result(result: dict) -> tuple:
    """返回 (level, summary) 用于人类可读输出/日志。"""
    if not result.get("ok"):
        err = result.get("error") or {}
        return "error", f"{err.get('code', 'unknown')}: {err.get('message', '')}"
    frames = result.get("frames") or []
    black = [f["index"] for f in frames if f.get("black") and f["black"].get("is_black")]
    t = (result.get("timing") or {}).get("frames") or {}
    summary = (
        f"{len(frames)} 帧, 平均 {t.get('total_ms', {}).get('avg', '?')} ms/帧 "
        f"(抓取 {t.get('grab_ms', {}).get('avg', '?')} ms + JPEG {t.get('jpeg_ms', {}).get('avg', '?')} ms)"
    )
    if black:
        summary += f", 黑帧: {black}"
        return "warn", summary
    return "ok", summary


# --------------------------------------------------------------------------------------
# CLI / 输出
# --------------------------------------------------------------------------------------
def _configure_stdio():
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        try:
            if stream is not None and stream.encoding and stream.encoding.lower() not in ("utf-8", "utf8"):
                stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def _emit_json(result: dict, pretty: bool = False):
    text = json.dumps(result, ensure_ascii=True, indent=2 if pretty else None, separators=None if pretty else (",", ":"))
    sys.stdout.write(text + "\n")
    sys.stdout.flush()


def _human_report(result: dict):
    env = result.get("environment") or {}
    win = result.get("window") or {}
    cap = result.get("capture") or {}
    err = result.get("error")
    print(f"dsh-capture v{__version__}  dpi={env.get('dpi_awareness')}  monitors={env.get('monitor_count')}")
    for m in env.get("monitors", []):
        print(
            f"  monitor #{m['index']} {m['device']} primary={m['primary']} rect={m['rect']['width']}x{m['rect']['height']}"
            f"@({m['rect']['left']},{m['rect']['top']}) dpi={m['dpi']['x']} scale={m['scale']['x']}"
        )
    if win:
        print(
            f"  前台窗口: {win['title']!r} pid={win['pid']} exe={win['exe']} "
            f"rect={win['frame_rect']['width']}x{win['frame_rect']['height']} "
            f"fullscreen={win['fullscreen']} maximized={win['maximized']} game_guess={win['game_guess']['suspected']}"
        )
    if err:
        print(f"  [ERROR] {err['code']}: {err['message']}")
        return
    if cap.get("mode") != "info_only":
        print(
            f"  捕获: mode={cap.get('mode')} target={cap.get('monitor_device') or cap.get('target_kind')} "
            f"method={cap.get('method_used')} out={cap.get('out_size')}"
        )
        for f in result.get("frames", []):
            bt = f.get("black") or {}
            print(
                f"  - f{f['index']}: {f['path'] or '(未保存)'} {f['width']}x{f['height']} "
                f"{f['jpeg_bytes']}B 抓取 {f['timing_ms'].get('grab_ms')}ms JPEG {f['timing_ms'].get('jpeg_ms')}ms "
                f"总计 {f['timing_ms'].get('total_ms')}ms black={bt.get('is_black')} "
                f"(mean={bt.get('mean')} std={bt.get('std')})"
            )
        t = (result.get("timing") or {}).get("frames") or {}
        print(f"  计时: {json.dumps(t, ensure_ascii=False)}")
    for wmsg in result.get("warnings", []):
        print(f"  [WARN] {wmsg['code']}: {wmsg['message']}")


def _append_jsonl_log(path: str | None, result: dict):
    if not path:
        return
    try:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        frames = result.get("frames") or []
        entry = {
            "ts": result.get("generated_at"),
            "ok": result.get("ok"),
            "error": result.get("error"),
            "mode": (result.get("options") or {}).get("mode"),
            "count": len(frames),
            "method": (result.get("capture") or {}).get("method_used"),
            "black": [f["index"] for f in frames if f.get("black") and f["black"].get("is_black")],
            "elapsed_ms": (result.get("timing") or {}).get("elapsed_ms"),
            "frames": [
                {
                    "path": f.get("path"),
                    "width": f.get("width"),
                    "height": f.get("height"),
                    "bytes": f.get("jpeg_bytes"),
                    "total_ms": (f.get("timing_ms") or {}).get("total_ms"),
                }
                for f in frames
            ],
        }
        with open(p, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass


def run_serve_stdio(base_opts: dict):
    _configure_stdio()
    init_dpi_awareness()
    _gdiplus_startup()
    sys.stderr.write(f"dsh-capture v{__version__} stdio serve ready\n")
    sys.stderr.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            _emit_json({"ok": False, "service": {"name": "dsh-capture", "version": __version__}, "error": {"code": "bad_json", "message": str(e)}})
            continue
        cmd = str(req.pop("cmd", "capture")).lower()
        if cmd in ("shutdown", "quit", "exit"):
            _emit_json({"ok": True, "event": "shutdown"})
            break
        if cmd == "ping":
            _emit_json({"ok": True, "event": "pong", "service": {"name": "dsh-capture", "version": __version__}, "pid": os.getpid()})
            continue
        if cmd not in ("capture", "info", "bench"):
            _emit_json(
                {
                    "ok": False,
                    "service": {"name": "dsh-capture", "version": __version__},
                    "error": {"code": "bad_command", "message": f"未知命令: {cmd!r}（可用 capture/info/bench/ping/shutdown）"},
                }
            )
            continue
        info_only = cmd == "info"
        if cmd == "bench":
            req.setdefault("count", req.pop("n", 10))
            req["interval_ms"] = 0
        try:
            opts = _normalize_options(req, base_opts)
        except CaptureError as e:
            _emit_json({"ok": False, "service": {"name": "dsh-capture", "version": __version__}, "error": {"code": e.code, "message": e.message}})
            continue
        result = do_capture(opts, info_only=bool(info_only))
        _append_jsonl_log(opts.get("log_jsonl"), result)
        _emit_json(result)


def _request_from_query(query: dict, base: dict) -> dict:
    out = dict(base)
    for key, values in query.items():
        if not values:
            continue
        val = values[-1]
        if val in ("1", "true", "True", "yes", "on"):
            val = True
        elif val in ("0", "false", "False", "no", "off"):
            val = False
        out[key] = val
    return out


def run_serve_http(base_opts: dict, host: str, port: int):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import urlparse, parse_qs

    _configure_stdio()
    init_dpi_awareness()
    _gdiplus_startup()
    service = {"name": "dsh-capture", "version": __version__, "schema": SCHEMA}

    class Handler(BaseHTTPRequestHandler):
        server_version = f"dsh-capture/{__version__}"
        protocol_version = "HTTP/1.1"

        def _send_json(self, code: int, payload):
            body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.end_headers()
            self.wfile.write(body)

        def _handle(self, cmd: str, raw: dict):
            if cmd in ("health", "ping"):
                self._send_json(200, {"ok": True, "event": "pong", "service": service, "pid": os.getpid()})
                return
            if raw is None:
                raw = {}
            if cmd == "bench":
                raw.setdefault("count", raw.pop("n", 10))
                raw["interval_ms"] = 0
                cmd = "capture"
            try:
                opts = _normalize_options(raw, base_opts)
            except CaptureError as e:
                self._send_json(400, {"ok": False, "service": service, "error": {"code": e.code, "message": e.message}})
                return
            result = do_capture(opts, info_only=(cmd == "info"))
            _append_jsonl_log(opts.get("log_jsonl"), result)
            self._send_json(200 if result.get("ok") else 500, result)

        def do_GET(self):  # noqa: N802
            try:
                parsed = urlparse(self.path)
                cmd = parsed.path.strip("/").lower() or "health"
                if cmd not in ("health", "ping", "capture", "info", "bench"):
                    self._send_json(404, {"ok": False, "error": {"code": "not_found", "message": self.path}})
                    return
                raw = {k: v[-1] for k, v in parse_qs(parsed.query).items() if v}
                self._handle(cmd, raw)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_POST(self):  # noqa: N802
            try:
                parsed = urlparse(self.path)
                cmd = parsed.path.strip("/").lower() or "capture"
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                raw = json.loads(body.decode("utf-8")) if body.strip() else {}
                if not isinstance(raw, dict):
                    raise ValueError("JSON 请求体必须是对象")
                if "cmd" in raw:
                    cmd = str(raw.pop("cmd")).lower()
                self._handle(cmd, raw)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as e:  # noqa: BLE001
                self._send_json(400, {"ok": False, "error": {"code": "bad_request", "message": f"{type(e).__name__}: {e}"}})

        def do_OPTIONS(self):  # noqa: N802
            self._send_json(200, {"ok": True})

        def log_message(self, fmt, *args):
            sys.stderr.write("[http] " + (fmt % args) + "\n")
            sys.stderr.flush()

    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    actual_port = httpd.server_address[1]
    _emit_json({"ok": True, "event": "listening", "service": service, "host": host, "port": actual_port})
    sys.stderr.write(f"dsh-capture http listening on http://{host}:{actual_port}\n")
    sys.stderr.flush()
    try:
        httpd.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="capture.py",
        description="dsh-capture — Windows 屏幕/游戏截图服务（零第三方依赖）。默认输出人类可读摘要；加 --json 输出单行 JSON。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""示例:
  python capture.py --json --count 3 --interval-ms 300
  python capture.py --json --mode window --exe RimWorld --max-side 1600 --base64
  python capture.py --json --mode desktop --monitor primary --max-side 0 --quality 90
  python capture.py --json --mode foreground --bench 10
  python capture.py --info --json
  python capture.py --serve stdio
  python capture.py --serve http --port 8765
""",
    )
    p.add_argument("--version", action="version", version=f"dsh-capture {__version__}")
    p.add_argument("--json", action="store_true", help="输出一行 JSON 到 stdout（插件调用用这个）")
    p.add_argument("--pretty", action="store_true", help="JSON 缩进输出（调试用，不保证单行）")
    p.add_argument("--mode", default="desktop", choices=["desktop", "monitor", "screen", "window", "foreground"],
                   help="抓取目标：desktop/monitor=显示器；window=指定/前台窗口；foreground=前台窗口（默认 desktop）")
    p.add_argument("--monitor", default="primary", help="显示器选择：primary（默认）/ all=虚拟桌面 / 数字索引（如 0、1）")
    p.add_argument("--hwnd", default=None, help="窗口句柄（十进制或 0x 前缀），配合 --mode window")
    p.add_argument("--exe", default=None, help="按进程 exe 名/路径子串找窗口，配合 --mode window")
    p.add_argument("--count", type=int, default=1, help="连拍帧数（默认 1，上限 %d）" % MAX_COUNT)
    p.add_argument("--interval-ms", type=int, default=300, help="连拍帧间隔毫秒（默认 300，按帧起始时刻对齐）")
    p.add_argument("--max-side", type=int, default=1600, help="输出 JPEG 长边上限像素（默认 1600；0=不缩放）")
    p.add_argument("--scale", type=float, default=0.0, help="输出缩放倍率（如 0.5）；优先于 --max-side")
    p.add_argument("--quality", type=int, default=82, help="JPEG 质量 1-100（默认 82）")
    p.add_argument("--outdir", default=None, help="输出目录（默认 <脚本目录>/shots）")
    p.add_argument("--prefix", default="cap", help="文件名前缀（默认 cap）")
    p.add_argument("--base64", action="store_true", help="帧结果中包含 base64 JPEG（体积大，插件按需用）")
    p.add_argument("--no-save", action="store_true", help="不持久化截图文件（写到临时目录后删除，配合 --base64 用）")
    p.add_argument("--no-black-check", action="store_true", help="关闭黑帧检测（省几毫秒）")
    p.add_argument("--method", default="auto", help="抓取方案：auto（默认，黑帧自动降级）/ bitblt / printwindow")
    p.add_argument("--draw-cursor", action="store_true", help="把鼠标指针画进截图（默认不含光标）")
    p.add_argument("--info", "--info-only", dest="info_only", action="store_true", help="只输出环境/前台窗口信息，不截图")
    p.add_argument("--bench", type=int, default=0, metavar="N", help="压测：连拍 N 帧（interval=0），输出耗时统计")
    p.add_argument("--log-jsonl", default=None, help="把每次调用的结果摘要追加写入 JSONL 日志文件")
    p.add_argument("--serve", choices=["stdio", "http"], default=None, help="常驻服务模式：stdio=标准输入输出 NDJSON；http=本地 HTTP")
    p.add_argument("--host", default="127.0.0.1", help="HTTP 监听地址（默认 127.0.0.1）")
    p.add_argument("--port", type=int, default=8765, help="HTTP 监听端口（默认 8765，0=随机）")

    p.add_argument("--count-alias", dest="count_alias", type=int, default=None, help=argparse.SUPPRESS)
    return p


def main(argv=None) -> int:
    _configure_stdio()
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    base_opts = {
        "mode": args.mode,
        "monitor": args.monitor,
        "hwnd": args.hwnd,
        "exe": args.exe,
        "count": args.count,
        "interval_ms": args.interval_ms,
        "max_side": args.max_side,
        "scale": args.scale,
        "quality": args.quality,
        "outdir": args.outdir,
        "prefix": args.prefix,
        "base64": args.base64,
        "save": not args.no_save,
        "black_check": not args.no_black_check,
        "method": args.method,
        "draw_cursor": args.draw_cursor,
        "log_jsonl": args.log_jsonl,
    }
    if args.bench:
        base_opts["count"] = args.bench
        base_opts["interval_ms"] = 0
    if args.serve == "stdio":
        try:
            opts = _normalize_options({}, base_opts)
        except CaptureError as e:
            _emit_json({"ok": False, "error": {"code": e.code, "message": e.message}})
            return 1
        run_serve_stdio(opts)
        return 0
    if args.serve == "http":
        try:
            opts = _normalize_options({}, base_opts)
        except CaptureError as e:
            _emit_json({"ok": False, "error": {"code": e.code, "message": e.message}})
            return 1
        try:
            run_serve_http(opts, args.host, args.port)
        except KeyboardInterrupt:
            pass
        except OSError as e:
            sys.stderr.write(f"HTTP 服务启动失败: {e}\n")
            return 1
        return 0
    try:
        opts = _normalize_options({}, base_opts)
    except CaptureError as e:
        payload = {"ok": False, "service": {"name": "dsh-capture", "version": __version__}, "error": {"code": e.code, "message": e.message}}
        if args.json or args.pretty:
            _emit_json(payload, pretty=args.pretty)
        else:
            print(f"参数错误: {e.message}")
        return 2
    result = do_capture(opts, info_only=args.info_only)
    if args.bench:
        result["bench"] = {
            "frames": (result.get("timing") or {}).get("frames"),
            "note": f"连拍 {opts['count']} 帧，interval=0，含抓取+黑帧检测+缩放+JPEG 编码落盘",
        }
    _append_jsonl_log(opts.get("log_jsonl"), result)
    if args.json or args.pretty:
        _emit_json(result, pretty=args.pretty)
    else:
        _human_report(result)
    if result.get("ok"):
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
