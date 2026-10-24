// dsh-companion 浏览器半侧：右侧栏「陪玩」面板。
//
// 这是一个普通副作用脚本（不能有顶层 ESM import/export）：加载时向 DSH 的模块系统
// 注册一个 lazy factory，factory 返回插件三件套。React 由模块表提供（require('react')）。
//
// 面板职责：
//   - 轮询 /dsh-companion/state，显示运行状态、在看什么游戏、最近的对话、耗时与 token
//   - 开停检测、立刻看一眼、闭嘴、改配置
//   - 直接在面板里和卡律聊天（文字进，文字+语音出）
window.__ModuleLoader__.load({
  id: '@jyddwy/dsh-companion',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const API = '/dsh-companion';

    // ── 小工具 ────────────────────────────────────────────────────────────

    async function apiGet(path) {
      const response = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
      return data;
    }

    async function apiPost(path, body) {
      const response = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) throw new Error(data?.error ?? data?.result?.message ?? `HTTP ${response.status}`);
      return data;
    }

    function fmtDuration(seconds) {
      const total = Math.max(0, Math.round(seconds));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const secs = total % 60;
      if (hours > 0) return `${hours} 小时 ${minutes} 分`;
      if (minutes > 0) return `${minutes} 分 ${secs} 秒`;
      return `${secs} 秒`;
    }

    function fmtTime(ms) {
      try {
        const date = new Date(ms);
        const pad = (value) => String(value).padStart(2, '0');
        return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
      } catch {
        return '';
      }
    }

    function fmtNumber(value) {
      const number = Number(value) || 0;
      if (number >= 1e6) return `${(number / 1e6).toFixed(1)}M`;
      if (number >= 1e3) return `${(number / 1e3).toFixed(1)}k`;
      return String(number);
    }

    const RHYTHM_PRESETS = [
      { id: 'fast', name: '快节奏游戏（15 秒 / 3 帧 / 600ms）', intervalSec: 15, frameCount: 3, frameIntervalMs: 600 },
      { id: 'story', name: '剧情向游戏（45 秒 / 2 帧 / 1800ms）', intervalSec: 45, frameCount: 2, frameIntervalMs: 1800 },
      { id: 'chill', name: '慢节奏 / 省电（90 秒 / 1 帧 / 300ms）', intervalSec: 90, frameCount: 1, frameIntervalMs: 300 },
      { id: 'custom', name: '自定义（自己填下面的值）' },
    ];

    const SUBTITLE_PALETTES = [
      { id: 'bluewhite', name: '蓝白', color: '#eaf6ff', color2: '#4da3ff' },
      { id: 'pinkpurple', name: '粉紫', color: '#ffe8f5', color2: '#ff77c8' },
      { id: 'mint', name: '青绿', color: '#e9fff6', color2: '#32d6a0' },
      { id: 'amber', name: '橙金', color: '#fff4df', color2: '#ffb13b' },
      { id: 'ice', name: '冰蓝', color: '#e8fbff', color2: '#7be0ff' },
    ];

    // 与 src/host/cast.mjs 的 ROLE_CARDS 保持一致；这里只需要展示名和 id。
    const CAST_ROLE_CARDS = [
      { id: 'gentle', name: '温柔陪伴', blurb: '轻声接住情绪，先安慰再建议。' },
      { id: 'tsundere', name: '损友吐槽', blurb: '嘴硬心软，专挑槽点但站你这边。' },
      { id: 'cheerful', name: '元气捧场', blurb: '情绪外放，负责起哄和喝彩。' },
      { id: 'analyst', name: '冷静军师', blurb: '先观察再判断，负责局势分析。' },
    ];

    const PHASE_TEXT = {
      paused: '已暂停',
      idle: '待命中',
      checking: '正在看前台窗口…',
      capturing: '正在截图…',
      thinking: '正在想说什么…',
      speaking: '正在说话…',
    };

    const COLORS = {
      text: 'var(--dsw-alias-label-primary, #1f2328)',
      secondary: 'var(--dsw-alias-label-secondary, #57606a)',
      tertiary: 'var(--dsw-alias-label-tertiary, #8b949e)',
      caption: 'var(--dsw-alias-label-caption, #8b949e)',
      bg: 'var(--dsw-alias-bg-base, #ffffff)',
      layer: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      layer2: 'var(--dsw-alias-bg-layer-2, #f6f7f9)',
      border: 'var(--dsw-alias-border-l1, #e5e7eb)',
      border2: 'var(--dsw-alias-border-l2, #d0d7de)',
      accent: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      accentBg: 'var(--dsw-alias-interactive-bg-hover-accent, rgba(77,107,254,0.08))',
      success: 'var(--dsw-alias-state-success-primary, #22c55e)',
      error: 'var(--dsw-alias-state-error-primary, #ef4444)',
      warn: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
      card: 'var(--dsw-alias-settings-card-fill, #f7f8fa)',
      cardStroke: 'var(--dsw-alias-settings-card-stroke, #e5e7eb)',
    };

    const CSS = `
.dsc-root { display:flex; flex-direction:column; height:100%; min-height:0; color:${COLORS.text};
  font-family: var(--dsw-font-family, inherit); font-size:13px; background:${COLORS.bg}; }
.dsc-header { display:flex; align-items:center; gap:8px; padding:12px 14px 10px; border-bottom:1px solid ${COLORS.border}; flex:0 0 auto; }
.dsc-title { font-weight:600; font-size:14px; letter-spacing:0.2px; }
.dsc-dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; }
.dsc-sub { color:${COLORS.secondary}; font-size:12px; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsc-spacer { flex:1 1 auto; }
.dsc-btn { display:inline-flex; align-items:center; gap:5px; border:1px solid ${COLORS.border}; background:${COLORS.layer};
  color:${COLORS.text}; border-radius:7px; padding:4px 9px; font-size:12px; cursor:pointer; line-height:18px; white-space:nowrap; }
.dsc-btn:hover { background:${COLORS.layer2}; }
.dsc-btn:disabled { opacity:0.5; cursor:default; }
.dsc-btn.primary { background:${COLORS.accent}; border-color:${COLORS.accent}; color:#fff; }
.dsc-btn.primary:hover { filter:brightness(1.05); }
.dsc-btn.danger { color:${COLORS.error}; border-color:${COLORS.border}; }
.dsc-btn.ghost { border-color:transparent; background:transparent; color:${COLORS.secondary}; }
.dsc-btn.ghost:hover { background:${COLORS.layer2}; }
.dsc-tabs { display:flex; gap:2px; padding:8px 12px 0; flex:0 0 auto; }
.dsc-tab { border:none; background:transparent; color:${COLORS.secondary}; padding:6px 10px; border-radius:7px 7px 0 0; cursor:pointer; font-size:12px; }
.dsc-tab.active { color:${COLORS.accent}; background:${COLORS.accentBg}; font-weight:600; }
.dsc-body { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; }
.dsc-game { margin:10px 12px 0; padding:9px 11px; border:1px solid ${COLORS.cardStroke}; background:${COLORS.card}; border-radius:9px; display:flex; gap:10px; align-items:center; }
.dsc-game-main { min-width:0; flex:1 1 auto; }
.dsc-game-title { font-weight:600; font-size:12.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsc-game-meta { color:${COLORS.secondary}; font-size:11px; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsc-thumb { width:72px; height:41px; object-fit:cover; border-radius:5px; border:1px solid ${COLORS.border}; background:#000; flex:0 0 auto; }
.dsc-error { margin:8px 12px 0; padding:7px 10px; border-radius:8px; font-size:12px; color:${COLORS.error};
  background:color-mix(in srgb, ${COLORS.error} 8%, transparent); border:1px solid color-mix(in srgb, ${COLORS.error} 25%, transparent);
  white-space:pre-wrap; word-break:break-word; max-height:110px; overflow:auto; }
.dsc-chat { flex:1 1 auto; min-height:0; overflow-y:auto; padding:10px 12px 4px; display:flex; flex-direction:column; gap:8px; }
.dsc-bubble { display:flex; gap:8px; align-items:flex-end; }
.dsc-bubble.user { flex-direction:row-reverse; }
.dsc-avatar { width:22px; height:22px; border-radius:50%; flex:0 0 auto; display:flex; align-items:center; justify-content:center;
  font-size:11px; color:#fff; background:${COLORS.accent}; }
.dsc-bubble.user .dsc-avatar { background:${COLORS.secondary}; }
.dsc-bubble-main { max-width:82%; min-width:0; }
.dsc-bubble-text { padding:7px 10px; border-radius:10px; background:${COLORS.layer2}; line-height:1.55; white-space:pre-wrap; word-break:break-word; }
.dsc-bubble.user .dsc-bubble-text { background:${COLORS.accent}; color:#fff; }
.dsc-range { width: 120px; accent-color: ${COLORS.accent}; }
.dsc-bubble-meta { font-size:10.5px; color:${COLORS.tertiary}; margin-top:2px; display:flex; gap:6px; align-items:center; }
.dsc-bubble.user .dsc-bubble-meta { justify-content:flex-end; }
.dsc-emoji { font-size:10px; padding:0 5px; border-radius:4px; background:${COLORS.accentBg}; color:${COLORS.accent}; }
.dsc-chatbar { flex:0 0 auto; display:flex; align-items:center; gap:8px; padding:5px 12px; border-bottom:1px dashed ${COLORS.border}; }
.dsc-chatbar-text { font-size:11px; color:${COLORS.tertiary}; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsc-scene-toggle { display:flex; gap:12px; flex-wrap:wrap; padding:2px 0; }
.dsc-bubble-frame { margin-top:5px; display:flex; gap:4px; flex-wrap:wrap; }
.dsc-bubble-frame img { width:88px; height:50px; object-fit:cover; border-radius:5px; border:1px solid ${COLORS.border}; cursor:pointer; background:#000; }
.dsc-empty { color:${COLORS.tertiary}; font-size:12px; text-align:center; padding:28px 16px; line-height:1.8; }
.dsc-composer { flex:0 0 auto; border-top:1px solid ${COLORS.border}; padding:8px 12px 10px; display:flex; gap:7px; align-items:flex-end; }
.dsc-input { flex:1 1 auto; resize:none; min-height:34px; max-height:120px; padding:7px 9px; border-radius:8px;
  border:1px solid ${COLORS.border}; background:${COLORS.layer}; color:${COLORS.text}; font-size:12.5px; line-height:1.5; outline:none;
  font-family:inherit; }
.dsc-input:focus { border-color:${COLORS.accent}; }
.dsc-thinking { color:${COLORS.accent}; font-size:12px; padding:2px 14px 8px; }
.dsc-settings { flex:1 1 auto; min-height:0; overflow-y:auto; padding:8px 12px 20px; }
.dsc-section { border:1px solid ${COLORS.cardStroke}; background:${COLORS.card}; border-radius:9px; margin-top:10px; overflow:hidden; }
.dsc-section-head { padding:8px 11px; font-weight:600; font-size:12.5px; display:flex; align-items:center; gap:6px; cursor:pointer; user-select:none; }
.dsc-section-body { padding:2px 11px 10px; display:flex; flex-direction:column; gap:8px; }
.dsc-row { display:flex; align-items:center; gap:8px; min-height:26px; }
.dsc-row-label { flex:0 0 auto; width:112px; color:${COLORS.secondary}; font-size:12px; }
.dsc-row-control { flex:1 1 auto; display:flex; align-items:center; gap:6px; min-width:0; }
.dsc-row-hint { color:${COLORS.tertiary}; font-size:11px; margin:0 0 2px 120px; }
.dsc-text, .dsc-select, .dsc-number { border:1px solid ${COLORS.border}; background:${COLORS.layer}; color:${COLORS.text};
  border-radius:7px; padding:5px 8px; font-size:12px; font-family:inherit; outline:none; }
.dsc-text:focus, .dsc-select:focus, .dsc-number:focus { border-color:${COLORS.accent}; }
.dsc-text { flex:1 1 auto; min-width:0; }
.dsc-number { width:88px; }
.dsc-select { max-width:100%; }
.dsc-textarea { width:100%; min-height:64px; resize:vertical; border:1px solid ${COLORS.border}; background:${COLORS.layer};
  color:${COLORS.text}; border-radius:7px; padding:6px 8px; font-size:12px; font-family:inherit; line-height:1.55; outline:none; }
.dsc-textarea:focus { border-color:${COLORS.accent}; }
.dsc-check { width:14px; height:14px; accent-color:${COLORS.accent}; }
.dsc-color { width:36px; height:26px; padding:2px; border:1px solid ${COLORS.border}; border-radius:6px; background:${COLORS.layer}; cursor:pointer; }
.dsc-gradient-preview { width:78px; height:18px; border-radius:999px; border:1px solid ${COLORS.border}; }
.dsc-palette { border:1px solid ${COLORS.border}; background:${COLORS.layer}; border-radius:6px; padding:2px 7px; font-size:11px; color:${COLORS.secondary}; cursor:pointer; }
.dsc-cast-card { border:1px solid ${COLORS.border}; border-radius:8px; padding:8px 9px; background:${COLORS.layer2}; display:flex; flex-direction:column; gap:6px; }
.dsc-cast-head { display:flex; align-items:center; gap:8px; font-weight:600; font-size:12px; }
.dsc-cast-head .dsc-spacer { flex:1 1 auto; }
.dsc-cast-line { line-height:1.55; }
.dsc-cast-speaker { color:${COLORS.accent}; font-weight:600; margin-right:2px; }
.dsc-footer { flex:0 0 auto; border-top:1px solid ${COLORS.border}; padding:7px 12px; color:${COLORS.tertiary}; font-size:11px;
  display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
.dsc-pill { display:inline-flex; align-items:center; gap:4px; padding:1px 7px; border-radius:999px; background:${COLORS.layer2}; font-size:10.5px; color:${COLORS.secondary}; }
.dsc-pill.ok { color:${COLORS.success}; }
.dsc-pill.bad { color:${COLORS.error}; }
.dsc-pill.warn { color:${COLORS.warn}; }
.dsc-link { color:${COLORS.accent}; cursor:pointer; text-decoration:none; }
.dsc-log { width:100%; height:150px; resize:vertical; font-family:ui-monospace, SFMono-Regular, Consolas, monospace; font-size:10.5px;
  background:${COLORS.layer2}; color:${COLORS.text}; border:1px solid ${COLORS.border}; border-radius:7px; padding:6px; white-space:pre; overflow:auto; }
.dsc-divider { height:1px; background:${COLORS.border}; margin:4px 0; }
.dsc-badge { font-size:10px; padding:0 5px; border-radius:4px; background:${COLORS.layer2}; color:${COLORS.secondary}; }
.dsc-badge.on { background:color-mix(in srgb, ${COLORS.success} 14%, transparent); color:${COLORS.success}; }
.dsc-flex { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
`;

    // ── 小组件 ────────────────────────────────────────────────────────────

    function Icon({ path, size = 14 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', flex: '0 0 auto' },
        },
        h('path', { d: path }),
      );
    }

    const ICONS = {
      eye: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z',
      play: 'M5 3l14 9-14 9z',
      pause: 'M6 4v16M18 4v16',
      volume: 'M11 5L6 9H2v6h4l5 4V5zM19 9a4 4 0 010 6M22 6a8 8 0 010 12',
      mute: 'M11 5L6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6',
      settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z',
      gamepad: 'M6 12h4M8 10v4M15 11h.01M18 13h.01M6 8h12a4 4 0 014 4l-1.2 5.2A2.5 2.5 0 0117 18l-1.6-2H8.6L7 18a2.5 2.5 0 01-2.8-1.5L3 12a4 4 0 013-4z',
      send: 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z',
      refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0114.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0020.5 15',
      stop: 'M6 6h12v12H6z',
      external: 'M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3',
      brain: 'M9 3a3 3 0 00-3 3 3 3 0 00-3 3 3 3 0 001 2.2A3 3 0 006 17a3 3 0 003 3V3zM15 3a3 3 0 013 3 3 3 0 013 3 3 3 0 01-1 2.2A3 3 0 0118 17a3 3 0 01-3 3V3z',
    };

    function Dot({ ok, busy }) {
      const color = ok ? COLORS.success : busy ? COLORS.warn : COLORS.error;
      return h('span', { className: 'dsc-dot', style: { background: color, boxShadow: busy ? `0 0 0 3px ${color}22` : 'none' } });
    }

    function Row({ label, hint, children }) {
      return h(
        'div',
        null,
        h('div', { className: 'dsc-row' }, h('div', { className: 'dsc-row-label' }, label), h('div', { className: 'dsc-row-control' }, children)),
        hint ? h('div', { className: 'dsc-row-hint' }, hint) : null,
      );
    }

    function Toggle({ checked, onChange, label }) {
      return h(
        'label',
        { className: 'dsc-flex', style: { cursor: 'pointer', fontSize: 12, color: COLORS.secondary } },
        h('input', { type: 'checkbox', className: 'dsc-check', checked: Boolean(checked), onChange: (event) => onChange(event.target.checked) }),
        label,
      );
    }

    function Section({ title, icon, children, defaultOpen = false }) {
      const [open, setOpen] = useState(defaultOpen);
      return h(
        'div',
        { className: 'dsc-section' },
        h(
          'div',
          { className: 'dsc-section-head', onClick: () => setOpen((value) => !value) },
          icon ? h(Icon, { path: icon, size: 13 }) : null,
          h('span', null, title),
          h('span', { className: 'dsc-spacer' }),
          h('span', { style: { color: COLORS.tertiary, fontSize: 11 } }, open ? '收起' : '展开'),
        ),
        open ? h('div', { className: 'dsc-section-body' }, children) : null,
      );
    }

    const EMOTION_CN = {
      neutral: '平静', happy: '开心', excited: '兴奋', tsukkomi: '吐槽',
      serious: '认真', gentle: '温柔', surprised: '惊讶', smug: '坏笑', sigh: '无奈',
    };

    let companionName = '陪玩'; // 由 CompanionView 每次渲染时同步，供头像首字使用

    function Bubble({ entry, onPreviewFrame }) {
      const isUser = entry.role === 'user';
      const castLines = !isUser && Array.isArray(entry.castLines) && entry.castLines.length > 0 ? entry.castLines : null;
      const frames = [];
      if (!isUser && entry.tickId && entry.frameCount) {
        const count = Math.min(3, Number(entry.frameCount) || 1);
        for (let index = 0; index < count; index += 1) frames.push(index);
      }
      return h(
        'div',
        { className: `dsc-bubble${isUser ? ' user' : ''}` },
        h('div', { className: 'dsc-avatar' }, isUser ? '你' : String(companionName || '陪玩').slice(0, 1)),
        h(
          'div',
          { className: 'dsc-bubble-main' },
          h(
            'div',
            { className: 'dsc-bubble-text' },
            castLines
              ? castLines.map((line, index) => h(
                  'div',
                  { key: `${entry.id}-${index}`, className: 'dsc-cast-line' },
                  h('span', { className: 'dsc-cast-speaker' }, `${line.name}：`),
                  line.text,
                ))
              : entry.text,
          ),
          frames.length > 0
            ? h(
                'div',
                { className: 'dsc-bubble-frame' },
                frames.map((index) =>
                  h('img', {
                    key: index,
                    src: `${API}/frame/${entry.tickId}/${index}`,
                    alt: `画面 ${index + 1}`,
                    loading: 'lazy',
                    onClick: () => onPreviewFrame?.(`${API}/frame/${entry.tickId}/${index}`),
                  }),
                ),
              )
            : null,
          h(
            'div',
            { className: 'dsc-bubble-meta' },
            h('span', null, fmtTime(entry.at)),
            entry.game ? h('span', null, `· ${entry.game}`) : null,
            entry.source === 'chat' ? h('span', null, '· 聊天') : null,
            entry.emotion && entry.emotion !== 'neutral'
              ? h('span', { className: 'dsc-emoji' }, EMOTION_CN[entry.emotion] ?? entry.emotion)
              : null,
          ),
        ),
      );
    }

    // ── 设置面板 ──────────────────────────────────────────────────────────

    function VoiceInstallPanel({ notify, onVoiceRefresh, voiceData, snapshot }) {
      const [status, setStatus] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const previousJobPhase = useRef('');
      useEffect(() => {
        let alive = true, timer;
        async function refresh() {
          try {
            const next = await apiGet('/voice-install');
            if (alive) {
              setStatus(next);
              setError('');
              const phase = next?.job?.phase ?? '';
              // 增强环境安装完成 → 主动刷新声线（模型可能刚补齐）
              if (phase === 'complete' && previousJobPhase.current !== 'complete') {
                void onVoiceRefresh?.({ force: true, retries: 4 });
              }
              previousJobPhase.current = phase;
            }
          } catch (err) { if (alive) setError(err.message); }
          if (alive) timer = setTimeout(refresh, 2500);
        }
        void refresh();
        return () => { alive = false; clearTimeout(timer); };
      }, []);
      async function act(action, body) {
        setBusy(true);
        try {
          const next = await apiPost(`/voice-install/${action}`, body);
          if (action !== 'open-models') setStatus(next);
          setError('');
        } catch (err) { setError(err.message); }
        finally { setBusy(false); }
      }
      const job = status?.job;
      const running = Boolean(job?.running);
      const modelsReady = Boolean(status?.models?.present);
      const staleJobMessage = Boolean(job && !running && modelsReady && job.phase === 'complete');
      const runtimeStale = Boolean(status?.runtimeReady && status?.installedVersion && status?.version
        && status.installedVersion !== status.version);
      const serviceOnline = voiceData?.serviceOk ?? voiceData?.service?.ok ?? Boolean(snapshot?.services?.voice?.ok);
      const externalOnline = Boolean(serviceOnline && !voiceData?.managed && !status?.runtimeReady);
      const missing = status ? [!status.models.hubert && 'HuBERT', !status.models.rmvpe && 'RMVPE',
        status.models.voices.length === 0 && '至少一种声线'].filter(Boolean) : [];
      return h('div', { style: { padding: 10, marginBottom: 10, border: `1px solid ${COLORS.border}`, borderRadius: 8, overflowWrap: 'anywhere' } },
        h('strong', null, '可选：一键安装语音增强'),
        h('p', { className: 'dsc-row-hint', style: { margin: '6px 0' } },
          '从国内源安装独立 Python 和 CPU 语音环境，无需访问 GitHub、手动装 Python 或使用命令行。需联网下载数百 MB，并预留约 3 GB 磁盘空间；CPU 推理速度取决于电脑性能。'),
        h('p', { className: 'dsc-row-hint', style: { margin: '6px 0' } },
          '不包含任何声线、HuBERT 或 RMVPE 模型；模型需自行下载。更新主插件会保留增强环境和模型。'),
        externalOnline ? h('p', { style: { color: COLORS.success, margin: '6px 0' } },
          '已检测到正在运行的本地语音服务，当前声线可以直接使用，不需要点下面的一键安装。一键安装只用于没有 Python/RVC 环境的机器，会另装一套独立 CPU 运行时。') : null,
        status && !status.supported ? h('p', null, '目前支持 Windows x64。') : null,
        status?.runtimeReady ? h('p', { style: { color: COLORS.success, margin: '6px 0' } },
          `环境已安装（${status.installedVersion}）${missing.length ? '；待补齐模型：' + missing.join('、') : '；模型已就绪，选择已有声线后可重启语音并试听'}`) : null,
        runtimeStale ? h('p', { style: { color: COLORS.warn, margin: '6px 0' } },
          `语音运行时 ${status.installedVersion} 较旧，当前插件需要 ${status.version}。点下方按钮更新后，情绪语调修复才会生效；已有模型会保留。`) : null,
        job && !staleJobMessage ? h('p', { role: 'status', style: { margin: '6px 0' } }, job.message,
          running && job.phase === 'downloading' ? `（${(job.downloaded / 1048576).toFixed(1)}${job.total ? ' / ' + (job.total / 1048576).toFixed(1) : ''} MB）` : '') : null,
        error ? h('p', { role: 'alert', style: { color: COLORS.error } }, error) : null,
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('button', { className: `dsc-btn${externalOnline ? '' : ' primary'}`, disabled: busy || !status?.supported || running,
            onClick: () => act('start', { confirmDownload: true }) },
            status?.runtimeReady
              ? (runtimeStale ? `更新语音运行时（${status.version}）` : '重新安装增强环境')
              : externalOnline ? '安装独立 CPU 语音环境（可选）' : '下载并安装语音增强（CPU）'),
          running ? h('button', { className: 'dsc-btn', disabled: busy || ['activating', 'complete'].includes(job.phase), onClick: () => act('cancel') }, '取消安装') : null,
          status?.runtimeReady ? h('button', { className: 'dsc-btn', disabled: busy, onClick: () => act('open-models') }, '打开模型目录') : null,
          status?.runtimeReady && !missing.length ? h('button', { className: 'dsc-btn', disabled: busy,
            onClick: async () => {
              setBusy(true);
              try {
                const response = await apiPost('/services/restart', { kind: 'voice' });
                if (!response.result?.ok) throw new Error(response.result?.error || '语音启动失败，请查看服务日志');
                notify?.('已执行语音重启，正在刷新声线…');
                await onVoiceRefresh?.({ force: true, retries: 5 });
              } catch (err) { setError(err.message); }
              finally { setBusy(false); }
            } }, '重启语音') : null,
        ),
        status?.runtimeReady ? h('details', { style: { marginTop: 8 } },
          h('summary', { style: { cursor: 'pointer' } }, '模型放在哪里？'),
          h('p', { className: 'dsc-row-hint' }, status.modelDir),
          h('p', { className: 'dsc-row-hint' }, 'HuBERT 权重放在 hubert_base/pytorch_model.bin；RMVPE 放在 rmvpe/rmvpe.pt；声线放在 weights/，支持 march7.pth、furina.pth、nahida.pth、shogun.pth。可选的同名 .index 放在 indices/。请遵守模型作者的使用条件。'),
          h('a', { href: 'https://huggingface.co/lj1995/VoiceConversionWebUI/tree/main/hubert_base', target: '_blank', rel: 'noreferrer' }, 'HuBERT 原作者下载页'),
          ' · ', h('a', { href: 'https://huggingface.co/lj1995/VoiceConversionWebUI/blob/main/rmvpe.pt', target: '_blank', rel: 'noreferrer' }, 'RMVPE 原作者下载页'),
          h('p', { className: 'dsc-row-hint' }, '声线下载地址见插件随附的 docs/RVC-声线下载指南.md；模型下载网站的可达性取决于网络，当前安装按钮只负责运行环境。'),
        ) : null,
        job?.logs?.length ? h('details', { style: { marginTop: 8 } }, h('summary', { style: { cursor: 'pointer' } }, '安装日志'),
          h('pre', { style: { whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto', fontSize: 11 } }, job.logs.join('\n'))) : null,
      );
    }

    function SettingsView({ snapshot, models, voices, voiceState, onRefreshVoices, onSaved, notify }) {
      const [draft, setDraft] = useState(null);
      const [saving, setSaving] = useState(false);
      const [serviceLog, setServiceLog] = useState('');
      const [showLog, setShowLog] = useState(false);
      const [cleaning, setCleaning] = useState(false);
      const [subtitleBusy, setSubtitleBusy] = useState(false);
      const [subtitleFonts, setSubtitleFonts] = useState({ fonts: [], loading: true, error: '', fallback: false });
      const [fontBusy, setFontBusy] = useState(false);
      const [supportItems, setSupportItems] = useState([]);
      const [pbData, setPbData] = useState(null);
      const [pbError, setPbError] = useState('');
      const [wbList, setWbList] = useState([]);
      const [wbGame, setWbGame] = useState('');
      const [wbBusy, setWbBusy] = useState(false);
      const [wbEditing, setWbEditing] = useState(null);
      const [wbStatus, setWbStatus] = useState('');

      const loadWorldbooks = async () => {
        try {
          const data = await apiGet('/worldbooks');
          setWbList(Array.isArray(data.items) ? data.items : []);
        } catch (error) {
          setWbStatus(`读取世界书失败：${error.message}`);
        }
      };

      const loadSubtitleFonts = async ({ force = false } = {}) => {
        setFontBusy(true);
        setSubtitleFonts((previous) => ({ ...previous, loading: true, error: '' }));
        try {
          const data = await apiGet(`/subtitle/fonts${force ? '?force=1' : ''}`);
          setSubtitleFonts({
            fonts: Array.isArray(data.fonts) ? data.fonts : [],
            loading: false,
            error: data.error || '',
            fallback: Boolean(data.fallback),
          });
        } catch (error) {
          setSubtitleFonts({ fonts: [], loading: false, error: error.message, fallback: true });
        } finally {
          setFontBusy(false);
        }
      };

      useEffect(() => {
        void loadSubtitleFonts();
      }, []);

      useEffect(() => {
        loadWorldbooks();
      }, []);

      // 打开设置页就主动刷新一次声线（force=1 绕过缓存）
      useEffect(() => {
        void onRefreshVoices?.({ force: true, retries: 3 });
      }, [onRefreshVoices]);

      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const data = await apiGet('/support-assets');
            if (alive) setSupportItems(Array.isArray(data.items) ? data.items : []);
          } catch {
            if (alive) setSupportItems([]);
          }
        })();
        return () => {
          alive = false;
        };
      }, []);

      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const data = await apiGet('/prompt-blocks');
            if (alive) setPbData(data);
          } catch (error) {
            if (alive) setPbError(error.message);
          }
        })();
        return () => {
          alive = false;
        };
      }, []);

      useEffect(() => {
        if (!draft) return;
        const game = snapshot?.game?.label || snapshot?.scene?.label || '';
        if (game && !wbGame) setWbGame(game);
        if (snapshot?.worldbook?.status === 'ready' || snapshot?.worldbook?.status === 'error') loadWorldbooks();
      }, [draft, snapshot?.worldbook?.status, snapshot?.worldbook?.updatedAt, snapshot?.game?.label]);

      const researchWorldbook = async () => {
        const game = String(wbGame || snapshot?.game?.label || '').trim();
        if (!game) {
          setWbStatus('先填游戏名，或者切到游戏里让它自己认');
          return;
        }
        setWbBusy(true);
        setWbStatus(`正在联网调研「${game}」…（约 10–40 秒）`);
        try {
          const data = await apiPost('/worldbook/research', { game });
          setWbStatus(`世界书已生成：${data.entry?.title || game}`);
          setWbEditing(data.entry ?? null);
          await loadWorldbooks();
        } catch (error) {
          setWbStatus(`生成失败：${error.message}`);
        } finally {
          setWbBusy(false);
        }
      };

      const saveWorldbook = async () => {
        if (!wbEditing) return;
        setWbBusy(true);
        try {
          await apiPost('/worldbook', { entry: wbEditing });
          setWbStatus('世界书已保存');
          setWbEditing(null);
          await loadWorldbooks();
        } catch (error) {
          setWbStatus(`保存失败：${error.message}`);
        } finally {
          setWbBusy(false);
        }
      };

      const removeWorldbook = async (id) => {
        setWbBusy(true);
        try {
          await apiPost('/worldbook/delete', { id });
          setWbStatus('已删除');
          await loadWorldbooks();
        } catch (error) {
          setWbStatus(`删除失败：${error.message}`);
        } finally {
          setWbBusy(false);
        }
      };

      const linesToArray = (text) => String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
      const arrayToLines = (value) => (Array.isArray(value) ? value.join('\n') : '');
      const termsToText = (value) => (Array.isArray(value) ? value.map((item) => `${item.term}=${item.meaning}`).join('\n') : '');
      const textToTerms = (text) => String(text || '').split('\n').map((line) => {
        const index = line.indexOf('=');
        return index > 0 ? { term: line.slice(0, index).trim(), meaning: line.slice(index + 1).trim() } : null;
      }).filter((item) => item && item.term && item.meaning);

      useEffect(() => {
        if (snapshot?.config && draft === null) setDraft(JSON.parse(JSON.stringify(snapshot.config)));
      }, [snapshot, draft]);

      if (!draft) return h('div', { className: 'dsc-empty' }, '正在读取配置…');

      const set = (path, value) => {
        setDraft((previous) => {
          const next = JSON.parse(JSON.stringify(previous));
          const keys = path.split('.');
          let cursor = next;
          for (let index = 0; index < keys.length - 1; index += 1) {
            cursor[keys[index]] ??= {};
            cursor = cursor[keys[index]];
          }
          cursor[keys[keys.length - 1]] = value;
          return next;
        });
      };

      const save = async () => {
        setSaving(true);
        try {
          const result = await apiPost('/config', { patch: draft });
          onSaved?.(result.config);
          notify?.('已保存');
        } catch (error) {
          notify?.(`保存失败：${error.message}`, 'error');
        } finally {
          setSaving(false);
        }
      };

      const loadServiceLog = async (kind) => {
        try {
          const data = await apiGet(`/services/log?kind=${kind}&tail=200`);
          setServiceLog(data.tail || '（空）');
          setShowLog(true);
        } catch (error) {
          setServiceLog(`读取失败：${error.message}`);
          setShowLog(true);
        }
      };

      const modelOptions = (value) => {
        const providers = models?.providers ?? [];
        const options = [h('option', { key: 'auto', value: '' }, '自动（跟随当前对话模型）')];
        for (const provider of providers) {
          const children = provider.models.map((model) =>
            h('option', { key: `${provider.provider}/${model.id}`, value: `${provider.provider}|${model.id}` }, `${model.name || model.id}${model.supportsImage ? ' · 可看图' : ''}`),
          );
          options.push(h('optgroup', { key: provider.provider, label: provider.name || provider.provider }, children));
        }
        return options;
      };

      const splitTarget = (configValue) =>
        configValue?.provider && configValue?.model ? `${configValue.provider}|${configValue.model}` : '';

      const joinTarget = (value) => {
        if (!value) return { provider: '', model: '' };
        const [provider, model] = value.split('|');
        return { provider, model };
      };

      const voiceData = voiceState?.data ?? null;
      const voiceLoading = voiceState?.loading !== false;
      const voiceServiceOk = voiceData?.serviceOk ?? voiceData?.service?.ok ?? Boolean(snapshot?.services?.voice?.ok);
      const voiceManaged = Boolean(voiceData?.managed);
      const voiceModels = voiceData?.models ?? null;
      const voiceList = Array.isArray(voices) ? voices : [];
      const currentVoiceId = String(draft.voice.voiceId ?? '');
      const currentVoiceAvailable = voiceList.some((voice) => String(voice.id) === currentVoiceId);
      const modelsMissing = voiceManaged && voiceModels && (!voiceModels.hubert || !voiceModels.rmvpe || (voiceModels.voices ?? []).length === 0);
      const noVoices = !voiceLoading && voiceList.length === 0;
      const systemVoiceActive = draft.voice.backend === 'sapi'
        || snapshot?.services?.voice?.backend?.backend === 'sapi'
        || snapshot?.lastVoice?.backend === 'sapi';
      const voicePlaceholder = voiceLoading
        ? '正在加载声线…'
        : !voiceServiceOk
          ? '语音服务未启动'
          : modelsMissing
            ? '未检测到声线模型'
            : '未检测到可用声线';
      const voiceHint = voiceState?.error
        ? `读取声线失败：${voiceState.error}`
        : voiceLoading
          ? '正在读取声线…'
          : !voiceServiceOk
            ? '语音服务未启动。安装/启动语音增强后点「刷新声线」即可恢复，不需要刷新整个 DSH。'
            : modelsMissing
              ? '未检测到声线模型：把 .pth 放到模型目录 weights/ 后点「刷新声线」。'
              : noVoices
                ? (voiceManaged ? '环境已安装，但没有检测到可用的声线模型。' : '语音服务返回的声线列表为空。')
                : `可用声线 ${voiceList.length} 个${voiceManaged ? '（已按实际安装的模型过滤）' : ''}。`;
      const voiceOptions = [];
      if (!currentVoiceAvailable) {
        const currentLabel = voiceLoading
          ? '正在加载声线…'
          : currentVoiceId
            ? `当前声线暂不可用（${currentVoiceId}）`
            : voicePlaceholder;
        voiceOptions.push(h('option', { key: 'current', value: currentVoiceId }, currentLabel));
      }
      for (const voice of voiceList) {
        voiceOptions.push(h('option', { key: voice.id, value: voice.id }, `${voice.name || voice.id}${voice.installed ? '' : ''}`));
      }

      const castRoles = Array.isArray(draft.cast?.roles) ? draft.cast.roles : [];
      const mainCard = CAST_ROLE_CARDS.find((item) => item.id === draft.persona.style) ?? CAST_ROLE_CARDS[0];
      const mainVoice = voiceList.find((voice) => String(voice.id) === String(draft.voice.voiceId));
      const mainVoiceLabel = mainVoice?.name || draft.voice.voiceId || '当前声线';
      const updateCastRole = (index, patch) => {
        const next = castRoles.map((role, roleIndex) => (roleIndex === index ? { ...role, ...patch } : role));
        set('cast.roles', next);
      };
      const castVoiceOptions = (role) => {
        const options = [h('option', { key: 'inherit', value: '' }, '跟随主声线')];
        const value = String(role.voiceId ?? '');
        if (value && !voiceList.some((voice) => String(voice.id) === value)) {
          options.push(h('option', { key: 'missing', value }, `当前声线不可用（${value}）`));
        }
        for (const voice of voiceList) {
          options.push(h('option', { key: voice.id, value: voice.id }, voice.name || voice.id));
        }
        return options;
      };

      const subtitleFontList = Array.isArray(subtitleFonts.fonts) ? subtitleFonts.fonts : [];
      const currentFont = String(draft.subtitle.fontFamily || 'Microsoft YaHei');
      const subtitleFontOptions = [];
      if (!subtitleFontList.includes(currentFont)) {
        subtitleFontOptions.push(h('option', { key: 'current', value: currentFont }, `${currentFont}（当前）`));
      }
      for (const font of subtitleFontList) {
        subtitleFontOptions.push(h('option', { key: font, value: font }, font));
      }
      const subtitleColorA = /^#[0-9a-f]{6}$/i.test(String(draft.subtitle.color ?? '')) ? draft.subtitle.color : '#eaf6ff';
      const subtitleColorB = /^#[0-9a-f]{6}$/i.test(String(draft.subtitle.color2 ?? '')) ? draft.subtitle.color2 : subtitleColorA;

      return h(
        'div',
        { className: 'dsc-settings' },
        h(
          Section,
          { title: '开停与节奏', icon: ICONS.gamepad, defaultOpen: true },
          h(Toggle, { checked: draft.enabled, onChange: (value) => set('enabled', value), label: '开启自动观察' }),
          h('div', { className: 'dsc-row-hint', style: { margin: '0 0 4px' } },
            '开启后：模型会不断循环读取画面、持续开口——适合喜欢人声鼎沸、且愿把 token 花得像流水的玩家。'),

          h(Row, { label: '节奏预设', hint: '一键设置观察间隔 + 连拍帧数 + 帧间隔；选完记得点保存。看剧/写代码也用同一套节奏。' },
            h('select', {
              className: 'dsc-select',
              value: (() => {
                const preset = RHYTHM_PRESETS.find((item) => item.id !== 'custom'
                  && item.intervalSec === draft.intervalSec
                  && item.frameCount === draft.capture.frameCount
                  && item.frameIntervalMs === draft.capture.frameIntervalMs);
                return preset ? preset.id : 'custom';
              })(),
              onChange: (e) => {
                const preset = RHYTHM_PRESETS.find((item) => item.id === e.target.value);
                if (!preset || preset.id === 'custom') return;
                set('intervalSec', preset.intervalSec);
                set('capture.frameCount', preset.frameCount);
                set('capture.frameIntervalMs', preset.frameIntervalMs);
              },
            }, RHYTHM_PRESETS.map((item) => h('option', { key: item.id, value: item.id }, item.name))),
          ),
          h(Row, { label: '观察间隔（秒）', hint: '文档默认 45 秒；太频繁会烧 token。' },
            h('input', { className: 'dsc-number', type: 'number', min: 10, max: 3600, value: draft.intervalSec, onChange: (e) => set('intervalSec', Number(e.target.value)) }),
          ),
          h(Row, { label: '连拍帧数', hint: '一次触发连拍几张画面交给模型。' },
            h('input', { className: 'dsc-number', type: 'number', min: 1, max: 8, value: draft.capture.frameCount, onChange: (e) => set('capture.frameCount', Number(e.target.value)) }),
          ),
          h(Row, { label: '帧间隔（毫秒）', hint: '文档里的「每隔 5 帧截一次」≈ 30fps 下 167ms；300ms 能明显看出动作变化。' },
            h('input', { className: 'dsc-number', type: 'number', min: 0, max: 2000, step: 50, value: draft.capture.frameIntervalMs, onChange: (e) => set('capture.frameIntervalMs', Number(e.target.value)) }),
          ),
          h(Row, { label: '每小时上限', hint: '0 = 不限。默认 120 次，够用又省钱。' },
            h('input', { className: 'dsc-number', type: 'number', min: 0, max: 3600, value: draft.behavior.maxTicksPerHour, onChange: (e) => set('behavior.maxTicksPerHour', Number(e.target.value)) }),
          ),
          h('div', { className: 'dsc-row-label', style: { width: 'auto', marginTop: 6 } }, '截图缓存（自动清理）'),
          h(Row, { label: '保留轮数', hint: '只保留最近 N 轮截图；面板历史更早的缩略图会被清掉。' },
            h('input', { className: 'dsc-number', type: 'number', min: 0, max: 500, value: draft.capture.keepFrames ?? 20, onChange: (e) => set('capture.keepFrames', Number(e.target.value)) }),
          ),
          h(Row, { label: '最大占用（MB）', hint: '超过这个大小就删最旧的；0 = 不按大小限制。' },
            h('input', { className: 'dsc-number', type: 'number', min: 0, max: 10000, value: draft.capture.maxFramesMB ?? 200, onChange: (e) => set('capture.maxFramesMB', Number(e.target.value)) }),
            h('input', { className: 'dsc-number', type: 'number', min: 0, max: 720, value: draft.capture.retentionHours ?? 12, onChange: (e) => set('capture.retentionHours', Number(e.target.value)) }),
            h('span', { className: 'dsc-sub' }, '保留小时'),
          ),
          h('div', { className: 'dsc-flex', style: { alignItems: 'center', gap: 8, margin: '2px 0 4px' } },
            h('span', { className: 'dsc-row-hint', style: { flex: 1 } },
              snapshot?.storage?.frames
                ? `当前占用：${snapshot.storage.frames.dirs} 轮 / ${snapshot.storage.frames.mb} MB`
                : '当前占用：未知'),
            h('button', {
              className: 'dsc-btn ghost',
              disabled: cleaning,
              onClick: async () => {
                setCleaning(true);
                try {
                  const data = await apiPost('/cleanup-frames');
                  notify?.(`已清理，当前 ${data.storage?.frames?.dirs ?? 0} 轮 / ${data.storage?.frames?.mb ?? 0} MB`);
                } catch (error) {
                  notify?.(`清理失败：${error.message}`, 'error');
                } finally {
                  setCleaning(false);
                }
              },
            }, cleaning ? '清理中…' : '立即清理'),
          ),
          h(Row, { label: '截图长边 / 质量' },
            h('input', { className: 'dsc-number', type: 'number', min: 320, max: 2560, step: 64, value: draft.capture.maxLongEdge, onChange: (e) => set('capture.maxLongEdge', Number(e.target.value)) }),
            h('input', { className: 'dsc-number', type: 'number', min: 40, max: 95, value: draft.capture.jpegQuality, onChange: (e) => set('capture.jpegQuality', Number(e.target.value)) }),
          ),
        ),
        h(
          Section,
          { title: '声音（TTS + RVC）', icon: ICONS.volume, defaultOpen: true },
          h(VoiceInstallPanel, { notify, onVoiceRefresh: onRefreshVoices, voiceData, snapshot }),
          h(Toggle, { checked: draft.voice.enabled, onChange: (value) => set('voice.enabled', value), label: '开启语音朗读（关掉只出文字）' }),
          h(Toggle, { checked: draft.voice.emotionEnabled, onChange: (value) => set('voice.emotionEnabled', value), label: '情绪化语调（按台词情绪调整语气，避免捧读）' }),
          h(Row, { label: '语音后端', hint: '自动：优先用本地 RVC 语音服务，服务不在就用 Windows 系统语音（离线）。' },
            h('select', { className: 'dsc-select', value: draft.voice.backend, onChange: (e) => set('voice.backend', e.target.value) },
              h('option', { value: 'auto' }, '自动（优先 RVC 服务，失败用系统语音）'),
              h('option', { value: 'service' }, '只用 RVC 语音服务（需要语音增强包）'),
              h('option', { value: 'sapi' }, '只用 Windows 系统语音（离线、零依赖）'),
            ),
          ),
          systemVoiceActive
            ? h('div', { className: 'dsc-row-hint', style: { margin: '2px 0 0' } }, '当前使用 Windows 系统语音：RVC 声线/音调设置不生效（语速会映射成系统语音速度）。想用下方声线，请先安装语音增强并启动语音服务。')
            : null,
          h(Row, { label: '声线' },
            h('select', {
              className: 'dsc-select',
              value: draft.voice.voiceId,
              disabled: voiceLoading || voiceList.length === 0,
              onChange: (e) => set('voice.voiceId', e.target.value),
            }, voiceOptions),
            h('button', {
              className: 'dsc-btn ghost',
              disabled: voiceLoading,
              onClick: () => void onRefreshVoices?.({ force: true, retries: 3 }),
            }, voiceLoading ? '刷新中…' : '刷新声线'),
          ),
          h('div', { className: 'dsc-row-hint', style: { margin: '2px 0 0' } }, voiceHint),
          !voiceLoading && !currentVoiceAvailable && voiceList.length > 0
            ? h('div', { className: 'dsc-row-hint', style: { margin: '2px 0 0' } },
                `当前保存的声线「${currentVoiceId || '未选择'}」暂不可用，配置已保留；选择其它声线会覆盖它。`)
            : null,
          voiceManaged && voiceData?.modelDir
            ? h('div', { className: 'dsc-row-hint', style: { margin: '2px 0 0' } }, `声线模型目录：${voiceData.modelDir}`)
            : null,
          h(Row, { label: '音调（半音）' },
            h('input', { className: 'dsc-number', type: 'number', min: -12, max: 12, value: draft.voice.pitch, onChange: (e) => set('voice.pitch', Number(e.target.value)) }),
            h('span', { className: 'dsc-sub' }, '（男声线想更自然可 -2 ~ -4）'),
          ),
          h(Row, { label: '陪玩音量', hint: '只调陪玩自己的声音，不动系统音量；100% = 原始音量。' },
            h('input', { className: 'dsc-range', type: 'range', min: 0, max: 200, step: 5, value: Math.round((draft.voice.volume ?? 1) * 100), onChange: (e) => set('voice.volume', Number(e.target.value) / 100) }),
            h('span', { className: 'dsc-sub' }, `${Math.round((draft.voice.volume ?? 1) * 100)}%`),
          ),
          h(Row, { label: '语速', hint: '0.5-2 倍；太慢会显得没精神。' },
            h('input', { className: 'dsc-number', type: 'number', min: 0.5, max: 2, step: 0.05, value: draft.voice.speed, onChange: (e) => set('voice.speed', Number(e.target.value)) }),
            h(Toggle, { checked: draft.voice.speakReplies, onChange: (value) => set('voice.speakReplies', value), label: '聊天回复也读出来' }),
          ),
          h(Row, { label: '最长朗读字数', hint: '模型偶尔话多，超出部分会被截断，避免念小作文。' },
            h('input', { className: 'dsc-number', type: 'number', min: 20, max: 400, value: draft.voice.maxChars, onChange: (e) => set('voice.maxChars', Number(e.target.value)) }),
          ),
        ),
        h(
          Section,
          { title: '字幕（桌面悬浮）', icon: ICONS.volume },
          h('div', { className: 'dsc-row-hint', style: { margin: '0 0 4px' } },
            '把陪玩说的话像音乐软件歌词一样显示在桌面最上层；开启鼠标穿透后不会挡住游戏鼠标，按住 Ctrl 可临时拖动调整位置，位置会记住。独占全屏游戏里可能盖不上去。'),
          h(Toggle, { checked: draft.subtitle.enabled, onChange: (value) => set('subtitle.enabled', value), label: '开启桌面字幕' }),
          h(Toggle, {
            checked: draft.subtitle.clickThrough !== false,
            onChange: (value) => set('subtitle.clickThrough', value),
            label: '鼠标穿透（推荐；按住 Ctrl 可拖动字幕）',
          }),
          h(Row, { label: '字号 / 字体' },
            h('input', { className: 'dsc-number', type: 'number', min: 12, max: 96, value: draft.subtitle.fontSize ?? 28, onChange: (e) => set('subtitle.fontSize', Number(e.target.value)) }),
            h('select', {
              className: 'dsc-select',
              value: currentFont,
              onChange: (e) => set('subtitle.fontFamily', e.target.value),
            }, subtitleFontOptions),
            h('button', {
              className: 'dsc-btn ghost',
              disabled: fontBusy || subtitleFonts.loading,
              onClick: () => void loadSubtitleFonts({ force: true }),
            }, fontBusy || subtitleFonts.loading ? '读取中…' : '刷新字体'),
          ),
          h('div', { className: 'dsc-row-hint', style: { margin: '0 0 2px' } },
            subtitleFonts.loading
              ? '正在读取本机字体…'
              : subtitleFonts.error
                ? `字体列表读取失败，已显示兜底字体：${subtitleFonts.error}`
                : `已读取 ${subtitleFontList.length} 个本机字体${subtitleFonts.fallback ? '（兜底列表）' : ''}。`),
          h(Row, {
            label: '字幕延时（秒）',
            hint: '语音合成客观存在延迟，不同电脑配置延迟不同，延时字幕出现以配合语音出现时机。0 = 自动等语音真正开始（推荐）；大于 0 = 从台词生成后固定等待这么多秒再显示，用于手动校准。多人模式会逐句自动对齐。',
          },
            h('input', {
              className: 'dsc-number',
              type: 'number',
              min: 0,
              max: 10,
              step: 0.1,
              value: draft.subtitle.delaySec ?? 0,
              onChange: (e) => set('subtitle.delaySec', Number(e.target.value)),
            }),
            h('span', { className: 'dsc-sub' }, '秒'),
          ),
          h(Row, { label: '双色字幕', hint: '类似桌面歌词的双色渐变；默认蓝白。选两个颜色即可，字幕会从左到右渐变。' },
            h('input', {
              className: 'dsc-color',
              type: 'color',
              value: subtitleColorA,
              onChange: (e) => set('subtitle.color', e.target.value),
              title: '第一种颜色',
            }),
            h('input', {
              className: 'dsc-color',
              type: 'color',
              value: subtitleColorB,
              onChange: (e) => set('subtitle.color2', e.target.value),
              title: '第二种颜色',
            }),
            h('span', {
              className: 'dsc-gradient-preview',
              style: { background: `linear-gradient(90deg, ${subtitleColorA}, ${subtitleColorB})` },
              title: '渐变预览',
            }),
          ),
          h('div', { className: 'dsc-flex', style: { gap: 6 } },
            h('span', { className: 'dsc-sub' }, '配色预设：'),
            SUBTITLE_PALETTES.map((palette) => h('button', {
              key: palette.id,
              className: 'dsc-palette',
              onClick: () => {
                set('subtitle.color', palette.color);
                set('subtitle.color2', palette.color2);
              },
            }, palette.name)),
          ),
          h(Row, { label: '停留秒数 / 背景不透明度' },
            h('input', { className: 'dsc-number', type: 'number', min: 2, max: 60, value: draft.subtitle.displaySec ?? 8, onChange: (e) => set('subtitle.displaySec', Number(e.target.value)) }),
            h('input', { className: 'dsc-range', type: 'range', min: 0, max: 100, step: 5, value: Math.round((draft.subtitle.bgOpacity ?? 0.45) * 100), onChange: (e) => set('subtitle.bgOpacity', Number(e.target.value) / 100) }),
            h('span', { className: 'dsc-sub' }, `${Math.round((draft.subtitle.bgOpacity ?? 0.45) * 100)}%`),
          ),
          h('div', { className: 'dsc-flex', style: { gap: 8, marginTop: 2 } },
            h('button', {
              className: 'dsc-btn ghost',
              disabled: subtitleBusy,
              onClick: async () => {
                setSubtitleBusy(true);
                try {
                  await apiPost('/subtitle/test', { text: '字幕测试：能看见我这行字吗？' });
                  notify?.('字幕已显示（看桌面最上层）');
                } catch (error) {
                  notify?.(`字幕测试失败：${error.message}`, 'error');
                } finally {
                  setSubtitleBusy(false);
                }
              },
            }, '测试字幕'),
            h('button', {
              className: 'dsc-btn ghost',
              disabled: subtitleBusy,
              onClick: async () => {
                setSubtitleBusy(true);
                try {
                  await apiPost('/subtitle/restart');
                  notify?.('字幕窗口已重启');
                } catch (error) {
                  notify?.(`重启失败：${error.message}`, 'error');
                } finally {
                  setSubtitleBusy(false);
                }
              },
            }, '重启字幕窗口'),
            h('span', { className: 'dsc-row-hint', style: { flex: 1 } },
              snapshot?.subtitle?.running ? '状态：字幕窗口运行中' : (draft.subtitle.enabled ? '状态：未运行（保存后会自动启动）' : '状态：已关闭')),
          ),
        ),
        h(
          Section,
          { title: '人格', icon: ICONS.brain },
          h(Row, { label: '陪伴者名字', hint: '显示在面板头像、输入框、暂停提示里；可以用你自己 DSH 给她的名字。' },
            h('input', { className: 'dsc-text', value: draft.persona.name || '陪玩', placeholder: '陪玩 / 卡律 / 你的名字', onChange: (e) => set('persona.name', e.target.value) }),
          ),
          h(Row, { label: '陪伴风格', hint: '温柔：鼓励为主、不嘲讽不施压；损友：可以毒舌但底子向着你；元气：捧场起哄；分析：冷静军师。' },
            h('select', { className: 'dsc-select', value: draft.persona.style, onChange: (e) => set('persona.style', e.target.value) },
              h('option', { value: 'gentle' }, '温柔陪伴 · 积极鼓励'),
              h('option', { value: 'tsundere' }, '损友吐槽'),
              h('option', { value: 'cheerful' }, '元气捧场'),
              h('option', { value: 'analyst' }, '冷静分析'),
            ),
          ),
          h(Row, { label: '关系身份', hint: '「你是用户的___，坐在旁边一起看 TA 玩游戏」里的那个词。' },
            h('input', { className: 'dsc-text', value: draft.persona.relation, onChange: (e) => set('persona.relation', e.target.value), placeholder: '损友 / 朋友 / 搭档 / 青梅' }),
          ),
          h(Row, { label: '复用 AGENTS.md' },
            h(Toggle, { checked: draft.persona.useAgentsMd, onChange: (value) => set('persona.useAgentsMd', value), label: '继承 DSH 本体人格设定' }),
          ),
          h(
            'div',
            null,
            h('div', { className: 'dsc-row-label', style: { width: 'auto', marginBottom: 4 } }, '额外人设 / 口癖 / 禁忌'),
            h('textarea', {
              className: 'dsc-textarea',
              value: draft.persona.extra,
              placeholder: '例如：说话偶尔带一点舰桥军师的坏心眼；不许剧透后面剧情；称呼主人叫「jyddwy」……',
              onChange: (e) => set('persona.extra', e.target.value),
            }),
          ),
          h(Toggle, {
            checked: draft.cast?.enabled === true,
            onChange: (value) => set('cast.enabled', value),
            label: '一人分饰多角（多人陪玩，实验）',
          }),
          h('div', { className: 'dsc-row-hint', style: { margin: '0 0 2px' } },
            '开启后，上方「人格」配置就是角色 1（主角色），下面只额外加入角色 2、3。每名角色有自己的开口概率，每轮独立掷骰，至少保底一个角色说话；接话顺序可随机。角色越多 TTS/RVC 队列越长，越容易卡顿；建议先开 2 个，最多 3 个。面板聊天由角色 1 回答。多人声线需要 RVC 语音服务；系统语音下所有角色会用同一个声音。'),
          draft.cast?.enabled
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                h('div', { className: 'dsc-cast-card' },
                  h('div', { className: 'dsc-cast-head' },
                    '角色 1（主角色）',
                    h('span', { className: 'dsc-spacer' }),
                    h('span', { className: 'dsc-badge on' }, '沿用上方配置'),
                  ),
                  h('div', { className: 'dsc-row-hint', style: { margin: 0 } },
                    `名字：${draft.persona.name || '陪玩'}｜风格：${mainCard.name}｜声线：${mainVoiceLabel}｜AGENTS.md：${draft.persona.useAgentsMd ? '沿用' : '不沿用'}`),
                  h(Row, { label: '开口概率' },
                    h('input', {
                      className: 'dsc-number',
                      type: 'number',
                      min: 0,
                      max: 100,
                      step: 5,
                      value: draft.cast.mainChance ?? 70,
                      onChange: (e) => set('cast.mainChance', Number(e.target.value)),
                    }),
                    h('span', { className: 'dsc-sub' }, '%'),
                  ),
                ),
                h(Toggle, {
                  checked: draft.cast.randomOrder !== false,
                  onChange: (value) => set('cast.randomOrder', value),
                  label: '随机接话顺序',
                }),
                castRoles.slice(1).map((role, relativeIndex) => {
                  const index = relativeIndex + 1;
                  const card = CAST_ROLE_CARDS.find((item) => item.id === role.card) ?? CAST_ROLE_CARDS[0];
                  return h('div', { key: role.id ?? index, className: 'dsc-cast-card' },
                    h('div', { className: 'dsc-cast-head' },
                      `额外角色 ${index + 1}`,
                      h('span', { className: 'dsc-spacer' }),
                      Toggle({
                        checked: role.enabled === true,
                        onChange: (value) => updateCastRole(index, { enabled: value }),
                        label: '启用',
                      }),
                    ),
                    h(Row, { label: '名字' },
                      h('input', {
                        className: 'dsc-text',
                        value: role.name ?? '',
                        placeholder: card.name,
                        onChange: (e) => updateCastRole(index, { name: e.target.value }),
                      }),
                    ),
                    h(Row, { label: '角色卡' },
                      h('select', {
                        className: 'dsc-select',
                        value: card.id,
                        onChange: (e) => updateCastRole(index, { card: e.target.value }),
                      }, CAST_ROLE_CARDS.map((item) => h('option', { key: item.id, value: item.id }, item.name))),
                    ),
                    h('div', { className: 'dsc-row-hint', style: { margin: '0 0 0 120px' } }, card.blurb),
                    h(Row, { label: '声线' },
                      h('select', {
                        className: 'dsc-select',
                        value: role.voiceId ?? '',
                        onChange: (e) => updateCastRole(index, { voiceId: e.target.value }),
                      }, castVoiceOptions(role)),
                    ),
                    h(Row, { label: '开口概率' },
                      h('input', {
                        className: 'dsc-number',
                        type: 'number',
                        min: 0,
                        max: 100,
                        step: 5,
                        value: role.speakChance ?? 70,
                        onChange: (e) => updateCastRole(index, { speakChance: Number(e.target.value) }),
                      }),
                      h('span', { className: 'dsc-sub' }, '%'),
                    ),
                    Toggle({
                      checked: role.useAgentsMd === true,
                      onChange: (value) => updateCastRole(index, { useAgentsMd: value }),
                      label: '这个角色沿用 AGENTS.md',
                    }),
                    h(Row, { label: '额外人设' },
                      h('input', {
                        className: 'dsc-text',
                        value: role.extra ?? '',
                        placeholder: '可选：口癖 / 称呼 / 禁忌',
                        onChange: (e) => updateCastRole(index, { extra: e.target.value }),
                      }),
                    ),
                  );
                }),
              )
            : null,
          h(Toggle, { checked: draft.talk.cheerMode, onChange: (value) => set('talk.cheerMode', value), label: '喝彩模式（少说教、多夸击杀/爆炸/开火等高光操作，不盯着弹药和任务目标）' }),
          h(Toggle, { checked: draft.talk.banQuestions, onChange: (value) => set('talk.banQuestions', value), label: '观察时少提问（玩家没空回答问句；命中会改成陈述/感叹）' }),
        ),
        h(
          Section,
          { title: '提示词（高级）', icon: ICONS.book ?? ICONS.brain },
          h('div', { className: 'dsc-row-hint', style: { margin: '0 0 4px' } },
            '这里能看到并修改独立于 AGENTS.md 的内置提示词（都是会真实发给模型的内容）。留空 = 使用内置默认；「恢复默认」会清掉你的覆盖。'),
          pbError ? h('div', { className: 'dsc-row-hint', style: { color: COLORS.danger ?? '#c00' } }, `读取失败：${pbError}`) : null,
          pbData
            ? (pbData.blocks ?? []).map((block) => h(
                'div',
                { key: block.id, style: { margin: '6px 0' } },
                h('div', { className: 'dsc-row-label', style: { width: 'auto', marginBottom: 2 } },
                  block.label,
                  h('button', {
                    className: 'dsc-btn ghost',
                    style: { marginLeft: 8, padding: '1px 6px', fontSize: 10.5 },
                    onClick: () => set(`persona.promptOverrides.${block.id}`, ''),
                  }, '恢复默认'),
                ),
                h('div', { className: 'dsc-row-hint', style: { margin: '0 0 3px' } }, block.hint ?? ''),
                h('textarea', {
                  className: 'dsc-textarea',
                  rows: 3,
                  value: draft.persona.promptOverrides?.[block.id] ?? pbData.defaults?.[block.id] ?? '',
                  onChange: (e) => set(`persona.promptOverrides.${block.id}`, e.target.value),
                }),
              ))
            : h('div', { className: 'dsc-row-hint' }, '正在读取内置提示词…'),
        ),
        h(
          Section,
          { title: '模型', icon: ICONS.settings },
          h(Row, { label: '识图模型', hint: '必须支持图片输入。留空=自动探测（优先当前对话模型，其次注册表里声明 image 的模型）。' },
            h('select', {
              className: 'dsc-select',
              value: splitTarget(draft.vision),
              onChange: (e) => set('vision', { ...draft.vision, ...joinTarget(e.target.value) }),
            }, modelOptions()),
          ),
          h(Row, { label: '出话模型', hint: '负责把局势变成人格化台词。留空=当前对话模型。' },
            h('select', {
              className: 'dsc-select',
              value: splitTarget(draft.talk),
              onChange: (e) => set('talk', { ...draft.talk, ...joinTarget(e.target.value) }),
            }, modelOptions()),
          ),
          h(Row, { label: '识图思考强度', hint: '识图只抽 JSON，选「关闭」最快最省；模型不支持所选档位时会自动退回默认。' },
            h('select', { className: 'dsc-select', value: draft.vision.reasoningEffort, onChange: (e) => set('vision.reasoningEffort', e.target.value) },
              h('option', { value: 'auto' }, '跟随默认'),
              h('option', { value: 'off' }, '关闭（最快）'),
              h('option', { value: 'minimal' }, '最低'),
              h('option', { value: 'low' }, '低'),
              h('option', { value: 'medium' }, '中'),
              h('option', { value: 'high' }, '高'),
              h('option', { value: 'xhigh' }, '极高'),
              h('option', { value: 'max' }, '最高'),
            ),
          ),
          h(Row, { label: '出话思考强度', hint: '陪聊只需一两句口语，默认跟随 DSH；想更快更省可以选「低」或「关闭」。' },
            h('select', { className: 'dsc-select', value: draft.talk.reasoningEffort, onChange: (e) => set('talk.reasoningEffort', e.target.value) },
              h('option', { value: 'auto' }, '跟随默认'),
              h('option', { value: 'off' }, '关闭（最快）'),
              h('option', { value: 'minimal' }, '最低'),
              h('option', { value: 'low' }, '低'),
              h('option', { value: 'medium' }, '中'),
              h('option', { value: 'high' }, '高'),
              h('option', { value: 'xhigh' }, '极高'),
              h('option', { value: 'max' }, '最高'),
            ),
          ),
          h(Toggle, { checked: draft.talk.banFiller, onChange: (value) => set('talk.banFiller', value), label: '禁止空话 / 陪聊套话（命中会重写一次，重写后仍是空话这轮就不开口）' }),
          h('div', { className: 'dsc-row-hint', style: { margin: '2px 0 0' } },
            `当前对话模型：${snapshot?.modelReport?.current ? `${snapshot.modelReport.current.provider}/${snapshot.modelReport.current.model}` : '未知'}；` +
            `注册表 image 模型：${snapshot?.modelReport?.imageModels?.length ? snapshot.modelReport.imageModels.join('、') : '未发现'}`),
        ),
        h(
          Section,
          { title: '行为与记忆', icon: ICONS.eye },
          h(Toggle, { checked: draft.behavior.onlyWhenGame, onChange: (value) => set('behavior.onlyWhenGame', value), label: '只在陪伴场景里观察（游戏 / 看剧 / 写代码）' }),
          h('div', { className: 'dsc-row-label', style: { width: 'auto', margin: '4px 0 0' } }, '陪哪些场景'),
          h('div', { className: 'dsc-scene-toggle' },
            Toggle({ checked: draft.behavior.scenarios.game, onChange: (value) => set('behavior.scenarios.game', value), label: '陪玩游戏' }),
            Toggle({ checked: draft.behavior.scenarios.watching, onChange: (value) => set('behavior.scenarios.watching', value), label: '陪看动漫/剧' }),
            Toggle({ checked: draft.behavior.scenarios.coding, onChange: (value) => set('behavior.scenarios.coding', value), label: '陪写代码/做文件' }),
          ),
          h(Toggle, { checked: draft.behavior.requireFullscreen, onChange: (value) => set('behavior.requireFullscreen', value), label: '只有全屏才算游戏（严格模式）' }),
          h(Toggle, { checked: draft.behavior.skipUnchanged, onChange: (value) => set('behavior.skipUnchanged', value), label: '画面没变化就跳过这一轮（省钱）' }),
          h(Row, { label: '空闲暂停（秒）', hint: '键鼠多久没动静就不再观察；0 = 不暂停。' },
            h('input', { className: 'dsc-number', type: 'number', min: 0, max: 3600, value: draft.behavior.pauseWhenIdleSec, onChange: (e) => set('behavior.pauseWhenIdleSec', Number(e.target.value)) }),
          ),
          h(Row, { label: '记忆范围' },
            h('select', { className: 'dsc-select', value: draft.behavior.memoryMode, onChange: (e) => set('behavior.memoryMode', e.target.value) },
              h('option', { value: 'auto' }, '自动（按游戏类型：射击短、剧情长）'),
              h('option', { value: 'short' }, '总是短记忆（只聊眼前）'),
              h('option', { value: 'long' }, '总是长记忆（可以翻旧账）'),
            ),
          ),
          h(Row, { label: '短 / 长记忆（秒）' },
            h('input', { className: 'dsc-number', type: 'number', min: 20, max: 3600, value: draft.behavior.memoryShortSec, onChange: (e) => set('behavior.memoryShortSec', Number(e.target.value)) }),
            h('input', { className: 'dsc-number', type: 'number', min: 60, max: 14400, value: draft.behavior.memoryLongSec, onChange: (e) => set('behavior.memoryLongSec', Number(e.target.value)) }),
          ),
          h(
            'div',
            null,
            h('div', { className: 'dsc-row-label', style: { width: 'auto', marginBottom: 4 } }, '游戏白名单（每行一个，支持 * 通配）'),
            h('textarea', {
              className: 'dsc-textarea',
              style: { minHeight: 84 },
              value: (draft.behavior.games ?? []).join('\n'),
              onChange: (e) => set('behavior.games', e.target.value.split('\n').map((line) => line.trim()).filter(Boolean)),
            }),
          ),
        ),
        h(
          Section,
          { title: '世界书', icon: ICONS.book ?? ICONS.brain },
          h('div', { className: 'dsc-row-hint', style: { margin: '0 0 4px' } },
            '第一次见到某个游戏时，它会联网搜索资料（优先百度贴吧 / 小黑盒 / NGA / 攻略站的教学贴），整理成一份「设定 + 新手知识 + 常见误解」的世界书，出话时参考，减少游戏理解错误和幻觉。'),
          h('div', { className: 'dsc-row-hint', style: { margin: '0 0 4px' } },
            '如果网络环境抓不到帖子正文，可信度会如实标注「正文抓取受限」，这时可以把攻略要点手动粘进下面的编辑框。'),
          h(Row, { label: '游戏名', hint: '留空也能用当前识别到的游戏；填英文名/中文名都行。' },
            h('input', { className: 'dsc-text', value: wbGame, placeholder: 'HELLDIVERS 2 / 绝地潜兵2', onChange: (e) => setWbGame(e.target.value) }),
            h('button', { className: 'dsc-btn primary', disabled: wbBusy, onClick: researchWorldbook }, wbBusy ? '处理中…' : '联网生成'),
            h('button', { className: 'dsc-btn ghost', onClick: loadWorldbooks }, '刷新'),
          ),
          wbStatus ? h('div', { className: 'dsc-row-hint', style: { margin: '2px 0' } }, wbStatus) : null,
          wbEditing
            ? h(
                'div',
                null,
                h('div', { className: 'dsc-row-label', style: { width: 'auto', margin: '6px 0 4px' } },
                  `正在编辑：${wbEditing.title || wbEditing.game}（来源 ${wbEditing.confidence || 'model'}）`),
                h('textarea', { className: 'dsc-textarea', rows: 3, value: wbEditing.synopsis || '', placeholder: '一句话设定（120 字内）', onChange: (e) => setWbEditing({ ...wbEditing, synopsis: e.target.value }) }),
                h('textarea', { className: 'dsc-textarea', rows: 3, value: wbEditing.coreLoop || '', placeholder: '核心玩法（100 字内）', onChange: (e) => setWbEditing({ ...wbEditing, coreLoop: e.target.value }) }),
                h('textarea', { className: 'dsc-textarea', rows: 4, value: arrayToLines(wbEditing.beginnerSteps), placeholder: '新手要点（一行一条）', onChange: (e) => setWbEditing({ ...wbEditing, beginnerSteps: linesToArray(e.target.value) }) }),
                h('textarea', { className: 'dsc-textarea', rows: 4, value: arrayToLines(wbEditing.tips), placeholder: '实用提示（一行一条）', onChange: (e) => setWbEditing({ ...wbEditing, tips: linesToArray(e.target.value) }) }),
                h('textarea', { className: 'dsc-textarea', rows: 4, value: termsToText(wbEditing.terms), placeholder: '术语（一行一个，格式：词=解释）', onChange: (e) => setWbEditing({ ...wbEditing, terms: textToTerms(e.target.value) }) }),
                h('textarea', { className: 'dsc-textarea', rows: 3, value: arrayToLines(wbEditing.commonMistakes), placeholder: '常见误解（一行一条，供它避坑）', onChange: (e) => setWbEditing({ ...wbEditing, commonMistakes: linesToArray(e.target.value) }) }),
                h('textarea', { className: 'dsc-textarea', rows: 2, value: wbEditing.verification || '', placeholder: '资料可信度（如：参考 3 个玩家社区教学贴，已交叉核对）', onChange: (e) => setWbEditing({ ...wbEditing, verification: e.target.value }) }),
                (wbEditing.sources ?? []).length > 0
                  ? h('div', { className: 'dsc-row-hint', style: { margin: '2px 0', maxHeight: 54, overflow: 'auto' } },
                      '来源：' + wbEditing.sources.map((src) => src.title || src.url).join(' ｜ '))
                  : null,
                h('div', { className: 'dsc-flex', style: { marginTop: 4 } },
                  h('button', { className: 'dsc-btn primary', disabled: wbBusy, onClick: saveWorldbook }, '保存世界书'),
                  h('button', { className: 'dsc-btn ghost', onClick: () => setWbEditing(null) }, '取消'),
                ),
              )
            : null,
          wbList.length > 0
            ? h('div', { style: { marginTop: 6 } },
                wbList.map((item) => h('div', { key: item.id, className: 'dsc-flex', style: { alignItems: 'center', gap: 6, padding: '2px 0', fontSize: 11.5 } },
                  h('span', { title: item.verification || '', style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    `${item.title || item.game} · ${item.confidence === 'web' ? '联网' : item.confidence === 'manual' ? '手改' : '模型知识'}` +
                    `${item.sources?.length ? ` · ${item.sources.length} 来源` : ''}` +
                    `${(item.sources ?? []).some((src) => /tieba|xiaoheihe|heybox|nga|bilibili/i.test(src.url || '')) ? ' · 含社区贴' : ''}`),
                  h('button', { className: 'dsc-btn ghost', onClick: () => setWbEditing(JSON.parse(JSON.stringify(item))) }, '编辑'),
                  h('button', { className: 'dsc-btn ghost', disabled: wbBusy, onClick: () => { setWbGame(item.game || item.title || ''); researchWorldbook(); } }, '重新调研'),
                  h('button', { className: 'dsc-btn ghost', disabled: wbBusy, onClick: () => removeWorldbook(item.id) }, '删除'),
                )),
              )
            : h('div', { className: 'dsc-row-hint', style: { marginTop: 4 } }, '还没有世界书。切到游戏里，或者上面填个游戏名生成一份。'),
        ),
        h(
          Section,
          { title: '本地服务', icon: ICONS.refresh },
          h('div', { className: 'dsc-flex' },
            h('span', { className: `dsc-pill ${snapshot?.services?.capture?.ok ? 'ok' : 'bad'}` }, `截图服务 ${snapshot?.services?.capture?.ok ? '在线' : '离线'}`),
            h('span', { className: `dsc-pill ${snapshot?.services?.voice?.ok ? 'ok' : 'bad'}` }, `RVC 语音服务 ${snapshot?.services?.voice?.ok ? '在线' : '离线'}`),
            h('span', { className: 'dsc-pill' }, `当前语音：${snapshot?.services?.voice?.backend?.backend === 'sapi' ? '系统语音' : snapshot?.services?.voice?.ok ? 'RVC' : '系统语音（兜底）'}`),
            snapshot?.services?.capture?.info?.source ? h('span', { className: 'dsc-badge' }, `截图源：${snapshot.services.capture.info.source}`) : null,
          ),
          h(Toggle, { checked: draft.services.autoStart, onChange: (value) => set('services.autoStart', value), label: '插件启动时自动拉起本地服务' }),
          h(Row, { label: '截图服务地址' },
            h('input', { className: 'dsc-text', value: draft.services.captureUrl, onChange: (e) => set('services.captureUrl', e.target.value) }),
          ),
          h(Row, { label: '语音服务地址' },
            h('input', { className: 'dsc-text', value: draft.services.voiceUrl, onChange: (e) => set('services.voiceUrl', e.target.value) }),
          ),
          h('div', { className: 'dsc-flex' },
            h('button', { className: 'dsc-btn', onClick: async () => {
              try {
                await apiPost('/services/ensure');
                notify?.('已请求拉起服务');
              } catch (error) {
                notify?.(`拉起失败：${error.message}`, 'error');
              }
            } }, h(Icon, { path: ICONS.play }), '拉起服务'),
            h('button', { className: 'dsc-btn', onClick: async () => {
              try {
                await apiPost('/services/restart', { kind: 'capture' });
                notify?.('截图服务已重启');
              } catch (error) {
                notify?.(`重启失败：${error.message}`, 'error');
              }
            } }, '重启截图'),
            h('button', { className: 'dsc-btn', onClick: async () => {
              try {
                await apiPost('/services/restart', { kind: 'voice' });
                notify?.('语音服务已重启（首次加载模型较慢）');
              } catch (error) {
                notify?.(`重启失败：${error.message}`, 'error');
              }
            } }, '重启语音'),
            h('button', { className: 'dsc-btn ghost', onClick: () => loadServiceLog('capture') }, '截图日志'),
            h('button', { className: 'dsc-btn ghost', onClick: () => loadServiceLog('voice') }, '语音日志'),
          ),
          showLog
            ? h('div', null, h('textarea', { className: 'dsc-log', readOnly: true, value: serviceLog }), h('button', { className: 'dsc-btn ghost', onClick: () => setShowLog(false) }, '收起日志'))
            : null,
        ),
        h(
          Section,
          { title: '支持开发', icon: ICONS.heart ?? ICONS.brain },
          h('div', { className: 'dsc-row-hint', style: { margin: '0 0 4px' } },
            '如果这个小东西让你开心过，可以请作者喝杯咖啡；完全自愿，不影响任何功能。'),
          supportItems.length > 0
            ? h('div', { className: 'dsc-flex', style: { gap: 10, flexWrap: 'wrap', marginTop: 4 } },
                supportItems.map((item) =>
                  h('div', { key: item.name, style: { textAlign: 'center' } },
                    h('img', {
                      src: `${API}/support-asset?name=${encodeURIComponent(item.name)}`,
                      alt: item.name,
                      style: { width: 150, height: 'auto', borderRadius: 8, border: `1px solid ${COLORS.border}` },
                    }),
                    h('div', { className: 'dsc-row-hint', style: { fontSize: 10 } }, item.name.replace(/\.[^.]+$/, '')),
                  ),
                ),
              )
            : h('div', { className: 'dsc-row-hint', style: { marginTop: 4 } },
                '想换/加收款码：把图片放到 %USERPROFILE%\.dsh\dsh-companion\support\ 或插件包 assets\support\ 下，刷新面板即可。'),
        ),
        h(
          Section,
          { title: '高级', icon: ICONS.settings },
          h(Toggle, { checked: draft.debug.verbose, onChange: (value) => set('debug.verbose', value), label: '详细日志（把每轮画面/模型输出写进日志）' }),
          h(Row, { label: '数据目录', hint: '配置、历史、截图帧、服务日志都在这里。' },
            h('span', { className: 'dsc-sub', style: { wordBreak: 'break-all' } }, snapshot?.dirs?.home ?? ''),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' } },
          h('button', { className: 'dsc-btn primary', disabled: saving, onClick: save }, saving ? '保存中…' : '保存配置'),
          h('button', {
            className: 'dsc-btn ghost',
            onClick: async () => {
              try {
                const data = await apiGet('/config');
                setDraft(JSON.parse(JSON.stringify(data.config)));
                notify?.('已重新载入');
              } catch (error) {
                notify?.(`载入失败：${error.message}`, 'error');
              }
            },
          }, '重新载入'),
          h('span', { className: 'dsc-sub' }, '保存后立即生效，不需要重启 DSH。'),
        ),
      );
    }

    // ── 主面板 ────────────────────────────────────────────────────────────

    function CompanionView(props) {
      const [snapshot, setSnapshot] = useState(null);
      const [models, setModels] = useState(null);
      const [voices, setVoices] = useState([]);
      const [voiceState, setVoiceState] = useState({ loading: true, error: '', data: null });
      const [tab, setTab] = useState('chat');
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [draft, setDraft] = useState('');
      const [sending, setSending] = useState(false);
      const [preview, setPreview] = useState('');
      const [confirmNew, setConfirmNew] = useState(false);
      const chatRef = useRef(null);
      const aliveRef = useRef(true);
      const visible = props?.visible !== false;

      // 声线目录：force=1 绕过宿主的 60 秒缓存；加载中允许有限次重试（服务刚启动时用）
      const refreshVoices = useCallback(async ({ force = true, retries = 0 } = {}) => {
        if (aliveRef.current) setVoiceState((previous) => ({ ...previous, loading: true, error: '' }));
        let lastError = null;
        for (let attempt = 0; attempt <= retries; attempt += 1) {
          try {
            const data = await apiGet(`/voices${force ? '?force=1' : ''}`);
            if (!aliveRef.current) return data;
            const list = Array.isArray(data?.voices) ? data.voices : [];
            setVoices(list);
            setVoiceState({ loading: false, error: '', data });
            return data;
          } catch (error) {
            lastError = error;
            if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 700 + attempt * 800));
          }
        }
        if (aliveRef.current) {
          setVoiceState((previous) => ({ ...previous, loading: false, error: lastError?.message || '读取声线失败' }));
        }
        return null;
      }, []);

      const notify = useCallback((message, kind = 'info') => {
        setNotice(message);
        setTimeout(() => {
          if (aliveRef.current) setNotice('');
        }, 2600);
        if (kind === 'error') setError(message);
      }, []);

      const refresh = useCallback(async () => {
        try {
          const data = await apiGet('/state');
          if (!aliveRef.current) return;
          setSnapshot(data);
          setError('');
        } catch (err) {
          if (aliveRef.current) setError(`读不到陪伴状态：${err.message}`);
        }
      }, []);

      useEffect(() => {
        aliveRef.current = true;
        void refresh();
        void apiGet('/models').then(setModels).catch(() => {});
        void refreshVoices({ force: true, retries: 3 });
        const timer = setInterval(() => {
          if (document.visibilityState === 'hidden') return;
          void refresh();
        }, visible ? 2000 : 6000);
        return () => {
          aliveRef.current = false;
          clearInterval(timer);
        };
      }, [refresh, visible]);

      useEffect(() => {
        const node = chatRef.current;
        if (!node) return;
        node.scrollTop = node.scrollHeight;
      }, [snapshot?.history?.length, snapshot?.phase]);

      // 服务从“未启动”变成“已启动”时自动恢复下拉框，不需要刷新整个 DSH
      const previousVoiceServiceOk = useRef(true);
      useEffect(() => {
        const ok = Boolean(snapshot?.services?.voice?.ok);
        if (ok && !previousVoiceServiceOk.current) void refreshVoices({ force: true, retries: 3 });
        previousVoiceServiceOk.current = ok;
      }, [snapshot?.services?.voice?.ok, refreshVoices]);

      const history = snapshot?.history ?? [];
      companionName = snapshot?.config?.persona?.name || '陪玩';
      const game = snapshot?.game;
      // 服务离线 ≠ 功能坏了：截图有 PowerShell 兜底、语音有 Windows 系统语音兜底，
      // 面板要按「实际能不能干活」显示，而不是只看服务在线状态。
      const captureServiceOk = Boolean(snapshot?.services?.capture?.ok);
      const captureFallback = snapshot?.lastFrame?.source === 'ps';
      const captureOk = captureServiceOk || captureFallback;
      const voiceServiceOk = Boolean(snapshot?.services?.voice?.ok);
      const voiceBackendNow = snapshot?.services?.voice?.backend?.backend ?? snapshot?.lastVoice?.backend ?? 'unknown';
      const voiceOk = voiceServiceOk || voiceBackendNow === 'sapi';
      const voiceEnabled = snapshot?.config?.voice?.enabled !== false;
      const running = snapshot?.enabled;
      const phase = snapshot?.phase ?? 'paused';
      const busy = Boolean(snapshot?.busy) || phase === 'thinking' || phase === 'capturing' || phase === 'speaking';
      const countdown = snapshot?.nextTickInMs != null ? Math.ceil(snapshot.nextTickInMs / 1000) : null;

      const statusText = !snapshot
        ? '连接中…'
        : running
          ? `${PHASE_TEXT[phase] ?? phase}${countdown != null && phase === 'idle' ? ` · ${countdown}s 后` : ''}`
          : '已暂停（不会截屏、不会调模型）';

      const doToggle = async () => {
        try {
          await apiPost(running ? '/stop' : '/start');
          await refresh();
          notify(running ? '已暂停观察' : '已开始观察');
        } catch (err) {
          notify(`操作失败：${err.message}`, 'error');
        }
      };

      const doCaptureNow = async () => {
        try {
          setNotice('正在看一眼…');
          const result = await apiPost('/capture-now');
          await refresh();
          if (result.result?.ok) notify(`它说：${result.result.say}`);
          else notify(result.result?.message ?? result.result?.reason ?? '这一轮没看成', 'error');
        } catch (err) {
          notify(`失败：${err.message}`, 'error');
        }
      };

      const doStopSpeaking = async () => {
        try {
          await apiPost('/stop-speaking');
          notify('已停止朗读');
        } catch (err) {
          notify(`失败：${err.message}`, 'error');
        }
      };

      const doNewConversation = async () => {
        if (!confirmNew) {
          setConfirmNew(true);
          setTimeout(() => {
            if (aliveRef.current) setConfirmNew(false);
          }, 8000);
          return;
        }
        setConfirmNew(false);
        try {
          const result = await apiPost('/new-conversation', { summarize: true });
          if (result.state) setSnapshot(result.state);
          else await refresh();
          notify(result.summary ? `已开新对话（前情提要：${result.summary}）` : `已开新对话（归档 ${result.archived} 条）`);
        } catch (err) {
          notify(`开新对话失败：${err.message}`, 'error');
        }
      };

      const doSend = async () => {
        const text = draft.trim();
        if (!text || sending) return;
        setSending(true);
        setDraft('');
        try {
          const result = await apiPost('/chat', { text });
          if (result.state) setSnapshot(result.state);
          else await refresh();
        } catch (err) {
          setDraft(text);
          notify(`发送失败：${err.message}`, 'error');
        } finally {
          setSending(false);
        }
      };

      return h(
        'div',
        { className: 'dsc-root' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'dsc-header' },
          h(Dot, { ok: running && captureOk && (voiceOk || !voiceEnabled), busy }),
          h('span', { className: 'dsc-title' }, '陪玩'),
          h('span', { className: 'dsc-sub', title: statusText }, statusText),
          h('span', { className: 'dsc-spacer' }),
          h('button', { className: 'dsc-btn', disabled: !snapshot, onClick: doToggle, title: running ? '暂停观察' : '开始观察' },
            h(Icon, { path: running ? ICONS.pause : ICONS.play }), running ? '暂停' : '开始'),
          h('button', { className: 'dsc-btn', disabled: !snapshot, onClick: doCaptureNow, title: '立刻看一眼（强制跑一轮）' },
            h(Icon, { path: ICONS.eye }), '看一眼'),
          h('button', { className: 'dsc-btn ghost', disabled: !snapshot, onClick: doStopSpeaking, title: '停止朗读' },
            h(Icon, { path: ICONS.mute })),
        ),
        h(
          'div',
          { className: 'dsc-tabs' },
          h('button', { className: `dsc-tab${tab === 'chat' ? ' active' : ''}`, onClick: () => setTab('chat') }, '聊天'),
          h('button', { className: `dsc-tab${tab === 'settings' ? ' active' : ''}`, onClick: () => setTab('settings') }, '设置'),
        ),
        error ? h('div', { className: 'dsc-error' }, error) : null,
        notice && !error ? h('div', { className: 'dsc-sub', style: { padding: '6px 14px 0' } }, notice) : null,
        game
          ? h(
              'div',
              { className: 'dsc-game' },
              snapshot?.lastFrame
                ? h('img', { className: 'dsc-thumb', src: `${API}/frame/${snapshot.lastFrame.tickId}/0`, alt: '最近画面', loading: 'lazy', onClick: () => setPreview(`${API}/frame/${snapshot.lastFrame.tickId}/0`) })
                : null,
              h(
                'div',
                { className: 'dsc-game-main' },
                h('div', { className: 'dsc-game-title' }, game.label || game.process || '未知游戏'),
                h('div', { className: 'dsc-game-meta' }, `已陪 ${game.playingForText || '0 秒'} · ${game.sceneLabel || '陪玩'} · ${game.genre === 'long' ? '长记忆' : game.genre === 'short' ? '短记忆' : ''}`),
              ),
              h('span', { className: 'dsc-pill' }, game.sceneLabel || (game.fullscreen ? '全屏' : '窗口')),
            )
          : tab === 'chat' && history.length === 0
            ? h('div', { className: 'dsc-empty' }, running ? '还没进入陪伴场景。切到游戏 / 视频 / 编辑器，或者点「看一眼」。' : `已暂停。点「开始」让${companionName}继续陪你。`)
            : null,

        tab === 'chat'
          ? h(
              'div',
              { className: 'dsc-body' },
              h(
                'div',
                { className: 'dsc-chatbar' },
                h('span', { className: 'dsc-chatbar-text' },
                  snapshot?.conversation
                    ? `本次对话 ${snapshot.conversation.turns} 轮 · 上下文约 ${fmtNumber(snapshot.conversation.contextChars)} 字${snapshot.conversation.summary ? ' · 带前情提要' : ''}`
                    : ''),
                h('span', { className: 'dsc-spacer', style: { flex: 1 } }),
                h('button', {
                  className: `dsc-btn ghost${confirmNew ? ' danger' : ''}`,
                  onClick: doNewConversation,
                  title: '清空上下文开始新的一段对话；旧记录会归档到本地',
                }, confirmNew ? '再点一次确认' : '开新对话'),
              ),
              h(
                'div',
                { className: 'dsc-chat', ref: chatRef },
                history.length === 0
                  ? h('div', { className: 'dsc-empty' }, '等它看到你在玩/看/做什么，就会开口。\n也可以直接在下面跟它聊。')
                  : history.map((entry) => h(Bubble, { key: entry.id, entry, onPreviewFrame: setPreview })),
                busy && (phase === 'thinking' || phase === 'capturing') ? h('div', { className: 'dsc-thinking' }, `${PHASE_TEXT[phase] ?? '想想'}…`) : null,
              ),
              h(
                'div',
                { className: 'dsc-composer' },
                h('textarea', {
                  className: 'dsc-input',
                  value: draft,
                  placeholder: `跟${companionName}说点什么…（Enter 发送，Shift+Enter 换行）`,
                  onChange: (event) => setDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void doSend();
                    }
                  },
                }),
                h('button', { className: 'dsc-btn primary', disabled: sending || !draft.trim(), onClick: doSend }, sending ? '…' : h(Icon, { path: ICONS.send })),
              ),
            )
          : h(SettingsView, { snapshot, models, voices, voiceState, onRefreshVoices: refreshVoices, notify, onSaved: (config) => setSnapshot((previous) => (previous ? { ...previous, config } : previous)) }),

        h(
          'div',
          { className: 'dsc-footer' },
          h('span', null, `观察 ${fmtNumber(snapshot?.stats?.ticks)} 次`),
          snapshot?.stats?.conversations ? h('span', null, `新对话 ${fmtNumber(snapshot.stats.conversations)} 次`) : null,
          h('span', null, `跳过 ${fmtNumber(snapshot?.stats?.skipped)}`),
          h('span', null, `失败 ${fmtNumber(snapshot?.stats?.failures)}`),
          h('span', null, `tokens ${fmtNumber((snapshot?.stats?.tokensIn ?? 0) + (snapshot?.stats?.tokensOut ?? 0))}`),
          h('span', null, `朗读 ${fmtNumber(snapshot?.stats?.spokenChars)} 字`),
          h('span', { className: 'dsc-spacer', style: { flex: 1 } }),
          snapshot?.lastTickMs ? h('span', null, `上一轮 ${(snapshot.lastTickMs / 1000).toFixed(1)}s`) : null,
          h('span', { className: `dsc-pill ${captureServiceOk ? 'ok' : captureFallback ? 'warn' : 'bad'}` },
            captureServiceOk ? '截图✓' : captureFallback ? '截图✓兜底' : '截图✗'),
          h('span', { className: `dsc-pill ${voiceServiceOk ? 'ok' : voiceBackendNow === 'sapi' ? 'warn' : 'bad'}` },
            !voiceEnabled ? '语音关' : voiceServiceOk ? '语音✓RVC' : voiceBackendNow === 'sapi' ? '语音✓系统' : '语音✗'),
        ),
        preview
          ? h(
              'div',
              {
                style: {
                  position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.72)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out',
                },
                onClick: () => setPreview(''),
              },
              h('img', { src: preview, alt: '画面', style: { maxWidth: '86vw', maxHeight: '82vh', borderRadius: 8, boxShadow: '0 12px 40px rgba(0,0,0,0.5)' } }),
            )
          : null,
      );
    }

    // ── 注册为右侧栏 tab ──────────────────────────────────────────────────

    function CompanionTabIcon({ size = 16 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M6 8h12a4 4 0 014 4l-1.2 5.2A2.5 2.5 0 0117 18l-1.6-2H8.6L7 18a2.5 2.5 0 01-2.8-1.5L3 12a4 4 0 013-4z' }),
        h('path', { d: 'M8 10v4M6 12h4' }),
        h('path', { d: 'M15 11h.01M18 13h.01' }),
      );
    }

    // 静态依赖：官方右侧栏的两个服务（任何 profile 都有；better-sidebar 也是建在它们之上）。
    // 用静态 inject 而不是 ctx.inject：apply 只在两个服务都就绪后才会被调用，取服务是直接属性访问。
    const inject = ['slots', 'sidebarRightTabs'];
    /** 只注册一次。 */
    let registered = false;
    const TAB_ID = 'dsh-companion:companion';

    function registerNativeTab(ctx) {
      let tabs;
      let slots;
      try {
        tabs = ctx.sidebarRightTabs;
        slots = ctx.slots;
      } catch (error) {
        console.warn('[dsh-companion] 取右侧栏服务失败：' + String(error));
        return;
      }
      if (!tabs || !slots || registered) return;
      registered = true;
      try {
        ctx.effect(
          () =>
            tabs.register({
              id: TAB_ID,
              kind: TAB_ID,
              priority: 'extension',
              title: () => '陪玩',
              guide: [
                {
                  id: TAB_ID,
                  order: 45,
                  title: () => '陪玩',
                  description: () => '看屏幕陪你玩游戏、看动漫剧、写代码的陪伴助手：自动喝彩/吐槽/分析/陪聊，会用本地声线念出来。',
                },
              ],
            }),
          'dsh-companion: native sidebar tab type',
        );
        ctx.effect(
          () =>
            slots.inject('sidebar.right.pane.tab', () =>
              slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, (props) => h(CompanionView, props)),
            ),
          'dsh-companion: native sidebar tab body',
        );
      } catch (error) {
        console.warn('[dsh-companion] 注册右侧栏 tab 失败：' + String(error));
      }
    }

    function apply(ctx) {
      // 先挂官方右侧栏（干净 profile 与桌面 profile 都能用）
      registerNativeTab(ctx);
      // 如果装了 dsh-better-sidebar，再叠一层它的 tab（它内部也是原生 tab；桌面 profile 走这条
      // 会更贴合侧栏的启停开关/设置页，两个 guard 保证只注册一次）
      if (typeof ctx.inject === 'function') {
        ctx.inject(['betterSidebar'], (injected) => {
          if (registered) return;
          const sidebar = typeof injected?.get === 'function' ? injected.get('betterSidebar') : injected?.betterSidebar;
          if (!sidebar || typeof sidebar.registerTab !== 'function') return;
          registered = true;
          const dispose = sidebar.registerTab({
            id: TAB_ID,
            title: () => '陪玩',
            description: () => '看屏幕陪你玩游戏、看动漫剧、写代码的陪伴助手：自动喝彩/吐槽/分析/陪聊，会用本地声线念出来。',
            icon: (size) => h(CompanionTabIcon, { size }),
            order: 45,
            single: true,
            component: (props) => h(CompanionView, props),
          });
          ctx.effect(() => dispose, 'dsh-companion: betterSidebar tab');
        });
      }
    }

    return { name: '@jyddwy/dsh-companion', inject, apply };
  },
});
