// config.mjs —— 陪玩插件的配置：出厂默认 + 用户覆盖层 + 归一化。
//
// 配置存在 $DSH_HOME/dsh-companion/config.json（用户的覆盖层）。插件行的 config
// （profile patch 里写的那一份）作为部署默认值叠在最底下；设置面板改的是用户层。
// 这里只做纯逻辑，不碰 ctx，方便单测。
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { defaultCastConfig, normalizeCast } from './cast.mjs';

/** 数据目录：DSH_HOME/dsh-companion（DSH_HOME 缺失时退到 ~/.dsh）。 */
export function dataDir() {
  const home = process.env.DSH_HOME || path.join(homedir(), '.dsh');
  return path.join(home, 'dsh-companion');
}

/** 出厂默认值。所有字段都必须有默认值：设置面板、归一化、前端都靠它兜底。 */
export const DEFAULTS = Object.freeze({
  /** 总开关。装好即开；不想被看的时候在侧栏关掉。 */
  enabled: true,
  /** 两次观察之间的间隔（秒）。文档默认 45 秒。 */
  intervalSec: 45,
  /** 检测到游戏后先等多久再开口（秒），避免刚进游戏就聒噪。 */
  warmupSec: 5,
  /** 截图与连拍 */
  capture: {
    /** 一次触发连拍几帧 */
    frameCount: 3,
    /** 相邻两帧的间隔（毫秒）。文档里的「每隔 5 帧截一次」≈ 30fps 下 167ms，
     *  默认取 300ms 让三帧能看出动作差异；想严格按帧数可自己换算后填。 */
    frameIntervalMs: 300,
    /** 长边缩到多少像素（越小越省钱，1280 足够识图） */
    maxLongEdge: 1280,
    /** JPEG 质量（60-90 合理） */
    jpegQuality: 72,
    /** true=截整屏（推荐，游戏全屏/无边框都行）；false=只截前台窗口 */
    fullScreen: true,
    /** 截图缓存自动清理：最多保留最近多少轮 */
    keepFrames: 20,
    /** 截图缓存总占用上限（MB，0=不限） */
    maxFramesMB: 200,
    /** 截图缓存保留时长（小时，0=不限） */
    retentionHours: 12,
  },
  /** 识图模型（留空 = 自动：优先当前对话模型，其次注册表里声明支持图片的模型） */
  vision: {
    provider: '',
    model: '',
    timeoutMs: 90000,
    maxTokens: 1500,
    /** 识图思考强度：识图只抽 JSON，默认关掉思考（省钱、避免 max-tokens 截断） */
    reasoningEffort: 'off',
  },
  /** 出话模型（留空 = 当前对话模型） */
  talk: {
    provider: '',
    model: '',
    timeoutMs: 90000,
    maxTokens: 700,
    temperature: 1,
    /** 出话思考强度：陪聊默认 low（够用、快、省；想更认真可调 high/max） */
    reasoningEffort: 'low',
    /** 禁止「放到任何场景都成立」的陪聊空话；命中时要求模型重写一次 */
    banFiller: true,
    /** 观察型台词里尽量不用问句（玩家没空回答）；命中时要求改成陈述/感叹 */
    banQuestions: true,
    /** 喝彩模式：少说教/少盯 HUD 数字，多回应击杀、爆炸、开火等高光动作 */
    cheerMode: true,
  },
  /** 字幕：把陪玩说的话像歌词一样悬浮显示在桌面最上层（可拖动/改字号字体） */
  subtitle: {
    /** 默认关；打开后由插件拉起一个独立的置顶字幕窗口 */
    enabled: false,
    fontSize: 28,
    fontFamily: 'Microsoft YaHei',
    /** 一句字幕停留多少秒 */
    displaySec: 8,
    /** 字幕相对语音开始的额外延时（秒）。0 = 语音一开始就显示；用于补偿不同机器的合成延迟 */
    delaySec: 0,
    /** 双色渐变的第一种颜色（#rrggbb），默认偏白 */
    color: '#eaf6ff',
    /** 双色渐变的第二种颜色（#rrggbb），默认蓝 */
    color2: '#4da3ff',
    /** 鼠标穿透：开启后字幕不挡游戏鼠标；按住 Ctrl 可临时拖动调整位置 */
    clickThrough: true,
    /** 背景黑底不透明度 0-1 */
    bgOpacity: 0.45,
    /** 整窗不透明度 0.1-1 */
    opacity: 0.95,
  },
  /** 世界书：游戏资料（联网调研 + 可手改），用于压住模型幻觉和游戏理解错误 */
  worldbook: {
    /** 总开关（关掉后不调研、也不往提示词里塞资料） */
    enabled: true,
    /** 第一次识别到某个游戏时，自动联网调研并生成世界书 */
    autoResearch: true,
    /** 每次喂给模型的资料上限（字符） */
    maxPromptChars: 1400,
  },
  /** 语音输出（TTS + RVC，由本地 voice-service 提供） */
  voice: {
    enabled: true,
    /** 语音后端：auto=优先 RVC 语音服务，不可用时用 Windows 系统语音；service=只用 RVC；sapi=只用系统语音 */
    backend: 'auto',
    /** 声线 id，见 voice-service 的 /voices（系统语音后端下不生效） */
    voiceId: 'shogun',
    /** 升降调（半音） */
    pitch: 0,
    /** 语速倍率 */
    speed: 1.0,
    /** 陪玩语音音量（0-2，1=原始音量；只影响陪玩自己，不动系统音量） */
    volume: 1.0,
    /** 用户打字回复后的回答也读出来 */
    speakReplies: true,
    /** 一句最多读多少字（超出截断，避免长篇朗读） */
    maxChars: 140,
    /** 同一句话在这段时间内不重复读（秒） */
    dedupeWindowSec: 30,
    /** 让语音服务按台词情绪调整语调（开心/吐槽/认真…） */
    emotionEnabled: true,
  },
  /** 人格 */
  persona: {
    /** 关系身份：你在用户身边是谁（朋友/搭档/青梅/迷妹……） */
    relation: '温柔的陪伴者',
    /** 陪伴者显示名：面板头像/输入框/暂停文案用（朋友的 DSH 人设不叫卡律时改成自己的） */
    name: '陪玩',
    /** 陪伴风格：gentle=温柔陪伴鼓励（默认）；tsundere=损友吐槽；cheerful=元气捧场；analyst=冷静分析 */
    style: 'gentle',
    /** 追加的人设文本（可写口癖、称呼、禁忌） */
    extra: '',
    /** 复用 DSH 本体 AGENTS.md 的人格设定 */
    useAgentsMd: true,
    /** 内置提示词块的自定义覆盖（留空=用默认）；键：style/honesty/filler/cheer/questions */
    promptOverrides: {},
    /** 额外读取的 AGENTS.md 绝对路径（留空 = 只读 $DSH_HOME/AGENTS.md） */
    extraAgentsMd: '',
  },
  /** 一人分饰多角：总开关 + 最多 3 个角色槽（角色卡/声线/是否继承 AGENTS.md 各自独立） */
  cast: defaultCastConfig(),
  /** 行为策略 */
  behavior: {
    /** 只在识别到的「陪伴场景」里工作（场景开关见下） */
    onlyWhenGame: true,
    /** 陪伴场景开关：游戏 / 看动漫和剧 / 写代码做文件 */
    scenarios: {
      game: true,
      watching: true,
      coding: true,
    },
    /** 各场景的默认观察间隔（秒；游戏沿用 intervalSec） */
    watchingIntervalSec: 60,
    codingIntervalSec: 90,
    /** 必须全屏才算游戏（默认 false：窗口化的剧情游戏也算） */
    requireFullscreen: false,
    /** 最小化的窗口不算 */
    ignoreMinimized: true,
    /** 游戏识别白名单（匹配窗口标题或进程名，不区分大小写，支持 * 通配） */
    games: [
      'PUBG*', 'BATTLEGROUNDS*', 'Monster Hunter*', 'MHRise*', 'MHW*', 'Wilds*',
      'VA-11*', 'Valhalla*', 'RimWorld*', 'Terraria*', 'Stardew*', 'Factorio*',
      'Elden Ring*', 'Dark Souls*', 'Sekiro*', 'Hades*', 'Hollow Knight*',
      'Genshin*', '原神*', 'Star Rail*', '崩坏*', '鸣潮*', 'Wuthering*',
      'League of Legends*', 'VALORANT*', 'Apex*', 'CS2*', 'Counter-Strike*',
      'Dota*', 'Overwatch*', 'Rainbow Six*', 'Tarkov*', '永劫无间*', 'NARAKA*',
      'Cyberpunk*', 'The Witcher*', 'Baldur*', 'BG3*', 'Stellaris*', 'Civilization*',
      'Total War*', 'Oxygen Not Included*', 'Slay the Spire*', 'Balatro*',
    ],
    /** 永远不算游戏的进程（DSH 自己、浏览器、编辑器……顺手挡掉） */
    ignoreProcesses: [
      'DeepSeek Harness', 'dsh', 'explorer', 'msedge', 'chrome', 'firefox',
      'Code', 'Cursor', 'devenv', 'notepad', 'WindowsTerminal', 'cmd', 'powershell',
      'pwsh', 'SystemSettings', 'Taskmgr', 'ShellExperienceHost', 'SearchHost',
      'Discord', 'QQ', 'WeChat', 'Telegram',
    ],
    /** 键鼠空闲超过这个秒数就暂停（0 = 不暂停） */
    pauseWhenIdleSec: 240,
    /** 画面和上一次几乎一样就跳过这一轮（省钱） */
    skipUnchanged: true,
    /** 每小时最多观察几次（0 = 不限） */
    maxTicksPerHour: 120,
    /** 记忆范围：auto=按游戏类型自动；short=动作/射击类；long=剧情/策略类 */
    memoryMode: 'auto',
    /** short 记忆窗口（秒） */
    memoryShortSec: 150,
    /** long 记忆窗口（秒） */
    memoryLongSec: 1200,
    /** 保留多少条历史进上下文 */
    historyLimit: 40,
    /** 开新对话时，是否先让模型总结一句「前情提要」带入后续 */
    summaryOnNewConversation: true,
  },
  /** 本地服务（截图 / 语音） */
  services: {
    /** 插件启动时自动拉起两个本地服务 */
    autoStart: true,
    captureUrl: 'http://127.0.0.1:9124',
    voiceUrl: 'http://127.0.0.1:9123',
    /** Python 解释器（留空 = 自动探测） */
    capturePython: '',
    voicePython: '',
    /** 服务脚本绝对路径（留空 = 用包内 services/ 下的副本 / 项目目录下的实现） */
    captureScript: '',
    voiceScript: '',
    /** 服务健康检查间隔（秒） */
    healthIntervalSec: 30,
  },
  /** 调试 */
  debug: {
    /** 是否把每轮画面/模型输出写进日志 */
    verbose: false,
  },
});

/** 深合并：默认值 ← 部署默认 ← 用户层。数组整体替换，不合并。 */
export function mergeConfig(...layers) {
  const out = structuredClone(DEFAULTS);
  for (const layer of layers) deepAssign(out, layer);
  return out;
}

/** 把局部 patch 深合并进用户覆盖层（用于 POST /config 的单项修改，避免整组字段被重置）。 */
export function mergeUserConfig(base, patch) {
  const out = base && typeof base === 'object' ? structuredClone(base) : {};
  deepAssign(out, patch);
  return out;
}

function deepAssign(target, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return target;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      target[key] = structuredClone(value);
    } else if (value && typeof value === 'object') {
      if (target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
        deepAssign(target[key], value);
      } else {
        target[key] = structuredClone(value);
      }
    } else {
      target[key] = value;
    }
  }
  return target;
}

const clampNumber = (value, fallback, min, max) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
};

/** 归一化：把面板/手改配置里越界的值拉回合法范围，类型错误一律回默认。 */
export function normalizeConfig(input) {
  const merged = mergeConfig(input);
  merged.enabled = Boolean(merged.enabled);
  merged.intervalSec = clampNumber(merged.intervalSec, 45, 10, 3600);
  merged.warmupSec = clampNumber(merged.warmupSec, 5, 0, 600);

  merged.capture.frameCount = Math.round(clampNumber(merged.capture.frameCount, 3, 1, 8));
  merged.capture.frameIntervalMs = Math.round(clampNumber(merged.capture.frameIntervalMs, 300, 0, 2000));
  merged.capture.maxLongEdge = Math.round(clampNumber(merged.capture.maxLongEdge, 1280, 320, 2560));
  merged.capture.jpegQuality = Math.round(clampNumber(merged.capture.jpegQuality, 72, 40, 95));
  merged.capture.keepFrames = Math.round(clampNumber(merged.capture.keepFrames, 20, 0, 500));
  merged.capture.maxFramesMB = Math.round(clampNumber(merged.capture.maxFramesMB, 200, 0, 10000));
  merged.capture.retentionHours = Math.round(clampNumber(merged.capture.retentionHours, 12, 0, 720));
  merged.capture.fullScreen = Boolean(merged.capture.fullScreen);

  for (const key of ['vision', 'talk']) {
    merged[key].provider = String(merged[key].provider ?? '').trim();
    merged[key].model = String(merged[key].model ?? '').trim();
    merged[key].timeoutMs = Math.round(clampNumber(merged[key].timeoutMs, 90000, 10000, 180000));
  }
  merged.vision.maxTokens = Math.round(clampNumber(merged.vision.maxTokens, 900, 128, 4000));
  merged.talk.maxTokens = Math.round(clampNumber(merged.talk.maxTokens, 700, 64, 4000));
  merged.talk.temperature = clampNumber(merged.talk.temperature, 1, 0, 2);

  merged.voice.enabled = Boolean(merged.voice.enabled);
  merged.voice.backend = ['auto', 'service', 'sapi'].includes(merged.voice.backend) ? merged.voice.backend : 'auto';
  merged.voice.voiceId = String(merged.voice.voiceId || 'shogun').trim();
  merged.voice.pitch = Math.round(clampNumber(merged.voice.pitch, 0, -12, 12));
  merged.voice.speed = clampNumber(merged.voice.speed, 1, 0.5, 2);
  merged.voice.volume = clampNumber(merged.voice.volume, 1, 0, 2);
  merged.voice.speakReplies = Boolean(merged.voice.speakReplies);
  merged.voice.maxChars = Math.round(clampNumber(merged.voice.maxChars, 140, 20, 400));
  merged.voice.dedupeWindowSec = Math.round(clampNumber(merged.voice.dedupeWindowSec, 30, 0, 3600));
  merged.voice.emotionEnabled = merged.voice.emotionEnabled !== false;

  merged.persona.relation = String(merged.persona.relation || '损友').slice(0, 40);
  merged.persona.extra = String(merged.persona.extra ?? '').slice(0, 4000);
  merged.persona.useAgentsMd = Boolean(merged.persona.useAgentsMd);
  merged.persona.extraAgentsMd = String(merged.persona.extraAgentsMd ?? '').trim();

  const behavior = merged.behavior;
  const EFFORTS = new Set(['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  for (const key of ['vision', 'talk']) {
    const value = String(merged[key].reasoningEffort ?? 'auto').trim().toLowerCase();
    merged[key].reasoningEffort = EFFORTS.has(value) ? value : 'auto';
  }
  const styles = new Set(['gentle', 'tsundere', 'cheerful', 'analyst']);
  merged.persona.style = styles.has(String(merged.persona.style)) ? String(merged.persona.style) : 'gentle';
  merged.persona.name = String(merged.persona.name ?? '').trim().slice(0, 20) || '陪玩';
  merged.persona.relation = String(merged.persona.relation ?? '').trim().slice(0, 40) || '温柔的陪伴者';
  if (merged.persona.style === 'gentle' && ['损友', '毒舌损友'].includes(merged.persona.relation)) {
    merged.persona.relation = '温柔的陪伴者';
  }
  merged.talk.banFiller = merged.talk.banFiller !== false;
  merged.talk.cheerMode = merged.talk.cheerMode !== false;
  merged.talk.banQuestions = merged.talk.banQuestions !== false;
  const overrides = merged.persona.promptOverrides && typeof merged.persona.promptOverrides === 'object'
    ? merged.persona.promptOverrides
    : {};
  merged.persona.promptOverrides = {};
  for (const key of ['style', 'honesty', 'filler', 'cheer', 'questions']) {
    if (typeof overrides[key] === 'string' && overrides[key].trim()) {
      merged.persona.promptOverrides[key] = overrides[key].slice(0, 4000);
    }
  }
  merged.subtitle.enabled = merged.subtitle.enabled === true;
  merged.subtitle.fontSize = Math.round(clampNumber(merged.subtitle.fontSize, 28, 12, 96));
  merged.subtitle.displaySec = Math.round(clampNumber(merged.subtitle.displaySec, 8, 2, 60));
  merged.subtitle.delaySec = Math.round(clampNumber(merged.subtitle.delaySec, 0, 0, 10) * 10) / 10;
  merged.subtitle.bgOpacity = Math.round(clampNumber(merged.subtitle.bgOpacity, 0.45, 0, 1) * 100) / 100;
  merged.subtitle.opacity = Math.round(clampNumber(merged.subtitle.opacity, 0.95, 0.1, 1) * 100) / 100;
  merged.subtitle.fontFamily = String(merged.subtitle.fontFamily ?? '').trim().slice(0, 60) || 'Microsoft YaHei';
  merged.subtitle.color = /^#[0-9a-f]{6}$/i.test(String(merged.subtitle.color ?? '')) ? merged.subtitle.color : '#eaf6ff';
  merged.subtitle.color2 = /^#[0-9a-f]{6}$/i.test(String(merged.subtitle.color2 ?? ''))
    ? merged.subtitle.color2
    : merged.subtitle.color;
  merged.subtitle.clickThrough = merged.subtitle.clickThrough !== false;
  merged.cast = normalizeCast(merged.cast);
  merged.worldbook.enabled = merged.worldbook.enabled !== false;
  merged.worldbook.autoResearch = merged.worldbook.autoResearch !== false;
  merged.worldbook.maxPromptChars = Math.round(clampNumber(merged.worldbook.maxPromptChars, 1400, 400, 4000));
  behavior.onlyWhenGame = Boolean(behavior.onlyWhenGame);
  behavior.scenarios = behavior.scenarios && typeof behavior.scenarios === 'object' ? {
    game: behavior.scenarios.game !== false,
    watching: behavior.scenarios.watching !== false,
    coding: behavior.scenarios.coding !== false,
  } : { game: true, watching: true, coding: true };
  behavior.watchingIntervalSec = Math.round(clampNumber(behavior.watchingIntervalSec, 60, 20, 3600));
  behavior.codingIntervalSec = Math.round(clampNumber(behavior.codingIntervalSec, 90, 20, 3600));
  behavior.requireFullscreen = Boolean(behavior.requireFullscreen);
  behavior.ignoreMinimized = Boolean(behavior.ignoreMinimized);
  behavior.games = (Array.isArray(behavior.games) ? behavior.games : DEFAULTS.behavior.games)
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 200);
  behavior.ignoreProcesses = (Array.isArray(behavior.ignoreProcesses) ? behavior.ignoreProcesses : DEFAULTS.behavior.ignoreProcesses)
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 200);
  behavior.pauseWhenIdleSec = Math.round(clampNumber(behavior.pauseWhenIdleSec, 240, 0, 3600));
  behavior.skipUnchanged = Boolean(behavior.skipUnchanged);
  behavior.maxTicksPerHour = Math.round(clampNumber(behavior.maxTicksPerHour, 120, 0, 3600));
  behavior.memoryMode = ['auto', 'short', 'long'].includes(behavior.memoryMode) ? behavior.memoryMode : 'auto';
  behavior.memoryShortSec = Math.round(clampNumber(behavior.memoryShortSec, 150, 20, 3600));
  behavior.memoryLongSec = Math.round(clampNumber(behavior.memoryLongSec, 1200, 60, 14400));
  behavior.historyLimit = Math.round(clampNumber(behavior.historyLimit, 40, 4, 200));
  behavior.summaryOnNewConversation = behavior.summaryOnNewConversation !== false;

  const services = merged.services;
  services.autoStart = Boolean(services.autoStart);
  services.captureUrl = String(services.captureUrl || DEFAULTS.services.captureUrl).replace(/\/+$/, '');
  services.voiceUrl = String(services.voiceUrl || DEFAULTS.services.voiceUrl).replace(/\/+$/, '');
  services.capturePython = String(services.capturePython ?? '').trim();
  services.voicePython = String(services.voicePython ?? '').trim();
  services.captureScript = String(services.captureScript ?? '').trim();
  services.voiceScript = String(services.voiceScript ?? '').trim();
  services.healthIntervalSec = Math.round(clampNumber(services.healthIntervalSec, 30, 5, 600));

  merged.debug.verbose = Boolean(merged.debug.verbose);
  return merged;
}

/** 读用户覆盖层（不存在/坏掉 → 空对象，绝不抛）。 */
export async function readUserConfig() {
  const file = path.join(dataDir(), 'config.json');
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 写用户覆盖层（原子替换）。 */
export async function writeUserConfig(patch) {
  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(patch ?? {}, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/** 只把「允许面板改」的键挑出来，避免外部乱写污染配置。 */
export function pickKnownKeys(patch) {
  const accepted = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return accepted;
  for (const key of Object.keys(DEFAULTS)) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) accepted[key] = patch[key];
  }
  return accepted;
}
