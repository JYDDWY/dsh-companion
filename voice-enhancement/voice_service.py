#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""voice_service.py — 「看屏幕陪聊」语音链路本地 HTTP 服务

链路：文字 -> edge-tts / Windows SAPI -> RVC 变声（常驻 worker 子进程）-> sounddevice 播放

同一个文件既是 HTTP 服务，也是 RVC 常驻 worker（后者由服务内部以
``python voice_service.py --rvc-worker`` 启动）。HTTP 服务默认监听
127.0.0.1:9123，JSON API：

    GET  /health   服务/GPU/RVC 就绪状态、声线数、TTS 模式、输出设备、情绪表
    GET  /voices   声线清单（id、中文名、是否带 index、是否已加载）
    POST /speak    {text, voiceId?, pitch?, speed?, interrupt?, emotion?} -> {id, queued}
    POST /stop     清空队列并立即停止播放
    GET  /status   队列 / 正在播放 / 最近任务 / 最近错误 / 耗时统计
    POST /render   调试用：{text, voiceId?, pitch?, speed?, emotion?} 只合成不播放，
                   返回 TTS/RVC 音频路径与耗时（供情绪量化验证脚本使用）
    POST /shutdown 优雅退出（调试用）

``emotion`` 可选：neutral（缺省，旧行为）| happy | excited | tsukkomi | serious |
gentle | surprised | smug | sigh；未知值按 neutral 处理。实现见 emotion_prosody.py。

启动（必须用带 sounddevice/torch 的 Python；插件的一键安装会准备好独立环境）：

    python voice_service.py --port 9123 --host 127.0.0.1

手动部署时可用环境变量指定 RVC 工程与解释器：

    RVC_HOME=<RVC 工程目录> RVC_PYTHON=<带 torch 的 python.exe> python voice_service.py

edge-tts 装在服务目录下的 pydeps 里，脚本会自动把它加入 sys.path；
也可以手动把该目录加入 PYTHONPATH。

只读引用 RVC 工程：不修改、不依赖其运行状态；RVC 的 `infer/` 模块以
import 方式复用（Pipeline / VC / hubert / rmvpe），模型只在 worker 里加载一次。
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import collections
import json
import logging
import logging.handlers
import math
import os
import queue
import re
import subprocess
import sys
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# ---------------------------------------------------------------------------
# 路径 / 全局常量
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent
LOGS_DIR = ROOT / "logs"
SAMPLES_DIR = ROOT / "samples"
WORK_DIR = ROOT / "work"
PYDEPS_DIR = ROOT / "pydeps"
for _d in (LOGS_DIR, SAMPLES_DIR, WORK_DIR, PYDEPS_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# edge-tts 等额外包装在 pydeps，必须在 import edge_tts 之前生效
if str(PYDEPS_DIR) not in sys.path:
    sys.path.insert(0, str(PYDEPS_DIR))
# 同目录模块（服务与 RVC worker 都以本文件所在目录为脚本目录，这里再兜底一次）
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
import emotion_prosody as ep  # noqa: E402  （情绪韵律计划：纯标准库，见 emotion_prosody.py）

RVC_HOME = Path(
    os.environ.get("RVC_HOME", str(ROOT / "rvc"))
)
RVC_PYTHON = os.environ.get(
    "RVC_PYTHON",
    sys.executable,
)

VERSION = "1.1.0"
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0

# 声线表：id -> 展示名 / edge-tts 输入音色 / 默认变调（半音）
# 女声角色用 Xiaoxiao，男声角色用 Yunxi（RVC 会保留输入基频、只换音色）
# name 与集成契约一致：角色名 · 出处
VOICE_TABLE = collections.OrderedDict(
    [
        ("march7", {"name": "三月七 · 崩坏：星穹铁道", "ttsVoice": "zh-CN-XiaoxiaoNeural", "pitch": 0}),
        ("firefly", {"name": "流萤 · 崩坏：星穹铁道", "ttsVoice": "zh-CN-XiaoxiaoNeural", "pitch": 0}),
        ("hutao", {"name": "胡桃 · 原神", "ttsVoice": "zh-CN-XiaoyiNeural", "pitch": 0}),
        ("nahida", {"name": "纳西妲 · 原神", "ttsVoice": "zh-CN-XiaoyiNeural", "pitch": 0}),
        ("furina", {"name": "芙宁娜 · 原神", "ttsVoice": "zh-CN-XiaoxiaoNeural", "pitch": 0}),
        ("ayaka", {"name": "神里绫华 · 原神", "ttsVoice": "zh-CN-XiaoxiaoNeural", "pitch": 0}),
        ("shogun", {"name": "雷电将军 · 原神", "ttsVoice": "zh-CN-XiaoxiaoNeural", "pitch": 0}),
        ("manbo", {"name": "曼波", "ttsVoice": "zh-CN-YunxiNeural", "pitch": 0}),
        ("xuejie", {"name": "学姐", "ttsVoice": "zh-CN-XiaoxiaoNeural", "pitch": 0}),
        ("young_male", {"name": "青年男声", "ttsVoice": "zh-CN-YunxiNeural", "pitch": 0}),
        ("patrick", {"name": "派大星", "ttsVoice": "zh-CN-YunxiNeural", "pitch": 0}),
    ]
)

DEFAULT_CONFIG = {
    "host": "127.0.0.1",
    "port": 9123,
    "device": "",              # 输出设备名子串；空 = 取系统默认，若是 CABLE 自动换真实扬声器
    "defaultVoice": "march7",
    "speed": 1.0,
    "pitch": 0,
    "f0Method": "rmvpe",
    "indexRate": 0.75,
    "protect": 0.33,
    "tts": "auto",             # auto | edge | sapi
    "maxChars": 2000,
    "maxQueuedSentences": 8,   # 队列上限（句）：超过则拒绝新请求，避免无限堆积
    "rvcModelCache": 3,        # RVC 声线模型 LRU 数（不是启动时全部加载）
    "preloadDefaultVoice": True,  # 后台预热时是否预加载默认声线（其余声线按需加载）
    "logFile": "",             # 空 = logs/service.log；插件可用 --log-file 或重定向 stdout
    "logLevel": "INFO",
}

TTS_SR = 16000  # RVC 输入统一采样率


# ---------------------------------------------------------------------------
# 日志
# ---------------------------------------------------------------------------

LOG_FILE = Path(
    os.environ.get("VOICE_SERVICE_LOG_FILE") or (LOGS_DIR / "service.log")
)  # 集成契约：默认日志写 logs/service.log


def setup_logging(level: str = "INFO", to_file: bool = True, log_file: Path | None = None) -> logging.Logger:
    logger = logging.getLogger("voice_service")
    logger.setLevel(getattr(logging, str(level).upper(), logging.INFO))
    logger.handlers.clear()
    fmt = logging.Formatter(
        "%(asctime)s %(levelname)-7s [%(threadName)-12s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    # pythonw 下 sys.stdout 可能是 None；插件拉起时 stdout/stderr 可被重定向
    stream = sys.stdout
    if stream is not None:
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass
        handler = logging.StreamHandler(stream)
        handler.setFormatter(fmt)
        logger.addHandler(handler)
    if to_file:
        try:
            path = Path(log_file) if log_file else LOG_FILE
            path.parent.mkdir(parents=True, exist_ok=True)
            fh = logging.handlers.RotatingFileHandler(
                path,
                maxBytes=5 * 1024 * 1024,
                backupCount=3,
                encoding="utf-8",
            )
            fh.setFormatter(fmt)
            logger.addHandler(fh)
        except Exception:
            pass
    rvc_log = logging.getLogger("rvc_worker")
    rvc_log.setLevel(logging.INFO)
    rvc_log.handlers.clear()
    rvc_log.propagate = False
    try:
        fh2 = logging.handlers.RotatingFileHandler(
            LOGS_DIR / "rvc_worker.log",
            maxBytes=5 * 1024 * 1024,
            backupCount=2,
            encoding="utf-8",
        )
        fh2.setFormatter(fmt)
        rvc_log.addHandler(fh2)
    except Exception:
        pass
    return logger


LOG = setup_logging()


# ---------------------------------------------------------------------------
# 文本处理
# ---------------------------------------------------------------------------

_URL_RE = re.compile(r"https?://\S+")
_EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\u2600-\u27BF\uFE0F\u200D\u2B50\u2705\u274C]+"
)
_MD_RE = re.compile(r"[*_#>`|~～]+")
_MD_LINK_RE = re.compile(r"\[([^\[\]]*)\]\([^()]*\)")
# 括号舞台提示（（笑）（小声）【系统提示】[动作] 等）整段去掉，换成停顿
_BRACKET_RE = re.compile(r"[（(【\[{｛][^（）()【】\[\]{}｛｝]{0,60}[）)】\]}｝]")
_OPEN_BRACKET_RE = re.compile(r"[（(【\[{｛][^（）()【】\[\]{}｛｝]{0,60}$", re.M)
_ZERO_WIDTH_RE = re.compile("[\u200b-\u200f\u202a-\u202e\ufeff]")
_MULTI_PUNCT_RE = re.compile(r"([。！？!?，,、；;：:…])\1+")
_CJK_RE = re.compile(r"[\u3400-\u9fff\uf900-\ufaff]")


def sanitize_text(text: str) -> str:
    """TTS 前清洗：链接、markdown、emoji、括号舞台提示、控制字符、重复标点。

    规则（README 同步）：
      - 去掉 http(s) 链接、[文字](链接) 里的链接部分（保留文字）
      - 去掉 markdown 标记 * _ # > ` | ~ 和代码围栏
      - 去掉 emoji 与零宽/方向控制字符
      - 去掉成对括号（中英文圆括号/方括号/花括号）内的舞台提示或音效注释
      - 合并重复标点、压缩空白；保留正文、引号与正常标点
    """
    text = str(text or "")
    text = _ZERO_WIDTH_RE.sub("", text)
    text = _MD_LINK_RE.sub(r"\1", text)
    text = _URL_RE.sub(" ", text)
    text = text.replace("```", " ")
    text = _BRACKET_RE.sub("，", text)
    text = _OPEN_BRACKET_RE.sub("", text)
    text = _MD_RE.sub("", text)
    text = _EMOJI_RE.sub("", text)
    text = _MULTI_PUNCT_RE.sub(r"\1", text)
    text = re.sub(r"[，,、；;：:]+(?=[。！？!?])", "", text)  # 括号删除后残留的 "，。"
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t\u3000]+", " ", text)
    text = re.sub(r"^[，,、；;：:\s]+", "", text)
    text = re.sub(r"[，,、；;：:\s]+$", "", text)
    return text.strip()


def _visible_len(text: str) -> int:
    return len(re.sub(r"[^\w\u3400-\u9fff]", "", text))


def split_sentences(text: str, max_len: int = 60, min_len: int = 4) -> list[str]:
    """按中英文句末标点切句，过短的碎片并到相邻句，过长的句子再按逗号切。"""
    text = sanitize_text(text)
    if not text:
        return []
    pieces: list[str] = []
    for part in re.split(r"(?<=[。！？!?；;…])", text):
        part = part.strip().strip("。")  # 去掉纯句末标点残片
        if part and _visible_len(part) > 0:
            pieces.append(part)
    if not pieces:
        pieces = [text]
    merged: list[str] = []
    for part in pieces:
        if merged and (_visible_len(merged[-1]) < min_len or _visible_len(part) < min_len):
            merged[-1] = merged[-1] + part
        else:
            merged.append(part)
    out: list[str] = []
    for part in merged:
        while len(part) > max_len:
            cut = max((part.rfind(c) for c in "，,、：:；;"), default=-1)
            if cut < max_len // 3:
                cut = max_len - 1
            out.append(part[: cut + 1].strip())
            part = part[cut + 1 :].strip()
        if part:
            out.append(part)
    # 去掉开头数字序号（"1." "2、" 之类，SAPI 会念出来）
    cleaned = []
    for part in out:
        part = re.sub(r"^[\s]*\d{1,2}[.、)）]\s*", "", part).strip()
        if part and _visible_len(part) > 0:
            cleaned.append(part)
    return cleaned


# ---------------------------------------------------------------------------
# TTS
# ---------------------------------------------------------------------------

class TtsError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# 情绪合成用的小工具（分句拼接；与 TtsEngine 分开，便于单测）
# ---------------------------------------------------------------------------

_EMOTION_RETRY_DELAYS = (0.6, 1.5)  # 分句请求失败后的重试间隔（秒）
_EMOTION_CLAUSE_TIMEOUT = 45.0
_EMOTION_FADE_MS = 12
_EMOTION_PAUSE_LEVEL = 0.0012  # ≈ -58 dBFS，避免分句之间是刺耳的数字静音


def _trim_silence(data, sr: int, margin_ms: int = 8):
    """裁掉分句首尾静音（保留 margin），让分句之间的停顿完全由情绪计划控制。"""
    import numpy as np

    if len(data) == 0:
        return data
    peak = float(np.max(np.abs(data)))
    if peak <= 0:
        return data
    threshold = max(0.004, peak * 0.02)
    indices = np.where(np.abs(data) > threshold)[0]
    if len(indices) == 0:
        return data
    margin = int(sr * margin_ms / 1000)
    start = max(0, int(indices[0]) - margin)
    end = min(len(data), int(indices[-1]) + margin + 1)
    return data[start:end]


def _fade_edges(data, sr: int, fade_ms: int = _EMOTION_FADE_MS):
    """给分句首尾做短淡入淡出，避免硬拼时出现咔哒/爆音。"""
    import numpy as np

    if len(data) == 0:
        return data
    n = min(int(sr * fade_ms / 1000), len(data) // 4)
    if n <= 1:
        return data
    out = np.asarray(data, dtype=np.float32).copy()
    ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
    out[:n] *= ramp
    out[-n:] *= ramp[::-1]
    return out


def _low_level_pause(samples: int, level: float = _EMOTION_PAUSE_LEVEL):
    """分句间停顿：用低电平底噪代替纯零，再淡入淡出；贴近自然气口。"""
    import numpy as np

    if samples <= 0:
        return np.zeros(0, dtype=np.float32)
    rng = np.random.default_rng(20261023)
    pad = (rng.standard_normal(samples) * level).astype(np.float32)
    n = min(int(samples // 4), max(1, int(samples * 0.02)))
    if n > 0:
        ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
        pad[:n] *= ramp
        pad[-n:] *= ramp[::-1]
    return pad


def append_tail_silence(wav_path, ms: int) -> float:
    """在 wav 末尾补 ms 毫秒低电平停顿（句间停顿），返回新的时长（秒）。"""
    import numpy as np

    if ms <= 0:
        data, sr = read_wav_mono(wav_path)
        return round(len(data) / sr, 3) if sr else 0.0
    data, sr = read_wav_mono(wav_path)
    # 只淡出句尾，别削掉句首辅音；随后接低电平底噪。
    if len(data) > 8:
        n = min(int(sr * 8 / 1000), len(data) // 4)
        if n > 1:
            data = np.asarray(data, dtype=np.float32).copy()
            data[-n:] *= np.linspace(0.0, 1.0, n, dtype=np.float32)[::-1]
    pad = _low_level_pause(int(round(sr * ms / 1000.0)))
    out = np.concatenate([data, pad]) if len(data) else pad
    write_wav(wav_path, out, sr)
    return round(len(out) / sr, 3)


class TtsEngine:
    """edge-tts 优先；不可用/断网时自动回退 Windows SAPI（System.Speech）。"""

    def __init__(self, cfg: dict, logger: logging.Logger):
        self.cfg = cfg
        self.log = logger
        self.mode = str(cfg.get("tts", "auto")).lower()
        self.edge_available = False
        self.edge_import_error: str | None = None
        try:
            import edge_tts  # noqa: F401

            self.edge_available = True
        except Exception as exc:  # pragma: no cover - 断网/没装包
            self.edge_import_error = f"{type(exc).__name__}: {exc}"
            self.log.warning("edge-tts 不可用（%s），将使用 Windows SAPI", self.edge_import_error)
        self.edge_ok: bool | None = None
        self.edge_cooldown_until = 0.0
        self.edge_last_error: str | None = None
        self.sapi_available = os.name == "nt" and shutil_which("powershell.exe") is not None
        self.last_engine: str | None = None
        self.last_error: str | None = None
        self.timings: collections.deque = collections.deque(maxlen=50)
        # 情绪合成诊断（进 /health）
        self.emotion_fallbacks = 0
        self.last_emotion_error: str | None = None
        self.last_first_audio_ms: float | None = None
        self.last_clauses = 0

    # -- public ---------------------------------------------------------
    def synthesize(
        self,
        text: str,
        voice_id: str,
        speed: float,
        out_path: Path,
        emotion: str = "neutral",
        sentence_pos: float = 0.5,
    ) -> dict:
        """合成一段文字；emotion 缺省/未知 = neutral，走与旧版完全相同的路径。

        sentence_pos：当前句在整段任务里的位置（0=第一句，1=最后一句），
        用于叠加情绪计划里的「整段话语调走向」；单句任务传 0.5。
        """
        plan = ep.resolve_emotion(emotion)
        tts_voice = voice_meta(voice_id)["ttsVoice"]
        t0 = time.perf_counter()
        engine = None
        applied = "neutral"
        extra: dict = {}
        if self.mode in ("auto", "edge") and self.edge_available and self._edge_allowed():
            try:
                if plan.id != "neutral":
                    try:
                        extra = self._edge_synthesize_emotive(
                            text, tts_voice, speed, plan, out_path, sentence_pos
                        )
                        applied = plan.id
                    except Exception as exc:
                        # 情绪路径失败（分句/限流等）不能把整条 edge 判死：
                        # 先退回旧版单请求保证能出声，再决定是否整条链路冷却。
                        self.emotion_fallbacks += 1
                        self.last_emotion_error = f"{type(exc).__name__}: {exc}"
                        self.log.warning(
                            "情绪合成失败（emotion=%s），回退普通 edge-tts 单请求：%s",
                            plan.id,
                            self.last_emotion_error,
                        )
                        extra = self._edge_synthesize(text, tts_voice, speed, out_path)
                        applied = "neutral"
                else:
                    extra = self._edge_synthesize(text, tts_voice, speed, out_path)
                engine = "edge-tts"
                self.edge_ok = True
            except Exception as exc:
                self.edge_ok = False
                self.edge_cooldown_until = time.time() + 60.0
                self.edge_last_error = f"{type(exc).__name__}: {exc}"
                self.last_error = self.edge_last_error
                self.log.warning("edge-tts 失败，回退 SAPI：%s", self.edge_last_error)
        if engine is None:
            if not self.sapi_available:
                raise TtsError(
                    "edge-tts 不可用且当前系统没有 Windows SAPI；无法合成语音。"
                    f"edge 错误：{self.edge_last_error or self.edge_import_error}"
                )
            self._sapi_synthesize(text, tts_voice, speed, out_path)
            engine = "sapi"
            applied = "neutral"  # SAPI 回退没有情绪韵律
            extra = {}
        data, sr = read_wav_mono(out_path)
        if sr != TTS_SR:
            data = resample(data, sr, TTS_SR)
            sr = TTS_SR
        peak = float(abs(data).max()) if len(data) else 0.0
        if peak > 0:
            data = data * (0.9 / max(peak, 1e-6))
        write_wav(out_path, data, TTS_SR)
        ms = (time.perf_counter() - t0) * 1000.0
        self.last_engine = engine
        self.timings.append(ms)
        first_audio = extra.get("firstAudioMs")
        self.last_first_audio_ms = first_audio
        self.last_clauses = int(extra.get("clauses") or 1)
        return {
            "engine": engine,
            "ms": round(ms, 1),
            "sampleRate": TTS_SR,
            "duration": round(len(data) / TTS_SR, 3),
            "path": str(out_path),
            "emotion": plan.id,
            "emotionApplied": applied,
            "firstAudioMs": round(first_audio, 1) if first_audio else None,
            "clauses": int(extra.get("clauses") or 1),
            "segments": extra.get("segments"),
        }

    def info(self) -> dict:
        return {
            "mode": self.mode,
            "engine": self.last_engine or ("edge-tts" if self.edge_ok else "pending"),
            "edgeAvailable": self.edge_available,
            "edgeImportError": self.edge_import_error,
            "edgeLastError": self.edge_last_error,
            "edgeCooldownSec": round(max(0.0, self.edge_cooldown_until - time.time()), 1),
            "sapiAvailable": self.sapi_available,
            "lastError": self.last_error,
            "lastMs": round(self.timings[-1], 1) if self.timings else None,
            "emotionFallbacks": self.emotion_fallbacks,
            "lastEmotionError": self.last_emotion_error,
            "lastFirstAudioMs": self.last_first_audio_ms,
            "lastClauses": self.last_clauses,
        }

    # -- edge -----------------------------------------------------------
    def _edge_allowed(self) -> bool:
        if self.mode == "edge":
            return True
        if self.edge_ok is False and time.time() < self.edge_cooldown_until:
            return False
        return True

    def _edge_synthesize(self, text: str, tts_voice: str, speed: float, out_path: Path) -> dict:
        """旧版单请求路径（无情绪）。返回 TTS 首包耗时，供 /render 报告用。"""
        import edge_tts

        rate = int(round((float(speed) - 1.0) * 100))
        rate = max(-50, min(100, rate))
        rate_str = f"{rate:+d}%"
        mp3_path = out_path.with_suffix(".mp3")
        t0 = time.perf_counter()
        first_audio: list[float] = []

        async def _run() -> None:
            communicate = edge_tts.Communicate(text, tts_voice, rate=rate_str)
            with open(mp3_path, "wb") as fh:
                async for chunk in communicate.stream():
                    if chunk.get("type") == "audio":
                        if not first_audio:
                            first_audio.append((time.perf_counter() - t0) * 1000.0)
                        fh.write(chunk["data"])

        async def _guarded() -> None:
            await asyncio.wait_for(_run(), timeout=45.0)

        asyncio.run(_guarded())
        data, sr = read_wav_mono(mp3_path)  # soundfile/libsndfile 直接解 mp3
        if len(data) == 0:
            raise TtsError("edge-tts 返回空音频")
        if sr != TTS_SR:
            data = resample(data, sr, TTS_SR)
        write_wav(out_path, data, TTS_SR)
        return {"firstAudioMs": first_audio[0] if first_audio else None}

    # -- edge 情绪韵律 ----------------------------------------------------
    async def _edge_clause_synthesize_async(
        self, seg: dict, tts_voice: str, mp3_path: Path, t0: float
    ) -> float:
        """合成一个分句（带重试），返回该分句的首包耗时 ms。"""
        import edge_tts

        last_exc: Exception | None = None
        attempts = len(_EMOTION_RETRY_DELAYS) + 1
        for attempt in range(attempts):
            first: float | None = None
            total = 0
            try:
                communicate = edge_tts.Communicate(
                    str(seg["text"]),
                    tts_voice,
                    rate=f"{int(seg['rate']):+d}%",
                    pitch=f"{int(seg['pitch']):+d}Hz",
                    volume=f"{int(seg['volume']):+d}%",
                )
                with open(mp3_path, "wb") as fh:
                    async with asyncio.timeout(_EMOTION_CLAUSE_TIMEOUT):
                        async for chunk in communicate.stream():
                            if chunk.get("type") == "audio":
                                if first is None:
                                    first = time.perf_counter() - t0
                                fh.write(chunk["data"])
                                total += len(chunk["data"])
                if total > 0 and first is not None:
                    return first * 1000.0
                last_exc = TtsError("edge-tts 分句返回空音频")
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
            if attempt < attempts - 1:
                await asyncio.sleep(_EMOTION_RETRY_DELAYS[attempt])
        raise TtsError(f"分句合成失败：{type(last_exc).__name__}: {last_exc}")

    def _edge_synthesize_emotive(
        self,
        text: str,
        tts_voice: str,
        speed: float,
        plan,
        out_path: Path,
        sentence_pos: float = 0.5,
    ) -> dict:
        """情绪韵律：分句并行合成 -> 裁首尾静音 -> 按情绪插入段间停顿后拼接。

        每个分句带 emotion_prosody 算出的 rate/pitch/volume 偏移，段落之间插
        情绪专属停顿；相比整句一次合成，分句请求是并发的，首包延迟基本不变。
        失败抛异常，由 synthesize() 回退旧版单请求。
        """
        import numpy as np

        segments = ep.build_segments(text, plan, speed, sentence_pos)
        if not segments:
            raise TtsError("情绪合成分句为空")
        t0 = time.perf_counter()
        mp3_paths = [
            out_path.with_name(f"{out_path.stem}_e{i}.mp3") for i in range(len(segments))
        ]

        async def _all() -> list:
            tasks = [
                asyncio.create_task(
                    self._edge_clause_synthesize_async(seg, tts_voice, mp3_paths[i], t0)
                )
                for i, seg in enumerate(segments)
            ]
            return await asyncio.gather(*tasks)

        try:
            first_ms = asyncio.run(asyncio.wait_for(_all(), timeout=120.0))
            pieces = []
            for i, seg in enumerate(segments):
                data, sr = read_wav_mono(mp3_paths[i])
                if len(data) == 0:
                    raise TtsError(f"分句 {i} 音频为空")
                if sr != TTS_SR:
                    data = resample(data, sr, TTS_SR)
                pieces.append(_fade_edges(_trim_silence(data, TTS_SR), TTS_SR))
                pause = int(seg.get("pauseAfterMs") or 0)
                if pause > 0 and i < len(segments) - 1:
                    pieces.append(_low_level_pause(int(round(TTS_SR * pause / 1000.0))))
            audio = np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)
            if len(audio) == 0:
                raise TtsError("情绪拼接后音频为空")
            write_wav(out_path, audio, TTS_SR)
            return {
                "firstAudioMs": min(first_ms) if first_ms else None,
                "clauses": len(segments),
                "segments": segments,
            }
        finally:
            for path in mp3_paths:
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass

    # -- sapi -----------------------------------------------------------
    def _sapi_synthesize(self, text: str, tts_voice: str, speed: float, out_path: Path) -> None:
        rate = int(round((float(speed) - 1.0) * 10))
        rate = max(-10, min(10, rate))
        if out_path.exists():
            out_path.unlink()
        text_b64 = base64.b64encode(text.encode("utf-8")).decode("ascii")
        out_sql = str(out_path).replace("'", "''")
        script = f"""Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$zh = $s.GetInstalledVoices() | Where-Object {{ $_.VoiceInfo.Culture.Name -like 'zh*' }} | Select-Object -First 1
if ($zh) {{ $s.SelectVoice($zh.VoiceInfo.Name) }}
$s.Rate = {rate}
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile('{out_sql}', $fmt)
$s.Speak([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{text_b64}')))
$s.Dispose()
"""
        encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
        try:
            proc = subprocess.run(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-EncodedCommand",
                    encoded,
                ],
                capture_output=True,
                timeout=90,
                creationflags=CREATE_NO_WINDOW,
            )
        except FileNotFoundError as exc:
            raise TtsError(f"调用 PowerShell SAPI 失败：{exc}") from exc
        if proc.returncode != 0 or not out_path.exists():
            err = (proc.stderr or b"").decode("utf-8", "replace")[:400]
            raise TtsError(f"SAPI 合成失败（rc={proc.returncode}）：{err}")


def shutil_which(name: str) -> str | None:
    import shutil

    return shutil.which(name)


# ---------------------------------------------------------------------------
# 音频小工具（soundfile + 简易重采样，避免服务侧 import librosa/torch）
# ---------------------------------------------------------------------------

def read_wav_mono(path) -> tuple:
    import numpy as np
    import soundfile as sf

    data, sr = sf.read(str(path), dtype="float32", always_2d=False)
    data = np.asarray(data, dtype=np.float32)
    if data.ndim > 1:
        data = data.mean(axis=1)
    return data, int(sr)


def write_wav(path, data, sr: int) -> None:
    import numpy as np
    import soundfile as sf

    data = np.asarray(data, dtype=np.float32)
    sf.write(str(path), data, int(sr), subtype="PCM_16")


def resample(data, source_sr: int, target_sr: int):
    import numpy as np

    if source_sr == target_sr or len(data) == 0:
        return np.asarray(data, dtype=np.float32)
    try:
        from scipy.signal import resample_poly
        from math import gcd

        g = gcd(int(source_sr), int(target_sr))
        out = resample_poly(data, int(target_sr) // g, int(source_sr) // g)
        return np.asarray(out, dtype=np.float32)
    except Exception:
        n = int(round(len(data) * target_sr / source_sr))
        if n <= 0:
            return np.zeros(0, dtype=np.float32)
        x_old = np.linspace(0.0, 1.0, len(data), endpoint=False)
        x_new = np.linspace(0.0, 1.0, n, endpoint=False)
        return np.interp(x_new, x_old, data).astype(np.float32)


def audio_stats(data) -> dict:
    import numpy as np

    if len(data) == 0:
        return {"peak": 0.0, "rms": 0.0, "duration": 0.0}
    peak = float(np.max(np.abs(data)))
    rms = float(np.sqrt(np.mean(np.square(data, dtype=np.float64))))
    return {"peak": round(peak, 5), "rms": round(rms, 5)}


# ---------------------------------------------------------------------------
# 输出设备选择 / 播放
# ---------------------------------------------------------------------------

VIRTUAL_MARKERS = ("cable", "vb-audio", "vb audio", "voicemeeter", "virtual", "点")


class AudioOutputError(RuntimeError):
    pass


class AudioOutput:
    def __init__(self, preferred: str = "", logger: logging.Logger | None = None):
        self.log = logger or LOG
        self.preferred = (preferred or "").strip()
        self.index: int | None = None
        self.device: dict | None = None
        self.hostapi_name: str = ""
        self.error: str | None = None
        self.last_play_ms: float | None = None
        self._playing_started = 0.0
        self._resolve()

    # -- device discovery ----------------------------------------------
    @staticmethod
    def _is_virtual(name: str) -> bool:
        low = (name or "").lower()
        return any(marker in low for marker in VIRTUAL_MARKERS)

    def _list(self):
        import sounddevice as sd

        apis = sd.query_hostapis()
        result = []
        for idx, dev in enumerate(sd.query_devices()):
            if dev.get("max_output_channels", 0) <= 0:
                continue
            api = apis[dev["hostapi"]]["name"] if dev["hostapi"] < len(apis) else ""
            result.append(
                {
                    "index": idx,
                    "name": dev["name"],
                    "hostapi": api,
                    "channels": int(dev["max_output_channels"]),
                    "default_samplerate": int(dev["default_samplerate"]),
                    "virtual": self._is_virtual(dev["name"]),
                }
            )
        return result

    @staticmethod
    def _score(dev: dict) -> float:
        score = 0.0
        api = dev["hostapi"].lower()
        if "wasapi" in api:
            score += 50
        elif "mme" in api:
            score += 10
        elif "directsound" in api:
            score += 6
        name = dev["name"].lower()
        if "speaker" in name or "扬声器" in name:
            score += 10
        if "headphone" in name or "耳机" in name:
            score += 10
        if dev["channels"] >= 2:
            score += 2
        if dev["default_samplerate"] >= 44100:
            score += 1
        return score

    def _resolve(self) -> None:
        import sounddevice as sd

        try:
            outs = self._list()
        except Exception as exc:
            self.error = f"枚举音频输出设备失败：{exc}"
            raise AudioOutputError(self.error) from exc
        if not outs:
            self.error = "没有可用的音频输出设备（扬声器/耳机都没找到）"
            raise AudioOutputError(self.error)

        real = [d for d in outs if not d["virtual"]]
        chosen: dict | None = None
        reason = ""

        # 1) 显式配置的设备名 / 索引
        if self.preferred:
            matches = [
                d
                for d in outs
                if self.preferred.lower() in d["name"].lower()
                or self.preferred == str(d["index"])
            ]
            real_matches = [d for d in matches if not d["virtual"]]
            if real_matches:
                chosen = max(real_matches, key=self._score)
                reason = f"配置指定（{self.preferred}）"
            elif matches:
                self.log.warning(
                    "配置的输出设备 %r 是虚拟声卡（CABLE/虚拟设备），已拒绝以免回录；自动挑真实扬声器",
                    self.preferred,
                )
            if chosen is None:
                self.log.warning("配置的输出设备 %r 没找到，改用自动选择", self.preferred)

        # 2) 系统默认输出设备（真实设备的话优先尊重用户选择）
        if chosen is None:
            try:
                default_out = sd.default.device[1]
                dev = sd.query_devices(default_out)
                if dev.get("max_output_channels", 0) > 0 and not self._is_virtual(dev["name"]):
                    apis = sd.query_hostapis()
                    api = apis[dev["hostapi"]]["name"] if dev["hostapi"] < len(apis) else ""
                    chosen = {
                        "index": default_out,
                        "name": dev["name"],
                        "hostapi": api,
                        "channels": int(dev["max_output_channels"]),
                        "default_samplerate": int(dev["default_samplerate"]),
                        "virtual": False,
                    }
                    reason = "系统默认输出设备"
                elif dev.get("max_output_channels", 0) > 0:
                    self.log.warning(
                        "系统默认输出设备是虚拟声卡 %r（可能开着全局 RVC 路由），自动改用真实扬声器",
                        dev["name"],
                    )
            except Exception as exc:
                self.log.debug("读取系统默认输出设备失败：%s", exc)

        # 3) 评分最高（WASAPI 真实扬声器/耳机优先）
        if chosen is None:
            if not real:
                self.error = (
                    "只找到虚拟声卡（CABLE 等），没有真实扬声器/耳机。"
                    "请检查耳机或扬声器连接，或用 device 配置指定设备名。"
                )
                raise AudioOutputError(self.error)
            chosen = max(real, key=self._score)
            reason = "自动评分（优先 WASAPI 真实扬声器/耳机）"

        self.index = chosen["index"]
        self.device = chosen
        self.hostapi_name = chosen["hostapi"]

        # 验证：能否以 mono float32 打开
        ok_rate = None
        for rate in (48000, 44100, chosen["default_samplerate"], 24000, 16000):
            try:
                sd.check_output_settings(
                    device=self.index, channels=1, samplerate=int(rate), dtype="float32"
                )
                ok_rate = int(rate)
                break
            except Exception as exc:
                self.log.debug("输出设备 %s 不支持 %s Hz：%s", self.index, rate, exc)
        if ok_rate is None:
            self.error = (
                f"输出设备 {chosen['name']}（index={self.index}）无法以 mono float32 打开。"
                f"可用输出设备：{', '.join(d['name'] + '#' + str(d['index']) for d in outs)}"
            )
            raise AudioOutputError(self.error)
        self.log.info(
            "播放设备：%s（index=%s, hostapi=%s, %s, %s Hz）",
            chosen["name"],
            self.index,
            chosen["hostapi"],
            reason,
            ok_rate,
        )

    def info(self) -> dict:
        if self.device is None:
            return {"error": self.error}
        return {
            "index": self.index,
            "name": self.device["name"],
            "hostapi": self.device["hostapi"],
            "channels": self.device["channels"],
            "defaultSamplerate": self.device["default_samplerate"],
            "virtual": bool(self.device["virtual"]),
        }

    # -- playback -------------------------------------------------------
    def play(self, wav_path, cancel_event: threading.Event, volume: float = 1.0) -> dict:
        import numpy as np
        import sounddevice as sd

        if self.index is None:
            raise AudioOutputError(self.error or "输出设备未就绪")
        data, sr = read_wav_mono(wav_path)
        if len(data) == 0:
            raise AudioOutputError(f"音频文件为空：{wav_path}")
        peak = float(np.max(np.abs(data)))
        if peak < 0.01:
            raise AudioOutputError(
                f"RVC 输出几乎静音（peak={peak:.4f}）：{wav_path}"
            )
        data = data.copy()
        # 支持采样率：设备不支持时重采样到设备默认采样率
        try:
            sd.check_output_settings(
                device=self.index, channels=1, samplerate=int(sr), dtype="float32"
            )
        except Exception:
            target = int(self.device["default_samplerate"]) if self.device else 48000
            data = resample(data, sr, target)
            sr = target
        # 5ms 淡入淡出，避免爆音
        fade = min(len(data) // 2, max(1, int(sr * 0.005)))
        if fade > 0:
            ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
            data[:fade] *= ramp
            data[-fade:] *= ramp[::-1]
        # 陪玩自己的音量（0-2）；缩放后限幅，避免削波
        try:
            gain = float(volume)
        except (TypeError, ValueError):
            gain = 1.0
        if abs(gain - 1.0) > 0.001:
            data = np.clip(data * max(0.0, min(2.0, gain)), -1.0, 1.0)
        t0 = time.perf_counter()
        self._playing_started = time.time()
        try:
            sd.play(
                data,
                int(sr),
                device=self.index,
                blocking=False,
                latency="low",
            )
        except Exception as exc:
            raise AudioOutputError(f"打开输出设备失败（{self.device['name']}）：{exc}") from exc
        try:
            stream = sd.get_stream()
            while stream is not None and stream.active:
                if cancel_event.is_set():
                    sd.stop()
                    break
                time.sleep(0.02)
        finally:
            sd.stop()
        self.last_play_ms = round((time.perf_counter() - t0) * 1000.0, 1)
        return {"duration": round(len(data) / sr, 3), "sampleRate": int(sr), "playMs": self.last_play_ms}

    def stop(self) -> None:
        try:
            import sounddevice as sd

            sd.stop()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# RVC 常驻 worker（子进程；与 HTTP 服务同文件 --rvc-worker 模式）
# ---------------------------------------------------------------------------

class RvcError(RuntimeError):
    pass


class RvcClient:
    """拉起 `voice_service.py --rvc-worker`，JSON-lines 协议常驻推理。"""

    def __init__(
        self,
        cfg: dict,
        logger: logging.Logger,
        python: str = RVC_PYTHON,
        script: Path | None = None,
    ):
        self.cfg = cfg
        self.log = logger
        self.python = python
        self.script = str(script or Path(__file__).resolve())
        self.proc: subprocess.Popen | None = None
        self.ready_event = threading.Event()
        self.ready_error: str | None = None
        self.info: dict = {}
        self.last_error: str | None = None
        self.stderr_tail: collections.deque = collections.deque(maxlen=40)
        self.restarts = 0
        self._pending: dict[str, dict] = {}
        self._pending_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._lifecycle_lock = threading.Lock()
        self._call_lock = threading.Lock()
        self.spawned_at = 0.0
        self.cold_start_ms: float | None = None

    # -- 进程管理 -------------------------------------------------------
    def _spawn_locked(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            return
        env = os.environ.copy()
        env["PYTHONPATH"] = str(PYDEPS_DIR) + (
            os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else ""
        )
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUNBUFFERED"] = "1"
        env["RVC_CUDA_GRAPH"] = "0"
        env["PYTHONDONTWRITEBYTECODE"] = "1"  # 不往只读的 RVC 工程里写 .pyc
        env["HF_HUB_OFFLINE"] = "1"
        env["TRANSFORMERS_OFFLINE"] = "1"
        cmd = [self.python, self.script, "--rvc-worker"]
        cmd += ["--default-voice", str(self.cfg.get("defaultVoice", "march7"))]
        cmd += ["--rvc-cache", str(int(self.cfg.get("rvcModelCache", 3)))]
        if not self.cfg.get("preloadDefaultVoice", True):
            cmd.append("--no-preload")
        self.ready_event.clear()
        self.ready_error = None
        self.spawned_at = time.time()
        self.log.info("启动 RVC worker：%s", " ".join(cmd))
        try:
            self.proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=str(RVC_HOME),
                env=env,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                creationflags=CREATE_NO_WINDOW,
            )
        except Exception as exc:
            self.proc = None
            self.ready_error = f"无法启动 RVC worker：{exc}"
            self.ready_event.set()
            raise RvcError(self.ready_error) from exc
        threading.Thread(target=self._read_stdout, name="rvc-stdout", daemon=True).start()
        threading.Thread(target=self._read_stderr, name="rvc-stderr", daemon=True).start()

    def _read_stdout(self) -> None:
        proc = self.proc
        if proc is None or proc.stdout is None:
            return
        for raw in proc.stdout:
            line = (raw or "").strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                self.log.debug("RVC worker stdout（非 JSON）：%s", line[:300])
                continue
            if "event" in msg:
                event = msg.get("event")
                if event == "ready":
                    self.info = msg
                    self.info["stages"] = {
                        key: msg.get(key)
                        for key in (
                            "importMs",
                            "configMs",
                            "hubertLoadMs",
                            "rmvpeLoadMs",
                            "defaultModelLoadMs",
                            "warmupInferMs",
                            "readyTotalMs",
                            "preloaded",
                        )
                    }
                    self.cold_start_ms = round((time.time() - self.spawned_at) * 1000.0, 1)
                    self.info["coldStartMs"] = self.cold_start_ms
                    self.ready_event.set()
                    self.log.info(
                        "RVC worker 就绪：%s 冷启动 %.1f 秒（%s）",
                        msg.get("device"),
                        self.cold_start_ms / 1000.0,
                        msg.get("gpu", ""),
                    )
                elif event == "fatal":
                    self.ready_error = str(msg.get("error", "RVC worker 初始化失败"))
                    self.last_error = self.ready_error
                    self.ready_event.set()
                    self.log.error("RVC worker 初始化失败：%s", self.ready_error)
                else:
                    self.log.debug("RVC worker 事件：%s", msg)
                continue
            rid = msg.get("id")
            with self._pending_lock:
                waiter = self._pending.pop(rid, None)
            if waiter is not None:
                waiter["resp"] = msg
                waiter["event"].set()
            else:
                self.log.debug("RVC worker 未知响应：%s", line[:300])
        # EOF：进程退出
        with self._pending_lock:
            waiters = list(self._pending.values())
            self._pending.clear()
        for waiter in waiters:
            waiter["resp"] = {"ok": False, "error": "RVC worker 进程已退出"}
            waiter["event"].set()
        self.ready_event.clear()
        self.log.warning("RVC worker 进程退出（code=%s）", proc.poll())

    def _read_stderr(self) -> None:
        proc = self.proc
        if proc is None or proc.stderr is None:
            return
        log = logging.getLogger("rvc_worker")
        for raw in proc.stderr:
            line = (raw or "").rstrip()
            if not line:
                continue
            self.stderr_tail.append(line)
            log.info("%s", line)
            low = line.lower()
            if "traceback (most recent call last)" in low or " error:" in low or line.startswith("ERROR"):
                self.last_error = line[:500]

    def ensure_ready(self, timeout: float = 240.0) -> None:
        with self._lifecycle_lock:
            alive = self.proc is not None and self.proc.poll() is None
            if not alive:
                if self.proc is not None:
                    self.restarts += 1
                self._spawn_locked()
        if not self.ready_event.wait(timeout):
            raise RvcError(
                f"RVC worker {timeout:.0f}s 内未就绪；stderr："
                + " | ".join(list(self.stderr_tail)[-5:])
            )
        if self.ready_error:
            raise RvcError(self.ready_error)

    # -- 推理调用 -------------------------------------------------------
    def infer(self, req: dict, timeout: float = 240.0) -> dict:
        self.ensure_ready()
        rid = uuid.uuid4().hex[:12]
        payload = dict(req)
        payload["id"] = rid
        payload["op"] = "infer"
        waiter = {"event": threading.Event(), "resp": None}
        with self._pending_lock:
            self._pending[rid] = waiter
        line = json.dumps(payload, ensure_ascii=False) + "\n"
        try:
            with self._call_lock:
                with self._write_lock:
                    if self.proc is None or self.proc.stdin is None:
                        raise RvcError("RVC worker stdin 不可用")
                    self.proc.stdin.write(line)
                    self.proc.stdin.flush()
        except Exception as exc:
            with self._pending_lock:
                self._pending.pop(rid, None)
            raise RvcError(f"向 RVC worker 发送请求失败：{exc}") from exc
        if not waiter["event"].wait(timeout):
            with self._pending_lock:
                self._pending.pop(rid, None)
            raise RvcError(f"RVC 推理超时（>{timeout:.0f}s）")
        resp = waiter["resp"] or {}
        if not resp.get("ok"):
            msg = resp.get("error", "未知错误")
            self.last_error = str(msg)[:800]
            raise RvcError(str(msg))
        return resp

    def shutdown(self) -> None:
        proc = self.proc
        if proc is None:
            return
        try:
            if proc.poll() is None and proc.stdin is not None:
                try:
                    proc.stdin.write(json.dumps({"op": "shutdown"}) + "\n")
                    proc.stdin.flush()
                except Exception:
                    pass
                try:
                    proc.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    proc.terminate()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()
        finally:
            self.proc = None
            self.ready_event.clear()

    def status(self) -> dict:
        alive = self.proc is not None and self.proc.poll() is None
        return {
            "ready": bool(alive and self.ready_event.is_set() and not self.ready_error),
            "alive": alive,
            "coldStartMs": self.cold_start_ms,
            "device": self.info.get("device"),
            "isHalf": self.info.get("isHalf"),
            "gpu": self.info.get("gpu"),
            "stages": self.info.get("stages"),
            "loadedVoices": self.info.get("loadedVoices", []),
            "restarts": self.restarts,
            "lastError": self.ready_error or self.last_error,
            "stderrTail": list(self.stderr_tail)[-5:],
        }


# ---------------------------------------------------------------------------
# worker 侧：模型加载 + 推理循环
# ---------------------------------------------------------------------------

class _VoiceHolder:
    __slots__ = ("vc", "index_path", "speaker_id", "loaded_ms", "voice_id")

    def __init__(self, vc, index_path, speaker_id, loaded_ms, voice_id):
        self.vc = vc
        self.index_path = index_path
        self.speaker_id = speaker_id
        self.loaded_ms = loaded_ms
        self.voice_id = voice_id


class RvcWorker:
    """常驻 worker：Config/hubert/rmvpe 只加载一次，声线模型 LRU 复用。

    preload=False 时启动阶段不加载任何声线模型（首次 infer 才加载），
    用于尽量缩短后台预热时间；其余声线始终按需加载。
    """

    def __init__(self, cache_size: int = 3, default_voice: str = "march7", preload: bool = True):
        self.cache_size = max(1, int(cache_size))
        self.default_voice = default_voice
        self.preload = bool(preload)
        self.log = logging.getLogger("rvc_worker")
        self.log.setLevel(logging.INFO)
        self.holders: "collections.OrderedDict[str, _VoiceHolder]" = collections.OrderedDict()
        self.cfg = None
        self.hubert = None
        self.rmvpe = None
        self.cold: dict = {}
        self._t_start = time.perf_counter()
        self._load_import()

    # -- 初始化 ---------------------------------------------------------
    def _load_import(self) -> None:
        t0 = time.perf_counter()
        sys.path.insert(0, str(RVC_HOME))
        os.chdir(str(RVC_HOME))
        os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
        os.environ.setdefault("weight_root", str(RVC_HOME / "assets" / "weights"))
        os.environ.setdefault("index_root", str(RVC_HOME / "logs"))
        os.environ.setdefault("outside_index_root", str(RVC_HOME / "assets" / "indices"))
        os.environ.setdefault("rmvpe_root", str(RVC_HOME / "assets" / "rmvpe"))
        os.environ["RVC_CUDA_GRAPH"] = "0"
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

        import numpy as np

        import torch
        from configs.config import Config
        from infer.hubert import load_hubert_model
        from infer.rmvpe import RMVPE
        from infer.vc.modules import VC, normalized_speaker_info
        from infer.vc.utils import get_index_path_from_model

        self.np = np
        self.torch = torch
        self.Config = Config
        self.VC = VC
        self.load_hubert_model = load_hubert_model
        self.RMVPE = RMVPE
        self.normalized_speaker_info = normalized_speaker_info
        self.get_index_path_from_model = get_index_path_from_model
        self.cold["importMs"] = round((time.perf_counter() - t0) * 1000.0, 1)

    def initialize(self) -> dict:
        t0 = time.perf_counter()
        argv_backup = sys.argv
        sys.argv = [sys.argv[0]]
        try:
            self.cfg = self.Config()
        finally:
            sys.argv = argv_backup
        self.cold["configMs"] = round((time.perf_counter() - t0) * 1000.0, 1)

        t0 = time.perf_counter()
        self.hubert = self.load_hubert_model(self.cfg.device, self.cfg.is_half)
        self.cold["hubertLoadMs"] = round((time.perf_counter() - t0) * 1000.0, 1)

        t0 = time.perf_counter()
        self.rmvpe = self.RMVPE(
            str(RVC_HOME / "assets" / "rmvpe" / "rmvpe.pt"),
            is_half=self.cfg.is_half,
            device=self.cfg.device,
        )
        self.cold["rmvpeLoadMs"] = round((time.perf_counter() - t0) * 1000.0, 1)

        # 可选：预加载默认声线并做一次 warmup（触发 cudnn/内核初始化）
        if self.preload:
            t0 = time.perf_counter()
            self.get_voice(self.default_voice)
            self.cold["defaultModelLoadMs"] = round((time.perf_counter() - t0) * 1000.0, 1)

            warmup = WORK_DIR / "warmup_16k.wav"
            warmup_out = WORK_DIR / "warmup_rvc.wav"
            np = self.np
            sr = TTS_SR
            t = np.arange(int(sr * 1.0), dtype=np.float32) / sr
            tone = (0.12 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
            write_wav(warmup, tone, sr)
            t0 = time.perf_counter()
            self.infer(
                {
                    "voiceId": self.default_voice,
                    "input": str(warmup),
                    "output": str(warmup_out),
                }
            )
            self.cold["warmupInferMs"] = round((time.perf_counter() - t0) * 1000.0, 1)
            for path in (warmup, warmup_out):
                try:
                    path.unlink(missing_ok=True)
                except Exception:
                    pass
        else:
            self.cold["defaultModelLoadMs"] = 0.0
            self.cold["warmupInferMs"] = 0.0
        self.cold["preloaded"] = self.preload

        self.cold["readyTotalMs"] = round((time.perf_counter() - self._t_start) * 1000.0, 1)
        self.cold["device"] = str(self.cfg.device)
        self.cold["isHalf"] = bool(self.cfg.is_half)
        try:
            self.cold["gpu"] = (
                self.torch.cuda.get_device_name(0) if self.torch.cuda.is_available() else "CPU"
            )
        except Exception:
            self.cold["gpu"] = "unknown"
        self.cold["torch"] = self.torch.__version__
        self.cold["voices"] = list(VOICE_TABLE.keys())
        self.cold["loadedVoices"] = list(self.holders.keys())
        return dict(self.cold)

    # -- 声线加载 -------------------------------------------------------
    def _voice_path(self, voice_id: str) -> Path:
        return RVC_HOME / "assets" / "weights" / f"{voice_id}.pth"

    def _indices(self) -> dict:
        result = {}
        for voice_id in VOICE_TABLE:
            path = RVC_HOME / "assets" / "indices" / f"{voice_id}.index"
            if path.is_file():
                result[voice_id] = str(path)
        return result

    def get_voice(self, voice_id: str) -> _VoiceHolder:
        holder = self.holders.get(voice_id)
        if holder is not None:
            self.holders.move_to_end(voice_id)
            holder.loaded_ms = 0.0
            return holder
        if voice_id not in VOICE_TABLE:
            raise RvcError(f"未知声线：{voice_id}")
        model_path = self._voice_path(voice_id)
        if not model_path.is_file():
            raise RvcError(f"声线模型不存在：{model_path}")
        t0 = time.perf_counter()
        os.environ["weight_root"] = str(model_path.parent)
        vc = self.VC(self.cfg)
        vc.get_vc(model_path.name)
        vc.hubert_model = self.hubert
        index_path = ""
        try:
            idx = self.get_index_path_from_model(model_path.name, 0)
            if idx and Path(idx).is_file():
                index_path = idx
        except Exception as exc:
            self.log.warning("查找 %s 的 index 失败：%s", voice_id, exc)
        speaker_id = 0
        try:
            info = self.normalized_speaker_info(vc.cpt, int(vc.cpt["config"][-3]))
            if info:
                speaker_id = int(info[0]["id"])
        except Exception:
            pass
        # 复用已加载的 RMVPE，避免每次换声线重新加载
        if self.rmvpe is not None:
            try:
                vc.pipeline.model_rmvpe = self.rmvpe
            except Exception:
                pass
        holder = _VoiceHolder(
            vc=vc,
            index_path=index_path,
            speaker_id=speaker_id,
            loaded_ms=round((time.perf_counter() - t0) * 1000.0, 1),
            voice_id=voice_id,
        )
        self.holders[voice_id] = holder
        self.holders.move_to_end(voice_id)
        while len(self.holders) > self.cache_size:
            old_id, old = self.holders.popitem(last=False)
            self._evict(old_id, old)
        return holder

    def _evict(self, voice_id: str, holder: _VoiceHolder) -> None:
        self.log.info("回收声线模型 %s", voice_id)
        try:
            from tools.cuda_graph import clear_cuda_graph_cache

            clear_cuda_graph_cache(holder.vc.net_g)
        except Exception:
            pass
        try:
            holder.vc.net_g = None
            holder.vc.pipeline = None
            holder.vc.cpt = None
            holder.vc = None
        except Exception:
            pass
        try:
            if self.torch.cuda.is_available():
                self.torch.cuda.empty_cache()
        except Exception:
            pass

    def loaded_voices(self) -> list[str]:
        return list(self.holders.keys())

    # -- 单次推理 -------------------------------------------------------
    def infer(self, req: dict) -> dict:
        np = self.np
        voice_id = str(req.get("voiceId") or self.default_voice)
        input_path = req.get("input")
        output_path = req.get("output")
        if not input_path or not output_path:
            raise RvcError("infer 需要 input 与 output")
        if not Path(input_path).is_file():
            raise RvcError(f"输入音频不存在：{input_path}")
        t0 = time.perf_counter()
        holder = self.get_voice(voice_id)
        load_ms = holder.loaded_ms
        t1 = time.perf_counter()
        pitch = int(req.get("pitch") or 0)
        f0_method = str(req.get("f0Method") or "rmvpe")
        index_rate = float(req.get("indexRate", 0.75))
        if not holder.index_path:
            index_rate = 0.0
        protect = float(req.get("protect", 0.33))
        resample_sr = int(req.get("resampleSr") or 0)
        rms_mix_rate = float(req.get("rmsMixRate", 1.0))
        status, result = holder.vc.vc_single(
            holder.speaker_id,
            str(input_path),
            pitch,
            f0_method,
            holder.index_path,
            index_rate,
            resample_sr,
            rms_mix_rate,
            protect,
        )
        t2 = time.perf_counter()
        if not result or result[0] is None or result[1] is None:
            raise RvcError(f"RVC 推理失败：{status}")
        sr, audio = result
        audio = np.asarray(audio)
        samples = audio.astype(np.float32) / 32768.0
        write_wav(output_path, samples, int(sr))
        stats = audio_stats(samples)
        stats["duration"] = round(len(samples) / float(sr), 3)
        return {
            "ok": True,
            "output": str(output_path),
            "sampleRate": int(sr),
            "duration": stats["duration"],
            "peak": stats["peak"],
            "rms": stats["rms"],
            "rvcMs": round((time.perf_counter() - t0) * 1000.0, 1),
            "modelLoadMs": load_ms,
            "inferCoreMs": round((t2 - t1) * 1000.0, 1),
            "voiceId": voice_id,
            "speakerId": holder.speaker_id,
            "indexPath": holder.index_path,
            "indexRate": index_rate,
            "loadedVoices": self.loaded_voices(),
            "status": status,
        }


def rvc_worker_main() -> int:
    """worker 进程入口：stdout 只走 JSON-lines 协议，库日志全部重定向到 stderr。"""
    proto = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr  # 防止任何库 print 污染协议
    logging.basicConfig(
        level=logging.INFO,
        stream=sys.stderr,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    def emit(obj) -> None:
        try:
            proto.write(json.dumps(obj, ensure_ascii=False) + "\n")
            proto.flush()
        except Exception:
            pass

    cache_size = 3
    default_voice = "march7"
    preload = True
    for i, arg in enumerate(sys.argv):
        if arg == "--rvc-cache" and i + 1 < len(sys.argv):
            cache_size = int(sys.argv[i + 1])
        if arg == "--default-voice" and i + 1 < len(sys.argv):
            default_voice = sys.argv[i + 1]
        if arg == "--no-preload":
            preload = False

    worker = None
    try:
        worker = RvcWorker(cache_size=cache_size, default_voice=default_voice, preload=preload)
        info = worker.initialize()
        emit({"event": "ready", **info})
    except Exception:
        err = traceback.format_exc()
        emit({"event": "fatal", "error": err[-3000:]})
        return 1

    log = logging.getLogger("rvc_worker")
    for raw in sys.stdin:
        line = (raw or "").strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        op = req.get("op", "infer")
        if op == "shutdown":
            break
        if op == "ping":
            emit({"id": req.get("id"), "ok": True, "pong": True,
                  "loadedVoices": worker.loaded_voices()})
            continue
        if op == "preload":
            try:
                holder = worker.get_voice(str(req.get("voiceId")))
                emit({"id": req.get("id"), "ok": True, "voiceId": req.get("voiceId"),
                      "modelLoadMs": holder.loaded_ms,
                      "loadedVoices": worker.loaded_voices()})
            except Exception as exc:
                emit({"id": req.get("id"), "ok": False,
                      "error": f"{type(exc).__name__}: {exc}"})
            continue
        rid = req.get("id")
        try:
            resp = worker.infer(req)
            resp["id"] = rid
            emit(resp)
        except Exception as exc:
            log.warning("推理请求失败：%s", traceback.format_exc())
            emit({
                "id": rid,
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
            })
    return 0


# ---------------------------------------------------------------------------
# 任务模型 / 语音服务核心
# ---------------------------------------------------------------------------

@dataclass
class Sentence:
    index: int
    text: str
    status: str = "pending"
    tts_ms: float | None = None
    rvc_ms: float | None = None
    tts_engine: str | None = None
    tts_first_audio_ms: float | None = None
    tts_emotion_applied: str | None = None
    duration: float | None = None
    audio_path: str | None = None
    sample_rate: int | None = None
    error: str | None = None
    started_at: float | None = None
    played_at: float | None = None


@dataclass
class Job:
    id: str
    text: str
    voice_id: str
    pitch: int
    speed: float
    generation: int
    emotion: str = "neutral"
    volume: float = 1.0
    created_at: float = field(default_factory=time.time)
    created_perf: float = field(default_factory=time.perf_counter)
    status: str = "queued"
    sentences: list = field(default_factory=list)
    error: str | None = None
    first_audio_ms: float | None = None
    done_ms: float | None = None
    finished_at: float | None = None
    played: int = 0

    def brief(self, include_text: bool = True) -> dict:
        data = {
            "id": self.id,
            "status": self.status,
            "voiceId": self.voice_id,
            "pitch": self.pitch,
            "speed": self.speed,
            "emotion": self.emotion,
            "createdAt": round(self.created_at, 3),
            "queued": len(self.sentences),
            "played": self.played,
            "firstAudioMs": round(self.first_audio_ms, 1) if self.first_audio_ms else None,
            "doneMs": round(self.done_ms, 1) if self.done_ms else None,
            "error": self.error,
        }
        if include_text:
            data["text"] = self.text[:300]
            data["sentences"] = [
                {
                    "index": s.index,
                    "text": s.text[:300],
                    "status": s.status,
                    "ttsMs": round(s.tts_ms, 1) if s.tts_ms is not None else None,
                    "rvcMs": round(s.rvc_ms, 1) if s.rvc_ms is not None else None,
                    "ttsEngine": s.tts_engine,
                    "ttsFirstAudioMs": s.tts_first_audio_ms,
                    "ttsEmotionApplied": s.tts_emotion_applied,
                    "duration": s.duration,
                    "sampleRate": s.sample_rate,
                    "audioPath": s.audio_path,
                    "error": s.error,
                }
                for s in self.sentences
            ]
        return data


def _summary(values) -> dict:
    vals = [float(v) for v in values if v is not None]
    if not vals:
        return {"count": 0}
    vals_sorted = sorted(vals)
    p50 = vals_sorted[len(vals_sorted) // 2]
    return {
        "count": len(vals),
        "avg": round(sum(vals) / len(vals), 1),
        "p50": round(p50, 1),
        "min": round(min(vals), 1),
        "max": round(max(vals), 1),
        "last": round(vals[-1], 1),
    }


class _PlayItem:
    __slots__ = ("job", "sentence", "generation")

    def __init__(self, job: Job, sentence: Sentence, generation: int):
        self.job = job
        self.sentence = sentence
        self.generation = generation


class VoiceService:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.log = LOG
        self.lock = threading.RLock()
        self.started_at = time.time()
        self.generation = 0
        self.stop_event = threading.Event()
        self.shutdown_event = threading.Event()
        self.current_play: dict | None = None
        self.jobs_queue: "queue.Queue[Job]" = queue.Queue()
        self.play_queue: "queue.Queue[_PlayItem]" = queue.Queue()
        self.jobs: "collections.OrderedDict[str, Job]" = collections.OrderedDict()
        self.history: collections.deque = collections.deque(maxlen=30)
        self.errors: collections.deque = collections.deque(maxlen=30)
        self.stats = {
            "speakRequests": 0,
            "sentencesSpoken": 0,
            "jobsCompleted": 0,
            "jobsFailed": 0,
            "jobsStopped": 0,
            "jobsRejected": 0,
            "tts": collections.deque(maxlen=100),
            "rvc": collections.deque(maxlen=100),
            "firstAudio": collections.deque(maxlen=100),
            "play": collections.deque(maxlen=100),
        }
        self.indices = self._scan_indices()
        self.voice_loaded: list[str] = []
        self.last_timings: dict = {"ttsMs": None, "rvcMs": None, "totalMs": None}
        # 早于 RVC worker 就绪前也能如实回答 cuda（nvidia-smi 约 0.1s，不 import torch）
        self.cuda_available, self.gpu_name = self._detect_gpu()

        self.tts = TtsEngine(cfg, self.log)
        self.output_error: str | None = None
        try:
            self.output: AudioOutput | None = AudioOutput(cfg.get("device", ""), self.log)
        except AudioOutputError as exc:
            self.output = None
            self.output_error = str(exc)
            self.log.error("输出设备初始化失败：%s", exc)
        except Exception as exc:
            self.output = None
            self.output_error = f"{type(exc).__name__}: {exc}"
            self.log.error("输出设备初始化失败：%s", self.output_error)

        self.rvc = RvcClient(cfg, self.log)
        self._rvc_boot_thread = threading.Thread(
            target=self._boot_rvc, name="rvc-boot", daemon=True
        )
        self._rvc_boot_thread.start()

        self.producer_thread = threading.Thread(
            target=self._produce_loop, name="producer", daemon=True
        )
        self.producer_thread.start()
        self.player_thread = threading.Thread(
            target=self._play_loop, name="player", daemon=True
        )
        self.player_thread.start()

        self._cleanup_work_dir()

    # -- 基础信息 -------------------------------------------------------
    @staticmethod
    def _scan_indices() -> dict:
        out = {}
        for voice_id in VOICE_TABLE:
            path = RVC_HOME / "assets" / "indices" / f"{voice_id}.index"
            if path.is_file():
                out[voice_id] = str(path)
        return out

    def _cleanup_work_dir(self) -> None:
        now = time.time()
        removed = 0
        try:
            for path in WORK_DIR.glob("*"):
                if path.is_file() and now - path.stat().st_mtime > 6 * 3600:
                    path.unlink(missing_ok=True)
                    removed += 1
        except Exception:
            pass
        if removed:
            self.log.info("清理 work 目录旧文件 %d 个", removed)

    @staticmethod
    def _detect_gpu() -> tuple[bool, str]:
        """启动早期用 nvidia-smi 判断 CUDA（RVC worker 还在预热时 /health 也能报 cuda）。"""
        try:
            proc = subprocess.run(
                ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
                capture_output=True,
                timeout=5,
                text=True,
                creationflags=CREATE_NO_WINDOW,
            )
            if proc.returncode == 0:
                lines = [line.strip() for line in (proc.stdout or "").splitlines() if line.strip()]
                if lines:
                    return True, lines[0]
        except Exception:
            pass
        return False, "CPU"

    def _boot_rvc(self) -> None:
        try:
            self.rvc.ensure_ready(timeout=300.0)
            self.voice_loaded = self.rvc.info.get("loadedVoices", [])
            self.log.info(
                "RVC 链路就绪：冷启动 %.1fs（import %.0fms / hubert %.0fms / rmvpe %.0fms"
                " / 默认声线 %.0fms / warmup %.0fms）",
                (self.rvc.cold_start_ms or 0) / 1000.0,
                self.rvc.info.get("stages", {}).get("importMs", 0),
                self.rvc.info.get("stages", {}).get("hubertLoadMs", 0),
                self.rvc.info.get("stages", {}).get("rmvpeLoadMs", 0),
                self.rvc.info.get("stages", {}).get("defaultModelLoadMs", 0),
                self.rvc.info.get("stages", {}).get("warmupInferMs", 0),
            )
        except Exception as exc:
            self.log.error("RVC 链路启动失败：%s", exc)

    def _record_error(self, scope: str, message: str) -> None:
        self.errors.append(
            {
                "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "scope": scope,
                "message": str(message)[:800],
            }
        )
        self.log.error("[%s] %s", scope, message)

    def _voice_id_or_alias(self, value: str | None) -> str | None:
        if not value:
            return None
        value = str(value).strip()
        if value in VOICE_TABLE:
            return value
        for voice_id, meta in VOICE_TABLE.items():
            if meta["name"] == value:
                return voice_id
        lowered = value.lower()
        for voice_id in VOICE_TABLE:
            if voice_id.lower() == lowered:
                return voice_id
        return None

    def _voice_list(self) -> list[dict]:
        """集成契约：/voices 与 /health.voices 都用 [{id, name, index}]。"""
        rvc_status = self.rvc.status()
        loaded = set(rvc_status.get("loadedVoices", []))
        return [
            {
                "id": voice_id,
                "name": meta["name"],
                "index": voice_id in self.indices,
                "loaded": voice_id in loaded,
                "ttsVoice": meta["ttsVoice"],
                "defaultPitch": meta["pitch"],
                "indexPath": self.indices.get(voice_id, ""),
            }
            for voice_id, meta in VOICE_TABLE.items()
        ]

    def _tts_engine_name(self) -> str:
        """契约字段 tts: "edge" | "sapi"。"""
        if self.tts.mode == "sapi":
            return "sapi"
        if self.tts.edge_available and self.tts.edge_ok is not False:
            return "edge"
        return "sapi"

    def _output_device_name(self) -> str:
        if self.output is None:
            return ""
        return str(self.output.device["name"]) if self.output.device else ""

    def _pending_sentences(self) -> int:
        """尚未播放完的句子数（用于队列上限与 /status.queued）。"""
        with self.lock:
            count = 0
            for job in self.jobs.values():
                if job.status not in ("queued", "processing", "speaking"):
                    continue
                for sentence in job.sentences:
                    if sentence.status in ("pending", "tts", "rvc", "ready", "playing"):
                        count += 1
            return count

    # -- HTTP 使用的方法 -------------------------------------------------
    def health(self) -> dict:
        rvc_status = self.rvc.status()
        output_info = self.output.info() if self.output else {"error": self.output_error}
        voices = self._voice_list()
        if rvc_status.get("device"):
            cuda = bool(str(rvc_status["device"]).startswith("cuda"))
        else:
            cuda = self.cuda_available
        return {
            # —— 集成契约字段 ——
            "ok": True,
            "cuda": cuda,
            "tts": self._tts_engine_name(),
            "voices": voices,
            "outputDevice": self._output_device_name(),
            # —— 附加诊断字段 ——
            "version": VERSION,
            "gpu": rvc_status.get("gpu") or self.gpu_name,
            "ready": bool(rvc_status.get("ready")),
            "voiceCount": len(voices),
            "defaultVoice": self.cfg.get("defaultVoice"),
            "ttsDetail": self.tts.info(),
            "outputDeviceDetail": output_info,
            "rvc": rvc_status,
            # —— 情绪（emotion）能力 ——
            "emotions": list(ep.EMOTION_IDS),
            "emotionTable": ep.emotion_table(),
            "emotionFallbacks": self.tts.emotion_fallbacks,
            "lastEmotionError": self.tts.last_emotion_error,
            "queues": {
                "pendingJobs": self.jobs_queue.qsize(),
                "audioItems": self.play_queue.qsize(),
                "pendingSentences": self._pending_sentences(),
            },
            "playing": self.current_play is not None,
            "uptimeSec": round(time.time() - self.started_at, 1),
        }

    def voices(self) -> list[dict]:
        return self._voice_list()

    def status(self) -> dict:
        with self.lock:
            current = dict(self.current_play) if self.current_play else None
            running = [
                job.brief()
                for job in self.jobs.values()
                if job.status in ("queued", "processing", "speaking")
            ]
            recent = [job.brief() for job in self.history]
            last_timings = dict(self.last_timings)
        last_error = self.errors[-1] if self.errors else None
        return {
            # —— 集成契约字段 ——
            "ok": True,
            "speaking": current is not None,
            "queued": self._pending_sentences(),
            "lastTimings": last_timings,
            "lastError": last_error["message"] if last_error else None,
            "outputDevice": self._output_device_name(),
            # —— 附加诊断字段 ——
            "playing": current,
            "queues": {
                "pendingJobs": self.jobs_queue.qsize(),
                "audioItems": self.play_queue.qsize(),
                "pendingSentences": self._pending_sentences(),
            },
            "currentJob": running[0]["id"] if running else None,
            "jobs": running,
            "recent": recent[:10],
            "lastErrorDetail": last_error,
            "rvc": self.rvc.status(),
            "tts": self.tts.info(),
            "outputDeviceDetail": self.output.info() if self.output else {"error": self.output_error},
            "stats": {
                "speakRequests": self.stats["speakRequests"],
                "sentencesSpoken": self.stats["sentencesSpoken"],
                "jobsCompleted": self.stats["jobsCompleted"],
                "jobsFailed": self.stats["jobsFailed"],
                "jobsStopped": self.stats["jobsStopped"],
                "jobsRejected": self.stats["jobsRejected"],
                "ttsMs": _summary(self.stats["tts"]),
                "rvcMs": _summary(self.stats["rvc"]),
                "firstAudioMs": _summary(self.stats["firstAudio"]),
                "playMs": _summary(self.stats["play"]),
                "errors": len(self.errors),
            },
            "uptimeSec": round(time.time() - self.started_at, 1),
        }

    def speak(self, payload: dict) -> tuple[dict, int]:
        text = sanitize_text(str(payload.get("text") or ""))
        if not text:
            return {"ok": False, "error": "text 不能为空"}, 400
        if len(text) > self.cfg["maxChars"]:
            return {
                "ok": False,
                "error": f"text 过长（{len(text)} > {self.cfg['maxChars']} 字符），请拆成多次 speak",
            }, 400
        requested_voice = payload.get("voiceId") or payload.get("voice")
        voice_id = self._voice_id_or_alias(requested_voice) if requested_voice else None
        if requested_voice and voice_id is None:
            return {
                "ok": False,
                "error": f"未知 voiceId：{requested_voice}",
                "voices": list(VOICE_TABLE.keys()),
            }, 400
        voice_id = voice_id or self.cfg["defaultVoice"]
        try:
            pitch = int(payload.get("pitch", voice_meta(voice_id)["pitch"]))
        except (TypeError, ValueError):
            return {"ok": False, "error": "pitch 必须是整数"}, 400
        try:
            speed = float(payload.get("speed", self.cfg.get("speed", 1.0)))
        except (TypeError, ValueError):
            return {"ok": False, "error": "speed 必须是数字"}, 400
        speed = max(0.5, min(2.0, speed))
        pitch = max(-24, min(24, pitch))
        # emotion 可选：缺省/未知值按 neutral 处理（neutral = 与旧版完全一致）
        raw_emotion = payload.get("emotion")
        emotion_plan = ep.resolve_emotion(raw_emotion)
        if raw_emotion not in (None, "") and str(raw_emotion).strip().lower() not in ep.EMOTIONS:
            self.log.info("未知 emotion=%r，按 %s 处理", raw_emotion, emotion_plan.id)
        try:
            volume = float(payload.get("volume", 1.0))
        except (TypeError, ValueError):
            return {"ok": False, "error": "volume 必须是数字（0-2）"}, 400
        volume = max(0.0, min(2.0, volume))
        interrupt = bool(payload.get("interrupt", False))
        if interrupt:
            self.stop()
        sentences = split_sentences(text)
        if not sentences:
            return {"ok": False, "error": "没有可朗读的内容"}, 400
        limit = int(self.cfg.get("maxQueuedSentences", 8))
        if len(sentences) > limit:
            self.stats["jobsRejected"] += 1
            return {
                "ok": False,
                "error": f"本次 {len(sentences)} 句超过队列上限 {limit} 句，请拆成多次 /speak",
                "queued": self._pending_sentences(),
                "limit": limit,
            }, 413
        with self.lock:
            pending = self._pending_sentences()
            if pending + len(sentences) > limit:
                self.stats["jobsRejected"] += 1
                return (
                    {
                        "ok": False,
                        "error": f"语音队列已满（{pending}/{limit} 句待播），请稍后再发或先 POST /stop",
                        "queued": pending,
                        "limit": limit,
                    },
                    429,
                )
            # 只有 /stop、interrupt 会推进 generation；普通 speak 不打断已有任务
            gen = self.generation
            if self.stop_event.is_set():
                self.stop_event.clear()
            job = Job(
                id=uuid.uuid4().hex[:10],
                text=text,
                voice_id=voice_id,
                pitch=pitch,
                speed=speed,
                generation=gen,
                emotion=emotion_plan.id,
                volume=volume,
                status="queued",
            )
            job.sentences = [Sentence(index=i, text=s) for i, s in enumerate(sentences)]
            self.jobs[job.id] = job
            self.stats["speakRequests"] += 1
        self.jobs_queue.put(job)
        self.log.info(
            "speak %s：声线=%s pitch=%s speed=%s emotion=%s 句数=%d：%s",
            job.id,
            voice_id,
            pitch,
            speed,
            job.emotion,
            len(sentences),
            text[:80],
        )
        return (
            {
                "ok": True,
                "id": job.id,
                "queued": len(sentences),
                "sentences": sentences,
                "voiceId": voice_id,
                "pitch": pitch,
                "speed": speed,
                "emotion": emotion_plan.id,
                "generation": gen,
                "interrupt": interrupt,
            },
            200,
        )

    # -- 调试 / 量化接口 -------------------------------------------------
    def render(self, payload: dict) -> tuple[dict, int]:
        """只合成不播放：TTS（含情绪韵律）-> RVC，返回逐句音频路径与耗时。

        供 emotion_eval.py / 手工量化验证使用；不进入播放队列、不影响正在播放的任务。
        """
        text = sanitize_text(str(payload.get("text") or ""))
        if not text:
            return {"ok": False, "error": "text 不能为空"}, 400
        if len(text) > self.cfg["maxChars"]:
            return {
                "ok": False,
                "error": f"text 过长（{len(text)} > {self.cfg['maxChars']} 字符），请拆成多次",
            }, 400
        requested_voice = payload.get("voiceId") or payload.get("voice")
        voice_id = self._voice_id_or_alias(requested_voice) if requested_voice else None
        if requested_voice and voice_id is None:
            return {
                "ok": False,
                "error": f"未知 voiceId：{requested_voice}",
                "voices": list(VOICE_TABLE.keys()),
            }, 400
        voice_id = voice_id or self.cfg["defaultVoice"]
        try:
            pitch = int(payload.get("pitch", voice_meta(voice_id)["pitch"]))
        except (TypeError, ValueError):
            return {"ok": False, "error": "pitch 必须是整数"}, 400
        try:
            speed = float(payload.get("speed", self.cfg.get("speed", 1.0)))
        except (TypeError, ValueError):
            return {"ok": False, "error": "speed 必须是数字"}, 400
        speed = max(0.5, min(2.0, speed))
        pitch = max(-24, min(24, pitch))
        plan = ep.resolve_emotion(payload.get("emotion"))
        sentences = split_sentences(text)
        if not sentences:
            return {"ok": False, "error": "没有可朗读的内容"}, 400
        limit = int(self.cfg.get("maxQueuedSentences", 8))
        if len(sentences) > limit:
            return {"ok": False, "error": f"本次 {len(sentences)} 句超过上限 {limit} 句"}, 413
        rid = uuid.uuid4().hex[:10]
        t_all = time.perf_counter()
        out_sentences = []
        for i, sentence_text in enumerate(sentences):
            t0 = time.perf_counter()
            tts_path = WORK_DIR / f"render_{rid}_{i:02d}_tts.wav"
            rvc_path = WORK_DIR / f"render_{rid}_{i:02d}_rvc.wav"
            tts_res = self.tts.synthesize(
                sentence_text,
                voice_id,
                speed,
                tts_path,
                emotion=plan.id,
                sentence_pos=(i / (len(sentences) - 1)) if len(sentences) > 1 else 0.5,
            )
            req = {
                "voiceId": voice_id,
                "input": str(tts_path),
                "output": str(rvc_path),
                "pitch": pitch,
                "f0Method": self.cfg.get("f0Method", "rmvpe"),
                "indexRate": float(self.cfg.get("indexRate", 0.75)),
                "protect": float(self.cfg.get("protect", 0.33)),
                "resampleSr": 0,
                "rmsMixRate": 1.0,
            }
            rvc_res = self.rvc.infer(req)
            duration = rvc_res.get("duration")
            if plan.id != "neutral" and plan.tail_pause_ms > 0:
                try:
                    new_duration = append_tail_silence(rvc_path, plan.tail_pause_ms)
                    if new_duration:
                        duration = new_duration
                except Exception as exc:  # 补静音失败不影响返回
                    self.log.warning("render 补句末停顿失败：%s", exc)
            out_sentences.append(
                {
                    "index": i,
                    "text": sentence_text,
                    "sentencePos": round(
                        (i / (len(sentences) - 1)) if len(sentences) > 1 else 0.5, 4
                    ),
                    "emotion": plan.id,
                    "emotionApplied": tts_res.get("emotionApplied"),
                    "ttsEngine": tts_res["engine"],
                    "ttsMs": tts_res["ms"],
                    "ttsFirstAudioMs": tts_res.get("firstAudioMs"),
                    "ttsClauses": tts_res.get("clauses"),
                    "ttsSegments": tts_res.get("segments"),
                    "ttsDuration": tts_res.get("duration"),
                    "rvcMs": rvc_res.get("rvcMs"),
                    "duration": duration,
                    "sampleRate": rvc_res.get("sampleRate"),
                    "tailPauseMs": plan.tail_pause_ms if plan.id != "neutral" else 0,
                    "ttsPath": str(tts_path),
                    "rvcPath": str(rvc_path),
                    "elapsedMs": round((time.perf_counter() - t0) * 1000.0, 1),
                }
            )
        return {
            "ok": True,
            "id": rid,
            "emotion": plan.id,
            "voiceId": voice_id,
            "pitch": pitch,
            "speed": speed,
            "totalMs": round((time.perf_counter() - t_all) * 1000.0, 1),
            "sentences": out_sentences,
        }, 200

    def stop(self) -> dict:
        with self.lock:
            self.generation += 1
            self.stop_event.set()
        cleared_items = 0
        while True:
            try:
                self.play_queue.get_nowait()
                cleared_items += 1
            except queue.Empty:
                break
        cleared_jobs = 0
        while True:
            try:
                job = self.jobs_queue.get_nowait()
            except queue.Empty:
                break
            cleared_jobs += 1
            with self.lock:
                if job.status in ("queued", "processing"):
                    job.status = "cancelled"
                    job.finished_at = time.time()
                    self.history.appendleft(job)
                    self.jobs.pop(job.id, None)
                    self.stats["jobsStopped"] += 1
        was_playing = self.current_play is not None
        if self.output is not None:
            self.output.stop()
        for job in list(self.jobs.values()):
            if job.status in ("processing", "speaking"):
                job.status = "cancelled"
                job.finished_at = time.time()
                self.history.appendleft(job)
                self.jobs.pop(job.id, None)
        self.log.info(
            "stop：generation=%d 清空音频 %d 段、任务 %d 个（正在播放=%s）",
            self.generation,
            cleared_items,
            cleared_jobs,
            was_playing,
        )
        return {
            "ok": True,
            "generation": self.generation,
            "clearedAudioItems": cleared_items,
            "clearedJobs": cleared_jobs,
            "wasPlaying": was_playing,
        }

    # -- 流水线 ---------------------------------------------------------
    def _job_cancelled(self, job: Job) -> bool:
        return self.shutdown_event.is_set() or job.generation != self.generation

    def _produce_loop(self) -> None:
        while not self.shutdown_event.is_set():
            try:
                job = self.jobs_queue.get(timeout=0.5)
            except queue.Empty:
                continue
            if job is None:
                continue
            if self._job_cancelled(job):
                self._finish_job(job, "cancelled")
                continue
            with self.lock:
                job.status = "processing"
            ok = True
            for sentence in job.sentences:
                if self._job_cancelled(job):
                    ok = False
                    break
                try:
                    self._process_sentence(job, sentence)
                except Exception as exc:
                    ok = False
                    sentence.status = "error"
                    sentence.error = str(exc)[:800]
                    job.error = f"第 {sentence.index + 1} 句失败：{exc}"
                    self._record_error("pipeline", f"任务 {job.id} 第 {sentence.index + 1} 句：{exc}")
                    break
                if self._job_cancelled(job):
                    ok = False
                    break
                self.play_queue.put(_PlayItem(job, sentence, job.generation))
                with self.lock:
                    if job.status == "processing":
                        job.status = "speaking"
            if not ok and job.status != "cancelled":
                for sentence in job.sentences:
                    if sentence.status == "pending":
                        sentence.status = "cancelled"
                self._finish_job(job, "failed" if job.error else "cancelled")
            elif ok:
                # 句子已全部入播放队列，等播放线程收尾
                pass

    def _process_sentence(self, job: Job, sentence: Sentence) -> None:
        t_start = time.perf_counter()
        sentence.started_at = t_start
        sentence.status = "tts"
        tts_path = WORK_DIR / f"tts_{job.id}_{sentence.index:02d}.wav"
        sentence_pos = (
            sentence.index / (len(job.sentences) - 1) if len(job.sentences) > 1 else 0.5
        )
        tts_res = self.tts.synthesize(
            sentence.text,
            job.voice_id,
            job.speed,
            tts_path,
            emotion=job.emotion,
            sentence_pos=sentence_pos,
        )
        sentence.tts_ms = tts_res["ms"]
        sentence.tts_engine = tts_res["engine"]
        sentence.tts_first_audio_ms = tts_res.get("firstAudioMs")
        sentence.tts_emotion_applied = tts_res.get("emotionApplied")
        if self._job_cancelled(job):
            sentence.status = "cancelled"
            return
        sentence.status = "rvc"
        rvc_path = WORK_DIR / f"rvc_{job.id}_{sentence.index:02d}.wav"
        req = {
            "voiceId": job.voice_id,
            "input": str(tts_path),
            "output": str(rvc_path),
            "pitch": job.pitch,
            "f0Method": self.cfg.get("f0Method", "rmvpe"),
            "indexRate": float(self.cfg.get("indexRate", 0.75)),
            "protect": float(self.cfg.get("protect", 0.33)),
            "resampleSr": 0,
            "rmsMixRate": 1.0,
        }
        rvc_res = self.rvc.infer(req)
        sentence.rvc_ms = rvc_res.get("rvcMs")
        sentence.duration = rvc_res.get("duration")
        sentence.sample_rate = rvc_res.get("sampleRate")
        # 非 neutral：在 RVC 之后的成品音频末尾补「句间停顿」，让句与句的节奏也带情绪
        plan = ep.resolve_emotion(job.emotion)
        tail_pause_ms = max(0, min(200, int(plan.tail_pause_ms)))
        if plan.id != "neutral" and tail_pause_ms > 0:
            try:
                new_duration = append_tail_silence(rvc_path, tail_pause_ms)
                if new_duration:
                    sentence.duration = new_duration
            except Exception as exc:  # 补静音失败不影响播放
                self.log.warning(
                    "任务 %s 第 %d 句补句末停顿失败：%s", job.id, sentence.index + 1, exc
                )
        sentence.audio_path = str(rvc_path)
        sentence.status = "ready"
        with self.lock:
            self.stats["tts"].append(sentence.tts_ms)
            self.stats["rvc"].append(sentence.rvc_ms)
            self.stats["sentencesSpoken"] += 1
            self.voice_loaded = rvc_res.get("loadedVoices", self.voice_loaded)
            self.last_timings = {
                "ttsMs": round(sentence.tts_ms, 1) if sentence.tts_ms is not None else None,
                "rvcMs": round(sentence.rvc_ms, 1) if sentence.rvc_ms is not None else None,
                "totalMs": round((sentence.tts_ms or 0) + (sentence.rvc_ms or 0), 1),
            }
        self.log.info(
            "任务 %s 第 %d 句完成：TTS %s %.0fms（首包 %sms，情绪 %s/%s，%d 分句）"
            " + RVC %.0fms，时长 %.2fs",
            job.id,
            sentence.index + 1,
            sentence.tts_engine,
            sentence.tts_ms,
            f"{sentence.tts_first_audio_ms:.0f}" if sentence.tts_first_audio_ms else "?",
            job.emotion,
            sentence.tts_emotion_applied,
            int(tts_res.get("clauses") or 1),
            sentence.rvc_ms or 0,
            sentence.duration or 0,
        )

    def _play_loop(self) -> None:
        while not self.shutdown_event.is_set():
            try:
                item = self.play_queue.get(timeout=0.5)
            except queue.Empty:
                continue
            if item is None:
                continue
            job, sentence = item.job, item.sentence
            if item.generation != self.generation:
                sentence.status = "cancelled"
                continue
            if self.output is None:
                sentence.status = "error"
                sentence.error = self.output_error or "输出设备不可用"
                job.error = sentence.error
                self._record_error("playback", sentence.error)
                self._finish_job(job, "failed")
                continue
            sentence.status = "playing"
            with self.lock:
                if job.first_audio_ms is None:
                    job.first_audio_ms = (time.perf_counter() - job.created_perf) * 1000.0
                    self.stats["firstAudio"].append(job.first_audio_ms)
                self.current_play = {
                    "jobId": job.id,
                    "sentenceIndex": sentence.index,
                    "sentenceCount": len(job.sentences),
                    "text": sentence.text[:200],
                    "voiceId": job.voice_id,
                    "duration": sentence.duration,
                    "elapsedMs": None,
                }
            t0 = time.perf_counter()
            try:
                res = self.output.play(sentence.audio_path, self.stop_event, volume=getattr(job, "volume", 1.0))
                sentence.status = "played"
                sentence.played_at = time.time()
                with self.lock:
                    self.stats["play"].append(res.get("playMs"))
                self.log.info(
                    "播放完成 任务 %s 第 %d/%d 句：%.2fs @ %dHz（播放调用 %.0fms）",
                    job.id,
                    sentence.index + 1,
                    len(job.sentences),
                    res.get("duration") or 0,
                    res.get("sampleRate") or 0,
                    res.get("playMs") or 0,
                )
            except Exception as exc:
                sentence.status = "error"
                sentence.error = str(exc)
                job.error = str(exc)
                self._record_error("playback", f"任务 {job.id} 第 {sentence.index + 1} 句：{exc}")
            finally:
                with self.lock:
                    self.current_play = None
                    job.played += 1
                if self._job_cancelled(job):
                    self._finish_job(job, "cancelled")
                    continue
                if job.played >= len(job.sentences):
                    if any(s.status == "error" for s in job.sentences):
                        self._finish_job(job, "failed")
                    elif any(s.status == "cancelled" for s in job.sentences):
                        self._finish_job(job, "cancelled")
                    else:
                        job.done_ms = (time.perf_counter() - job.created_perf) * 1000.0
                        self._finish_job(job, "done")

    def _finish_job(self, job: Job, status: str) -> None:
        with self.lock:
            # stop()/上一阶段可能已经结算过，避免重复计数与重复历史
            if job.finished_at is not None and job.id not in self.jobs:
                return
            job.status = status
            job.finished_at = job.finished_at or time.time()
            self.jobs.pop(job.id, None)
            if not any(item.id == job.id for item in self.history):
                self.history.appendleft(job)
            if status == "done":
                self.stats["jobsCompleted"] += 1
            elif status == "failed":
                self.stats["jobsFailed"] += 1
            elif status == "cancelled":
                self.stats["jobsStopped"] += 1

    # -- 生命周期 -------------------------------------------------------
    def shutdown(self) -> None:
        self.log.info("语音服务停止中…")
        self.shutdown_event.set()
        try:
            self.stop()
        except Exception:
            pass
        try:
            self.rvc.shutdown()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# HTTP 层
# ---------------------------------------------------------------------------

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}


class VoiceHttpServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, handler, service: VoiceService | None = None):
        super().__init__(addr, handler)
        self.service = service


class Handler(BaseHTTPRequestHandler):
    server_version = f"VoiceService/{VERSION}"
    protocol_version = "HTTP/1.1"

    # -- 基础设施 -------------------------------------------------------
    def log_message(self, fmt, *args):
        if getattr(self.server, "service", None) is not None:
            logging.getLogger("voice_service").debug("HTTP %s", fmt % args)

    def _send_json(self, obj, status: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for key, value in CORS_HEADERS.items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _read_json(self) -> tuple[dict | None, str | None]:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return {}, None
        if length > 2 * 1024 * 1024:
            return None, "请求体过大"
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            return None, f"JSON 解析失败：{exc}"
        if not isinstance(data, dict):
            return None, "请求体必须是 JSON 对象"
        return data, None

    # -- 路由 -----------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        for key, value in CORS_HEADERS.items():
            self.send_header(key, value)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        svc: VoiceService = self.server.service  # type: ignore[attr-defined]
        path = self.path.split("?", 1)[0]
        try:
            if path in ("/health", "/healthz"):
                self._send_json(svc.health())
            elif path == "/voices":
                self._send_json(svc.voices())
            elif path == "/status":
                self._send_json(svc.status())
            elif path in ("/", "/index"):
                self._send_json(
                    {
                        "ok": True,
                        "service": "dsh-companion voice-service",
                        "version": VERSION,
                        "endpoints": [
                            "GET /health",
                            "GET /voices",
                            "POST /speak {text, voiceId?, pitch?, speed?, interrupt?, emotion?}",
                            "POST /stop",
                            "GET /status",
                            "POST /render {text, voiceId?, pitch?, speed?, emotion?}（只合成不播放）",
                        ],
                    }
                )
            else:
                self._send_json({"ok": False, "error": f"未知路径：{path}"}, 404)
        except Exception as exc:
            LOG.error("HTTP GET %s 处理失败：%s", path, traceback.format_exc())
            self._send_json({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, 500)

    def do_POST(self):
        svc: VoiceService = self.server.service  # type: ignore[attr-defined]
        path = self.path.split("?", 1)[0]
        payload, error = self._read_json()
        if error:
            self._send_json({"ok": False, "error": error}, 400)
            return
        try:
            if path == "/speak":
                response, status = svc.speak(payload or {})
                self._send_json(response, status)
            elif path == "/render":
                response, status = svc.render(payload or {})
                self._send_json(response, status)
            elif path == "/stop":
                self._send_json(svc.stop())
            elif path == "/shutdown":
                self._send_json({"ok": True, "message": "语音服务正在退出"})
                LOG.info("收到 /shutdown，退出")
                threading.Thread(target=svc.shutdown, daemon=True).start()
                svc.shutdown_event.set()
            elif path == "/speak/stop":
                self._send_json(svc.stop())
            else:
                self._send_json({"ok": False, "error": f"未知路径：{path}"}, 404)
        except Exception as exc:
            LOG.error("HTTP POST %s 处理失败：%s", path, traceback.format_exc())
            self._send_json({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, 500)


# ---------------------------------------------------------------------------
# 配置 / 入口
# ---------------------------------------------------------------------------

def _safe_print(*args) -> None:
    """pythonw.exe 下 sys.stdout 为 None，避免无心爱的 AttributeError。"""
    if sys.stdout is None:
        return
    try:
        print(*args)
    except Exception:
        pass


def voice_meta(voice_id: str) -> dict:
    return VOICE_TABLE.get(voice_id, {"name": voice_id, "ttsVoice": "zh-CN-XiaoxiaoNeural", "pitch": 0})


def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    config_path = ROOT / "config.json"
    if config_path.is_file():
        try:
            user_cfg = json.loads(config_path.read_text(encoding="utf-8"))
            if isinstance(user_cfg, dict):
                cfg.update(user_cfg)
        except Exception as exc:
            _safe_print(f"读取 config.json 失败，使用默认配置：{exc}")
    # 环境变量覆盖
    env_map = {
        "VOICE_SERVICE_HOST": "host",
        "VOICE_SERVICE_PORT": "port",
        "VOICE_SERVICE_DEVICE": "device",
        "VOICE_SERVICE_VOICE": "defaultVoice",
        "VOICE_SERVICE_TTS": "tts",
        "VOICE_SERVICE_LOG_FILE": "logFile",
        "VOICE_SERVICE_LOG_LEVEL": "logLevel",
    }
    for env_name, key in env_map.items():
        if os.environ.get(env_name):
            value = os.environ[env_name]
            if key == "port":
                value = int(value)
            cfg[key] = value
    return cfg


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="DSH 陪玩语音服务（TTS->RVC->扬声器）")
    parser.add_argument("--host", help="监听地址（默认 127.0.0.1，仅本机）")
    parser.add_argument("--port", type=int, help="监听端口（默认 9123）")
    parser.add_argument("--device", help="输出设备名子串（默认自动挑真实扬声器，排除 CABLE）")
    parser.add_argument("--voice", help="默认声线 id（如 march7/shogun/furina）")
    parser.add_argument("--tts", choices=["auto", "edge", "sapi"], help="TTS 模式")
    parser.add_argument("--log-level", help="日志级别 DEBUG/INFO/WARNING")
    parser.add_argument("--log-file", help="日志文件路径（默认 logs/service.log）")
    parser.add_argument("--list-voices", action="store_true", help="打印声线表后退出")
    parser.add_argument("--list-devices", action="store_true", help="打印音频输出设备后退出")
    parser.add_argument("--rvc-worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--rvc-cache", type=int, default=None, help=argparse.SUPPRESS)
    parser.add_argument("--default-voice", default=None, help=argparse.SUPPRESS)
    parser.add_argument("--no-preload", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args(argv)


def _print_voices() -> None:
    indices = VoiceService._scan_indices()
    print(f"{'id':<12} {'展示名':<24} {'index':<6} {'edge-tts 输入音色'}")
    for voice_id, meta in VOICE_TABLE.items():
        print(
            f"{voice_id:<12} {meta['name']:<24} "
            f"{'有' if voice_id in indices else '-':<6} {meta['ttsVoice']}"
        )


def _print_devices() -> None:
    try:
        import sounddevice as sd

        apis = sd.query_hostapis()
        for idx, dev in enumerate(sd.query_devices()):
            if dev.get("max_output_channels", 0) <= 0:
                continue
            api = apis[dev["hostapi"]]["name"] if dev["hostapi"] < len(apis) else ""
            virtual = " [虚拟/CABLE]" if AudioOutput._is_virtual(dev["name"]) else ""
            print(
                f"{idx:>3}  {dev['name']:<45} hostapi={api:<22} "
                f"ch={dev['max_output_channels']} sr={int(dev['default_samplerate'])}{virtual}"
            )
        try:
            out = sd.default.device[1]
            print(f"\n系统默认输出：index={out} name={sd.query_devices(out)['name']}")
        except Exception:
            pass
    except Exception as exc:
        print(f"枚举设备失败：{exc}")


def _probe_existing_instance(host: str, port: int) -> dict | None:
    """单实例检查：端口被占时探测 /health，成功则说明已有本服务在跑。"""
    import urllib.request

    url = f"http://{host}:{port}/health"
    try:
        with urllib.request.urlopen(url, timeout=3.0) as resp:
            if int(getattr(resp, "status", 200)) != 200:
                return None
            data = json.loads(resp.read().decode("utf-8", "replace"))
            if isinstance(data, dict) and data.get("ok"):
                return data
    except Exception:
        return None
    return None


def main(argv=None) -> int:
    args = parse_args(argv)
    if args.rvc_worker:
        return rvc_worker_main()
    if args.list_voices:
        _print_voices()
        return 0
    if args.list_devices:
        _print_devices()
        return 0

    cfg = load_config()
    for key, attr in (
        ("host", "host"),
        ("port", "port"),
        ("device", "device"),
        ("defaultVoice", "voice"),
        ("tts", "tts"),
        ("logFile", "log_file"),
        ("logLevel", "log_level"),
    ):
        value = getattr(args, attr, None)
        if value is not None:
            cfg[key] = value
    if cfg["defaultVoice"] not in VOICE_TABLE:
        _safe_print(f"未知默认声线 {cfg['defaultVoice']!r}，回退 march7")
        cfg["defaultVoice"] = "march7"

    log_file = Path(cfg["logFile"]) if cfg.get("logFile") else None
    setup_logging(cfg.get("logLevel", "INFO"), log_file=log_file)
    log = logging.getLogger("voice_service")
    log.info("=" * 72)
    log.info("DSH 陪玩语音服务 v%s 启动", VERSION)
    log.info("RVC 工程：%s", RVC_HOME)
    log.info("RVC Python：%s", RVC_PYTHON)
    log.info("pydeps：%s", PYDEPS_DIR)
    log.info("配置：%s", json.dumps({k: v for k, v in cfg.items() if k != "logLevel"}, ensure_ascii=False))

    # 单实例：先探测已有实例（Windows 的 SO_REUSEADDR 允许重复 bind 同一端口，
    # 不能只靠 bind 失败判断），已有实例则直接退出 0，避免白拉 GPU worker。
    existing = _probe_existing_instance(cfg["host"], int(cfg["port"]))
    if existing:
        msg = (
            f"语音服务已在运行：http://{cfg['host']}:{cfg['port']} "
            f"(version {existing.get('version', '?')}, outputDevice={existing.get('outputDevice', '?')})，"
            "本次启动直接退出（code 0）"
        )
        log.info(msg)
        _safe_print(msg)
        return 0
    try:
        server = VoiceHttpServer((cfg["host"], int(cfg["port"])), Handler, service=None)
    except OSError as exc:
        existing = _probe_existing_instance(cfg["host"], int(cfg["port"]))
        if existing:
            msg = f"语音服务已在运行：http://{cfg['host']}:{cfg['port']}，本次启动退出（code 0）"
            log.info(msg)
            _safe_print(msg)
            return 0
        log.error("无法监听 %s:%s（%s）。端口被其他程序占用。", cfg["host"], cfg["port"], exc)
        _safe_print(f"无法监听 {cfg['host']}:{cfg['port']}：{exc}")
        return 2

    service = VoiceService(cfg)
    server.service = service
    log.info("HTTP 服务已监听 http://%s:%d", cfg["host"], cfg["port"])
    log.info("API：GET /health | GET /voices | POST /speak | POST /stop | GET /status")
    log.info("RVC 正在后台预热（约 15~30 秒），/health 的 rvc.ready 为 true 即可用")

    try:
        (WORK_DIR / "voice_service.pid").write_text(str(os.getpid()), encoding="utf-8")
    except Exception:
        pass

    def _signal_handler(signum, frame):
        log.info("收到信号 %s，准备退出", signum)
        service.shutdown_event.set()

    try:
        import signal

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                signal.signal(sig, _signal_handler)
            except Exception:
                pass
    except Exception:
        pass

    http_thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.5}, name="http", daemon=True
    )
    http_thread.start()
    try:
        while not service.shutdown_event.wait(0.5):
            pass
    except KeyboardInterrupt:
        pass
    finally:
        log.info("正在关闭 HTTP 与 RVC worker…")
        try:
            server.shutdown()
        except Exception:
            pass
        try:
            server.server_close()
        except Exception:
            pass
        service.shutdown()
        log.info("已退出")
    return 0


if __name__ == "__main__":
    sys.exit(main())
