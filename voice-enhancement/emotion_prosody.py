#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""emotion_prosody.py — 「情绪 -> 分句韵律」计划表

职责：把一句中文按标点切成若干片段，并给每个片段算出最终的
rate / pitch / volume 偏移以及段后停顿长度。不联网、不碰音频，方便调参和单测。

背景（2026-10-19 实测，edge-tts 7.3.1 免费端点）：
  * ``mstts:express-as``（Azure 情绪风格）**被拒**：请求返回 NoAudioReceived；
  * ``<break>``、``<prosody>`` 嵌套**被拒**；
  * 同一 ``<voice>`` 下并列 ``<prosody>`` 最多 **2 个**，3 个即被拒（裸文本段不计数）；
  * ``pitch`` / ``rate`` / ``volume`` 参数在免费端点上确实生效（如 ``+20Hz``）。

因此情绪方案 = 「每个分句一次 edge-tts 请求（原生 rate/pitch/volume 参数）
+ 多分句并行合成 + 按情绪插入段间停顿 + 句末停顿」。
一次句子的实时延迟与单次请求基本一致（多分句是并发的）。

对外接口：
    resolve_emotion(name) -> EmotionPlan    # 未知/缺省 -> neutral
    is_emotional(name) -> bool
    split_clauses(text, max_clauses=4) -> list[str]
    build_segments(text, plan, speed) -> list[dict]   # 含 pauseAfterMs
    summarize_plan(plan) -> dict
    emotion_table() -> dict
"""

from __future__ import annotations

import re
from dataclasses import dataclass

MAX_CLAUSES = 4
# 短于这个可见字数的片段并到相邻片段，避免把语气词切得太碎
MIN_CLAUSE_CHARS = 2
# 单个分句最长字数：超过的话按逗号再切（仍受 MAX_CLAUSES 限制）
MAX_CLAUSE_CHARS = 40

# 分句：句内与句末标点，标点保留在前一段末尾
_CLAUSE_SPLIT_RE = re.compile(r"(?<=[。！？!?；;…，,、：:])")


@dataclass(frozen=True)
class EmotionPlan:
    """一种情绪的韵律参数。pitch/rate/volume 为相对偏移；shape 为句内片段轮廓。"""

    id: str
    label: str                 # 中文说明（给 /health 与报告）
    rate: int                  # 全局语速偏移 %
    pitch: int                 # 全局音高偏移 Hz
    volume: int                # 全局音量偏移 %
    pitch_shape: tuple         # 句内各片段音高额外偏移 Hz（按片段位置线性插值）
    rate_shape: tuple          # 句内各片段语速额外偏移 %
    volume_shape: tuple        # 句内各片段音量额外偏移 %
    pause_shape: tuple = ()    # 片段之间的停顿 ms（按片段位置线性插值）；空 = 0
    tail_pause_ms: int = 0     # 句末补的静音 ms（句与句之间的停顿，只在非 neutral 生效）
    # 整段话（多句任务）里的语调走向：按「当前句在任务中的位置」插值，
    # 让长回复的整体语气也有推进（例如吐槽开头拔高、结尾压下去）。
    sentence_pitch_shape: tuple = ()
    sentence_rate_shape: tuple = ()
    desc: str = ""

    def pitch_at(self, position: float) -> int:
        return _interp(self.pitch_shape, position)

    def rate_at(self, position: float) -> int:
        return _interp(self.rate_shape, position)

    def volume_at(self, position: float) -> int:
        return _interp(self.volume_shape, position)

    def pause_at(self, position: float) -> int:
        return _interp(self.pause_shape, position)

    def sentence_pitch_at(self, position: float) -> int:
        return _interp(self.sentence_pitch_shape, position)

    def sentence_rate_at(self, position: float) -> int:
        return _interp(self.sentence_rate_shape, position)


def _interp(shape: tuple, position: float) -> int:
    """在 shape 锚点间线性插值；position ∈ [0,1]。"""
    if not shape:
        return 0
    if len(shape) == 1:
        return int(round(shape[0]))
    pos = min(1.0, max(0.0, position))
    x = pos * (len(shape) - 1)
    i = int(x)
    if i >= len(shape) - 1:
        return int(round(shape[-1]))
    frac = x - i
    return int(round(shape[i] * (1.0 - frac) + shape[i + 1] * frac))


# ---------------------------------------------------------------------------
# 情绪表（9 种，与插件契约一致：neutral/happy/excited/tsukkomi/serious/
# gentle/surprised/smug/sigh；缺省/未知按 neutral）。
#
# 轮廓设计原则（2026-10-23 按 march7 实测收敛过一版）：
#   - 情绪只做「轻微」的音高/语速/停顿偏移，不再追求夸张；
#   - pitch 总偏移限制在 ±22Hz 左右，避免 RVC 后被放大成换人感；
#   - 分句停顿不再低于 ~160ms，避免逗号被吞掉后突然窜音高；
#   - volume 归零，减少分句拼接处的电平台阶。
# 实测依据见 artifacts/emotion-experiment-march7.md（不入包）。
# ---------------------------------------------------------------------------
EMOTIONS: dict[str, EmotionPlan] = {
    "neutral": EmotionPlan(
        id="neutral", label="平淡（默认，保持旧行为）",
        rate=0, pitch=0, volume=0,
        pitch_shape=(0,), rate_shape=(0,), volume_shape=(0,),
        pause_shape=(), tail_pause_ms=0,
        desc="不加任何情绪修饰，与旧版本逐字节同路径",
    ),
    "happy": EmotionPlan(
        id="happy", label="开心（温和档）",
        rate=5, pitch=8, volume=0,
        pitch_shape=(2, 13, -5), rate_shape=(0, 4, 2), volume_shape=(0, 0, 0),
        pause_shape=(180, 220), tail_pause_ms=140,
        sentence_pitch_shape=(-4, 7),
        desc="轻微上扬，句内先低后高，保留笑意但不再尖锐",
    ),
    "excited": EmotionPlan(
        id="excited", label="兴奋（温和档）",
        rate=8, pitch=11, volume=0,
        pitch_shape=(5, 9, -5), rate_shape=(2, 9, 5), volume_shape=(0, 0, 0),
        pause_shape=(160, 200), tail_pause_ms=100,
        sentence_pitch_shape=(9, -4),
        desc="略快略高，开场有冲劲，但不至于把逗号吞掉",
    ),
    "tsukkomi": EmotionPlan(
        id="tsukkomi", label="吐槽（温和档）",
        rate=3, pitch=3, volume=0,
        pitch_shape=(12, -8, -7), rate_shape=(2, -5, 4), volume_shape=(0, 0, 0),
        pause_shape=(200, 180), tail_pause_ms=140,
        sentence_pitch_shape=(14, -6),
        desc="问句轻挑、后半句轻压，保留嫌弃感但幅度收小",
    ),
    "serious": EmotionPlan(
        id="serious", label="认真（温和档）",
        rate=-5, pitch=-3, volume=0,
        pitch_shape=(-1, -2, -1), rate_shape=(-2, -5, -3), volume_shape=(0, 0, 0),
        pause_shape=(170, 200), tail_pause_ms=160,
        sentence_pitch_shape=(-1, -4),
        desc="略低略慢、起伏很小，显沉稳",
    ),
    "gentle": EmotionPlan(
        id="gentle", label="温柔（温和档）",
        rate=-7, pitch=2, volume=0,
        pitch_shape=(0, 10, -7), rate_shape=(-3, -8, -5), volume_shape=(0, 0, 0),
        pause_shape=(200, 240), tail_pause_ms=180,
        sentence_pitch_shape=(-1, 5),
        desc="轻声慢语，句中轻扬、句末柔落",
    ),
    "surprised": EmotionPlan(
        id="surprised", label="惊讶（温和档）",
        rate=2, pitch=7, volume=0,
        pitch_shape=(13, 7, 0), rate_shape=(1, 2, 0), volume_shape=(0, 0, 0),
        pause_shape=(240, 220), tail_pause_ms=160,
        sentence_pitch_shape=(10, -4),
        desc="开口略高，停顿自然，后半段回落",
    ),
    "smug": EmotionPlan(
        id="smug", label="坏笑（温和档）",
        rate=-4, pitch=3, volume=0,
        pitch_shape=(-5, 2, 10), rate_shape=(-2, -6, -4), volume_shape=(0, 0, 0),
        pause_shape=(220, 230), tail_pause_ms=160,
        sentence_pitch_shape=(-5, 11),
        desc="慢条斯理，尾句轻挑，保留一点得意拖腔",
    ),
    "sigh": EmotionPlan(
        id="sigh", label="无奈（温和档）",
        rate=-8, pitch=-5, volume=0,
        pitch_shape=(6, -8, -15), rate_shape=(-4, -9, -12), volume_shape=(0, 0, 0),
        pause_shape=(260, 300), tail_pause_ms=200,
        sentence_pitch_shape=(15, -16),
        desc="一路轻沉、越说越慢，但不再掉近一个八度",
    ),
}

EMOTION_IDS: tuple[str, ...] = tuple(EMOTIONS.keys())

_ALIASES = {
    "": "neutral",
    "none": "neutral",
    "normal": "neutral",
    "default": "neutral",
    "plain": "neutral",
    "flat": "neutral",
    "joy": "happy",
    "cheerful": "happy",
    "excite": "excited",
    "complain": "tsukkomi",
    "sarcastic": "tsukkomi",
    "soft": "gentle",
    "surprise": "surprised",
    "helpless": "sigh",
}


def resolve_emotion(name) -> EmotionPlan:
    """把插件传来的 emotion 解析成计划；缺省/未知值一律按 neutral。"""
    key = str(name or "").strip().lower()
    plan = EMOTIONS.get(key)
    if plan is not None:
        return plan
    mapped = _ALIASES.get(key)
    if mapped:
        return EMOTIONS[mapped]
    return EMOTIONS["neutral"]


def is_emotional(name) -> bool:
    """True 表示需要走情绪韵律；neutral/未知（含缺省）走旧路径。"""
    return resolve_emotion(name).id != "neutral"


def _visible_len(text: str) -> int:
    return len(re.sub(r"[^\w\u3400-\u9fff]", "", text))


def _merge_to_limit(parts: list[str], max_clauses: int) -> list[str]:
    """反复合并「合并后最短」的相邻两段，直到不超过 max_clauses。"""
    parts = list(parts)
    while len(parts) > max_clauses:
        best_i = min(
            range(len(parts) - 1),
            key=lambda i: len(parts[i]) + len(parts[i + 1]),
        )
        parts[best_i] = parts[best_i] + parts[best_i + 1]
        del parts[best_i + 1]
    return parts


def split_clauses(text: str, max_clauses: int = MAX_CLAUSES) -> list[str]:
    """按标点把一句切成若干片段（标点保留），过短片段合并，超过上限则合并最短相邻段。"""
    text = (text or "").strip()
    if not text:
        return []
    pieces = [p for p in _CLAUSE_SPLIT_RE.split(text) if p]
    if not pieces:
        pieces = [text]
    # 合并过短片段（如单独一个「，」或被切出来的语气词）
    merged: list[str] = []
    for part in pieces:
        if merged and _visible_len(part) < MIN_CLAUSE_CHARS:
            merged[-1] += part
        else:
            merged.append(part)
    if merged and _visible_len(merged[0]) < MIN_CLAUSE_CHARS and len(merged) > 1:
        merged[1] = merged[0] + merged[1]
        merged.pop(0)
    # 单段过长：按尽可能靠后的逗号再切
    resplit: list[str] = []
    for part in merged:
        while _visible_len(part) > MAX_CLAUSE_CHARS:
            spans = list(_CLAUSE_SPLIT_RE.split(part))
            if len(spans) <= 1:
                break
            # 从后往前找不超过上限的最大切点
            acc = ""
            cut = -1
            for idx, piece in enumerate(spans[:-1]):
                acc += piece
                if _visible_len(acc) <= MAX_CLAUSE_CHARS:
                    cut = idx
                else:
                    break
            if cut < 0:
                break
            head = "".join(spans[: cut + 1])
            tail = "".join(spans[cut + 1 :])
            if not head or not tail:
                break
            resplit.append(head)
            part = tail
        if part:
            resplit.append(part)
    return _merge_to_limit(resplit, max(1, int(max_clauses)))


def _clamp(value: int, low: int, high: int) -> int:
    return int(max(low, min(high, value)))


# 2026-10-23 march7 实测后的安全边界：
#   - 标称 pitch 会被 edge-tts 放大 ~1.7 倍，超过 ±22Hz 就容易「换人感」；
#   - 情绪带来的额外语速偏移控制在 ±12%；
#   - 分句停顿低于 140ms 会把逗号吞掉，高于 320ms 又显得拖。
MAX_EMOTION_PITCH_HZ = 22
MAX_EMOTION_RATE_PCT = 12
MIN_EMOTION_PAUSE_MS = 140
MAX_EMOTION_PAUSE_MS = 320


def build_segments(
    text: str, plan: EmotionPlan, speed: float = 1.0, sentence_pos: float = 0.5
) -> list[dict]:
    """把一句话拆成带 rate/pitch/volume 与段后停顿的音段列表（均为最终相对值）。

    sentence_pos：当前句在整段任务中的位置（0=第一句，1=最后一句），
    用于叠加「整段话的语调走向」；单句任务传 0.5（取中值，不改变句内轮廓）。
    """
    clauses = split_clauses(text)
    if not clauses:
        return []
    n = len(clauses)
    base_rate = _clamp(int(round((float(speed) - 1.0) * 100)), -50, 100)
    sent_pitch = plan.sentence_pitch_at(sentence_pos)
    sent_rate = plan.sentence_rate_at(sentence_pos)
    segments = []
    for i, clause in enumerate(clauses):
        pos = (i / (n - 1)) if n > 1 else 0.5
        emotion_rate = _clamp(plan.rate + plan.rate_at(pos) + sent_rate, -MAX_EMOTION_RATE_PCT, MAX_EMOTION_RATE_PCT)
        rate = _clamp(base_rate + emotion_rate, -50, 100)
        pitch = _clamp(plan.pitch + plan.pitch_at(pos) + sent_pitch, -MAX_EMOTION_PITCH_HZ, MAX_EMOTION_PITCH_HZ)
        volume = _clamp(plan.volume + plan.volume_at(pos), -3, 3)
        # 段后停顿：最后一段用句末停顿（由服务在 RVC 后补齐），这里负责分句之间。
        # neutral 保留旧路径（不会进情绪合成），但函数被直接调用时也不要凭空插 140ms。
        if i < n - 1:
            if plan.id == "neutral":
                pause_after = _clamp(plan.pause_at(pos), 0, 1200)
            else:
                pause_after = _clamp(plan.pause_at(pos), MIN_EMOTION_PAUSE_MS, MAX_EMOTION_PAUSE_MS)
        else:
            pause_after = 0
        segments.append(
            {
                "index": i,
                "text": clause,
                "rate": rate,
                "pitch": pitch,
                "volume": volume,
                "pauseAfterMs": pause_after,
            }
        )
    return segments


def summarize_plan(plan: EmotionPlan) -> dict:
    """给 /health、报告用的可序列化摘要。"""
    return {
        "label": plan.label,
        "rate": plan.rate,
        "pitch": plan.pitch,
        "volume": plan.volume,
        "pitchShape": list(plan.pitch_shape),
        "rateShape": list(plan.rate_shape),
        "volumeShape": list(plan.volume_shape),
        "pauseShape": list(plan.pause_shape),
        "tailPauseMs": plan.tail_pause_ms,
        "sentencePitchShape": list(plan.sentence_pitch_shape),
        "sentenceRateShape": list(plan.sentence_rate_shape),
        "desc": plan.desc,
    }


def emotion_table() -> dict:
    return {eid: summarize_plan(plan) for eid, plan in EMOTIONS.items()}
