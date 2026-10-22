#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""dsh-capture-server — 给 DSH 陪玩插件用的常驻本地 HTTP 截图服务。

薄封装：截图核心全部在 capture.py（零第三方依赖），本文件只做 HTTP 壳 + 契约字段转换。

接口契约（与插件侧约定）
------------------------
GET /health
  -> {"ok": true, "version": 1, "service": "dsh-capture-server", "pid": ..., ...}

GET /window
  -> 200 {"ok": true, "window": {...同 /capture 的 window 字段...},
          "screen": {...}, "idleSec": <键鼠空闲秒数>, "elapsedMs": 3}
  只读：不截图，供插件 45s 节拍判断“在不在玩游戏 / 人还在不在”。

GET /capture?count=3&intervalMs=300&maxLongEdge=1280&quality=72&outDir=<绝对目录>
  -> 200 {"ok": true,
          "frames": [{"path": "<绝对路径>", "width": W, "height": H,
                      "bytes": N, "capturedAt": <epoch ms>}, ...],
          "window": {"title": "...", "process": "xxx.exe", "pid": 123,
                     "isFullscreen": true, "bounds": [x, y, w, h]},
          "screen": {"width": 2560, "height": 1440, "dpi": 144, "scale": 1.5},
          "black": false,
          "elapsedMs": 123}
  失败 -> 4xx/5xx {"ok": false, "error": {"code": "...", "message": "..."}}
  所有帧由服务写入 outDir（必须是绝对路径），插件直接读文件，不走 base64。

可选扩展参数（不传就用默认）：mode=desktop|window|foreground、monitor=primary|all|索引、
exe=进程名子串（mode=window 时）、hwnd=窗口句柄、drawCursor=1、blackCheck=0、
quality=1..100、maxLongEdge=0 表示不缩放。

单实例锁：端口被占用时探测 /health，如果已经是本服务就安静退出 0；否则 stderr 报错退出 1。

启动：
  python capture_server.py                 # 127.0.0.1:9124
  python capture_server.py --port 9124 --host 127.0.0.1
"""

from __future__ import annotations

import json
import os
import socket
import sys
import time
import traceback
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, parse_qsl, urlparse

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import capture as dc  # noqa: E402  （同目录核心库）

API_VERSION = 1
SERVICE_NAME = "dsh-capture-server"
DEFAULT_PORT = 9124
DEFAULT_HOST = "127.0.0.1"

# 插件契约使用 camelCase 参数名，这里映射到 capture.py 的内部参数名
QUERY_ALIASES = {
    "intervalMs": "interval_ms",
    "interval": "interval_ms",
    "maxLongEdge": "max_side",
    "outDir": "outdir",
    "outdir": "outdir",
    "drawCursor": "draw_cursor",
    "blackCheck": "black_check",
}

_STARTED_AT = time.time()


def _log(msg: str):
    sys.stderr.write(f"[dsh-capture-server] {msg}\n")
    sys.stderr.flush()


def _repair_mojibake(value: str) -> str:
    """修复“原始非 ASCII 字节被 latin-1 解码”的参数（典型的路径乱码）。

    有些客户端会把 query 里的中文按系统代码页直接塞进请求行（不做 percent 编码），
    BaseHTTPRequestHandler 按 ISO-8859-1 解出来就是一堆 Ã… 字符。这里把字符串按
    latin-1 还原成原始字节，再依次尝试 UTF-8 / GBK 解码。
    """
    if not isinstance(value, str) or not value:
        return value
    if any(ord(ch) > 0xFF for ch in value):
        return value  # 已经含真正的非 latin-1 字符（中文等），不用修
    if not any(ord(ch) > 0x7F for ch in value):
        return value  # 纯 ASCII
    try:
        raw = value.encode("latin-1")
    except UnicodeEncodeError:
        return value
    for enc in ("utf-8", "gbk"):
        try:
            repaired = raw.decode(enc)
        except UnicodeDecodeError:
            continue
        if repaired != value:
            return repaired
    return value


def _decode_query(qs: str) -> dict:
    """解析查询串；优先 UTF-8，失败再退 GBK（中文 Windows 的老客户端常见）。

    同时对未做 percent 编码、原始字节被 latin-1 解码的中文再做一次修复。
    返回 {name: [values]}，与 urllib.parse.parse_qs 的形态一致。
    """
    pairs = None
    for enc in ("utf-8", "gbk"):
        try:
            pairs = parse_qsl(qs, keep_blank_values=True, encoding=enc, errors="strict")
            break
        except (UnicodeDecodeError, UnicodeEncodeError):
            continue
    if pairs is None:
        pairs = parse_qsl(qs, keep_blank_values=True)
    out = {}
    for k, v in pairs:
        out.setdefault(_repair_mojibake(k), []).append(_repair_mojibake(v))
    return out


def _decode_json_body(raw: bytes) -> dict:
    last_error = None
    for enc in ("utf-8", "gbk"):
        try:
            decoded = json.loads(raw.decode(enc))
            if not isinstance(decoded, dict):
                raise ValueError("JSON body 必须是对象")
            return {_repair_mojibake(k): _repair_mojibake(v) if isinstance(v, str) else v for k, v in decoded.items()}
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as e:
            last_error = e
    raise ValueError(f"无法解析 JSON 请求体: {last_error}")


def _bool_param(value) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() not in ("0", "false", "no", "off", "")


def _parse_request(query: dict, base_opts: dict) -> dict:
    """把 HTTP 查询参数（camelCase 或 snake_case）转换为 capture.py 的 options。"""
    raw = {}
    for key, values in query.items():
        if isinstance(values, (list, tuple)):
            val = values[-1] if values else None
        else:
            val = values
        if val is None:
            continue
        key = QUERY_ALIASES.get(key, key)
        key = key.replace("-", "_")
        raw[key] = val
    # 常用布尔/数值参数转类型
    for key in ("base64", "save", "black_check", "draw_cursor"):
        if key in raw:
            raw[key] = _bool_param(raw[key])
    opts = dc._normalize_options(raw, base_opts)
    # 契约要求：帧必须落到 outDir（绝对路径），不走 base64
    opts["base64"] = False
    opts["save"] = True
    if not opts.get("outdir"):
        raise dc.CaptureError("outdir_required", "缺少 outDir 参数（必须是绝对目录）")
    outdir = Path(opts["outdir"])
    if not outdir.is_absolute():
        raise dc.CaptureError("outdir_not_absolute", f"outDir 必须是绝对路径，收到: {outdir}")
    outdir.mkdir(parents=True, exist_ok=True)
    opts["outdir"] = str(outdir)
    return opts


def _pick_screen_info(result: dict, target_window: dict | None) -> dict:
    """screen 字段：被截的那块显示器（窗口模式取窗口所在显示器，否则主显示器）。"""
    env = result.get("environment") or {}
    monitors = env.get("monitors") or []
    chosen = None
    cap = result.get("capture") or {}
    mon_idx = cap.get("monitor_index")
    if mon_idx is not None:
        for m in monitors:
            if m.get("index") == mon_idx:
                chosen = m
                break
    if chosen is None and target_window and target_window.get("monitor_index") is not None:
        for m in monitors:
            if m.get("index") == target_window["monitor_index"]:
                chosen = m
                break
    if chosen is None:
        for m in monitors:
            if m.get("primary"):
                chosen = m
                break
    if chosen is None and monitors:
        chosen = monitors[0]
    if chosen is None:
        return {"width": 0, "height": 0, "dpi": 96, "scale": 1.0}
    rect = chosen["rect"]
    return {
        "width": rect["width"],
        "height": rect["height"],
        "dpi": chosen["dpi"]["x"],
        "scale": chosen["scale"]["x"],
        "device": chosen["device"],
        "index": chosen["index"],
        "primary": chosen["primary"],
    }


def _window_contract(result: dict) -> dict:
    """window 字段：前台窗口（窗口模式下为被截目标窗口）的契约视图。"""
    win = result.get("window") or {}
    cap_win = ((result.get("capture") or {}).get("window")) or None
    # 窗口模式下，capture.window 是真正的截图目标；否则用前台窗口
    target = cap_win if cap_win else win
    if not target:
        return {"title": None, "process": None, "pid": None, "isFullscreen": False, "bounds": None}
    frame_rect = target.get("frame_rect") or target.get("rect") or {}
    bounds = None
    if frame_rect:
        bounds = [frame_rect.get("left"), frame_rect.get("top"), frame_rect.get("width"), frame_rect.get("height")]
    return {
        "title": target.get("title"),
        "process": target.get("exe") or None,
        "pid": target.get("pid"),
        "isFullscreen": bool(target.get("fullscreen")),
        "bounds": bounds,
        "isForeground": bool(target.get("is_foreground")),
        "monitorIndex": target.get("monitor_index"),
        "minimized": bool(target.get("minimized")),
        "gameSuspected": bool((target.get("game_guess") or {}).get("suspected")),
        "idleSec": target.get("idle_sec"),
    }


def _contract_response(result: dict) -> tuple:
    """把 capture.py 的结果转换为插件契约 JSON。返回 (http_status, payload)。"""
    if not result.get("ok"):
        err = result.get("error") or {}
        code = err.get("code") or "capture_failed"
        status = 500
        # 客户端参数错误用 4xx
        if code in ("bad_request", "bad_monitor", "bad_exe", "outdir_required", "outdir_not_absolute", "window_not_found", "no_foreground_window"):
            status = 400
        elif code in ("window_minimized",):
            status = 409
        payload = {"ok": False, "error": {"code": code, "message": err.get("message") or "capture failed"}}
        return status, payload
    frames = result.get("frames") or []
    window = _window_contract(result)
    screen = _pick_screen_info(result, window)
    contract_frames = []
    for f in frames:
        contract_frames.append(
            {
                "path": f.get("path"),
                "width": f.get("width"),
                "height": f.get("height"),
                "bytes": f.get("jpeg_bytes"),
                "capturedAt": f.get("captured_at_ms"),
            }
        )
    black_flags = [bool((f.get("black") or {}).get("is_black")) for f in frames]
    black = bool(black_flags) and all(black_flags)
    elapsed_ms = int(round(((result.get("timing") or {}).get("elapsed_ms") or 0)))
    payload = {
        "ok": True,
        "frames": contract_frames,
        "window": window,
        "screen": screen,
        "black": black,
        "elapsedMs": elapsed_ms,
    }
    return 200, payload


class CaptureRequestHandler(BaseHTTPRequestHandler):
    server_version = f"dsh-capture-server/{API_VERSION}"
    protocol_version = "HTTP/1.1"
    base_opts = dict(dc.DEFAULT_OPTIONS)

    # ---- helpers -------------------------------------------------------------
    def _send_json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _health_payload(self) -> dict:
        env = dc.environment_info()
        monitors = env.get("monitors") or []
        primary = next((m for m in monitors if m.get("primary")), monitors[0] if monitors else None)
        return {
            "ok": True,
            "version": API_VERSION,
            "service": SERVICE_NAME,
            "pid": os.getpid(),
            "uptimeSec": round(time.time() - _STARTED_AT, 1),
            "captureCore": {"name": "dsh-capture", "version": dc.__version__},
            "dpiAwareness": env.get("dpi_awareness"),
            "monitorCount": len(monitors),
            "primaryScreen": (
                {"width": primary["rect"]["width"], "height": primary["rect"]["height"], "dpi": primary["dpi"]["x"]}
                if primary
                else None
            ),
            "defaults": {"maxLongEdge": self.base_opts.get("max_side"), "quality": self.base_opts.get("quality")},
        }

    def _capture(self, query: dict):
        t0 = time.perf_counter()
        try:
            opts = _parse_request(query, self.base_opts)
        except dc.CaptureError as e:
            self._send_json(400, {"ok": False, "error": {"code": e.code, "message": e.message}})
            return
        result = dc.do_capture(opts, info_only=False)
        status, payload = _contract_response(result)
        elapsed = (time.perf_counter() - t0) * 1000
        if payload.get("ok"):
            _log(
                f"capture ok frames={len(payload.get('frames') or [])} "
                f"black={payload.get('black')} elapsed={elapsed:.1f}ms outDir={opts.get('outdir')}"
            )
        else:
            _log(f"capture FAILED code={payload['error']['code']} elapsed={elapsed:.1f}ms msg={payload['error']['message']}")
        self._send_json(status, payload)

    def _window_only(self):
        """GET /window：只读窗口/屏幕/空闲信息，不截图（插件 45s 节拍探测用）。"""
        t0 = time.perf_counter()
        try:
            opts = dict(self.base_opts)
            opts["base64"] = False
            opts["save"] = False
            result = dc.do_capture(opts, info_only=True)
            if not result.get("ok"):
                err = result.get("error") or {}
                self._send_json(
                    500,
                    {
                        "ok": False,
                        "error": {
                            "code": err.get("code") or "window_info_failed",
                            "message": err.get("message") or "读取窗口信息失败",
                        },
                    },
                )
                return
            window = _window_contract(result)
            screen = _pick_screen_info(result, window)
            idle_sec = window.get("idleSec")
            elapsed_ms = int(round((time.perf_counter() - t0) * 1000))
            _log(f"window ok title={window.get('title')!r} idleSec={idle_sec} elapsed={elapsed_ms}ms")
            self._send_json(
                200,
                {
                    "ok": True,
                    "window": window,
                    "screen": screen,
                    "idleSec": idle_sec,
                    "elapsedMs": elapsed_ms,
                },
            )
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001
            _log("unhandled /window error:\n" + traceback.format_exc(limit=5))
            self._send_json(500, {"ok": False, "error": {"code": "internal_error", "message": f"{type(e).__name__}: {e}"}})

    # ---- verbs ---------------------------------------------------------------
    def do_GET(self):  # noqa: N802
        try:
            parsed = urlparse(self.path)
            path = parsed.path.rstrip("/") or "/"
            query = _decode_query(parsed.query)
            if path in ("/health", "/healthz", "/"):
                self._send_json(200, self._health_payload())
                return
            if path == "/window":
                self._window_only()
                return
            if path == "/capture":
                self._capture(query)
                return
            self._send_json(404, {"ok": False, "error": {"code": "not_found", "message": f"unknown path: {parsed.path}"}})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001
            _log("unhandled GET error:\n" + traceback.format_exc(limit=5))
            self._send_json(500, {"ok": False, "error": {"code": "internal_error", "message": f"{type(e).__name__}: {e}"}})

    def do_POST(self):  # noqa: N802
        try:
            parsed = urlparse(self.path)
            path = parsed.path.rstrip("/") or "/"
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b""
            data = {}
            if body.strip():
                data = _decode_json_body(body)
            # POST 与 GET 参数等价（JSON 体里的 camelCase 同样支持）
            if path == "/window":
                self._window_only()
                return
            if path == "/capture":
                self._capture({k: [v] if not isinstance(v, list) else v for k, v in data.items()})
                return
            if path in ("/health", "/healthz", "/"):
                self._send_json(200, self._health_payload())
                return
            self._send_json(404, {"ok": False, "error": {"code": "not_found", "message": f"unknown path: {parsed.path}"}})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001
            _log("unhandled POST error:\n" + traceback.format_exc(limit=5))
            self._send_json(400, {"ok": False, "error": {"code": "bad_request", "message": f"{type(e).__name__}: {e}"}})

    def do_OPTIONS(self):  # noqa: N802
        self._send_json(200, {"ok": True})

    def log_message(self, fmt, *args):
        _log("[http] " + (fmt % args))


def probe_health(host: str, port: int, timeout: float = 1.5) -> dict | None:
    probe_host = "127.0.0.1" if host in ("0.0.0.0", "", "::") else host
    url = f"http://{probe_host}:{port}/health"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            raw = resp.read()
        payload = json.loads(raw.decode("utf-8"))
        return payload if isinstance(payload, dict) else None
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError):
        return None


def port_is_open(host: str, port: int, timeout: float = 0.4) -> bool:
    """尝试 TCP connect 判断端口上是否已有监听者（Windows 上 SO_REUSEADDR 会让 bind 假成功，必须先探测）。"""
    probe_host = "127.0.0.1" if host in ("0.0.0.0", "", "::") else host
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        return sock.connect_ex((probe_host, port)) == 0
    except OSError:
        return False
    finally:
        sock.close()


def _resolve_existing_instance(host: str, port: int) -> tuple:
    """端口被占用时判断是不是本服务。返回 (is_ours, pid)。"""
    existing = probe_health(host, port)
    if existing and existing.get("ok") and existing.get("service") == SERVICE_NAME:
        return True, existing.get("pid")
    return False, None


def main(argv=None) -> int:
    import argparse

    dc._configure_stdio()
    p = argparse.ArgumentParser(
        prog="capture_server.py",
        description="dsh-capture-server — DSH 陪玩插件的本地 HTTP 截图服务（127.0.0.1，零第三方依赖）",
        epilog="接口：GET /health、GET /capture?count=3&intervalMs=300&maxLongEdge=1280&quality=72&outDir=<绝对目录>",
    )
    p.add_argument("--host", default=DEFAULT_HOST, help=f"监听地址（默认 {DEFAULT_HOST}）")
    p.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"监听端口（默认 {DEFAULT_PORT}，0=随机）")
    p.add_argument("--outdir", default=None, help="默认输出目录（请求未带 outDir 时使用；默认 <脚本目录>/shots）")
    p.add_argument("--quality", type=int, default=82, help="默认 JPEG 质量（默认 82）")
    p.add_argument("--max-long-edge", type=int, default=1600, help="默认输出长边上限（默认 1600）")
    p.add_argument("--prefix", default="cap", help="输出文件名前缀（默认 cap）")
    args = p.parse_args(argv)

    base_opts = dict(dc.DEFAULT_OPTIONS)
    base_opts.update(
        {
            "mode": "desktop",
            "monitor": "primary",
            "outdir": str(Path(args.outdir).resolve()) if args.outdir else str((SCRIPT_DIR / "shots").resolve()),
            "quality": args.quality,
            "max_side": args.max_long_edge,
            "prefix": args.prefix,
            "base64": False,
            "save": True,
        }
    )
    CaptureRequestHandler.base_opts = base_opts

    # 初始化（DPI 感知必须在任何坐标读取前；GDI+ 常驻初始化）
    dc.init_dpi_awareness()
    try:
        dc._gdiplus_startup()
    except dc.CaptureError as e:
        _log(f"GDI+ 初始化失败: {e.message}")
        return 1
    # 预热：把显示器枚举 / 窗口查询 / 空闲时间这些首次调用的驱动级开销提前吃掉，
    # 这样插件第一次 /window 也是 0-2ms 级，而不是冷启动的 ~80ms。
    try:
        dc.environment_info()
        fg = dc.get_foreground_window()
        if fg:
            dc.get_window_info(fg, fg)
        dc.get_idle_seconds()
    except Exception:  # noqa: BLE001 - 预热失败不影响服务
        pass

    # 单实例锁：先探测端口，避免 Windows 上 SO_REUSEADDR 导致的“假 bind 成功”
    if args.port != 0 and port_is_open(args.host, args.port):
        is_ours, existing_pid = _resolve_existing_instance(args.host, args.port)
        if is_ours:
            _log(
                f"{args.host}:{args.port} 上已有本服务在运行（pid={existing_pid}），"
                f"单实例锁生效，直接退出 0"
            )
            return 0
        _log(f"启动失败：{args.host}:{args.port} 已被其他程序占用（/health 不是本服务）")
        return 1

    try:
        httpd = ThreadingHTTPServer((args.host, args.port), CaptureRequestHandler)
    except OSError as e:
        is_ours, existing_pid = _resolve_existing_instance(args.host, args.port)
        if is_ours:
            _log(f"{args.host}:{args.port} 上已有本服务在运行（pid={existing_pid}），单实例锁生效，退出 0")
            return 0
        _log(f"启动失败：无法监听 {args.host}:{args.port} — {e}（端口已被其他程序占用？）")
        return 1
    httpd.daemon_threads = True
    actual_port = httpd.server_address[1]
    _log(f"dsh-capture-server v{dc.__version__} listening on http://{args.host}:{actual_port}")
    _log(f"默认输出目录: {base_opts['outdir']}")
    # 给宿主/插件一行可解析的启动信息（stdout，一行 JSON）
    sys.stdout.write(
        json.dumps(
            {
                "ok": True,
                "event": "listening",
                "service": SERVICE_NAME,
                "version": API_VERSION,
                "host": args.host,
                "port": actual_port,
                "pid": os.getpid(),
            },
            ensure_ascii=True,
        )
        + "\n"
    )
    sys.stdout.flush()
    try:
        httpd.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        _log("收到中断，退出")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
