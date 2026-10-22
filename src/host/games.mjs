// games.mjs —— 判断「现在是不是在玩游戏」以及「这款游戏该记多久」。
//
// 判定完全靠前台窗口信息（截图服务返回），不注入游戏进程、不读游戏内存：
//   1) 最小化/被忽略的进程 → 不是游戏
//   2) 命中游戏白名单（窗口标题或进程名，支持通配）→ 是游戏
//   3) 全屏且不在忽略列表 → 是游戏（视频播放器/浏览器全屏也可能命中，可关 onlyWhenGame）
//   4) 其它 → 不是游戏
import { matchPattern } from './util.mjs';

/** 剧情/策略类关键词：这些游戏允许回顾更久之前的上下文。 */
const LONG_MEMORY_HINTS = [
  'VA-11', 'VALHALLA', '视觉小说', '视觉', '剧情', 'RPG', 'RimWorld', '环世界',
  'Stardew', '星露谷', 'Factorio', '异星工厂', 'Civilization', '文明', 'Stellaris',
  '群星', 'Total War', '全面战争', 'Oxygen Not Included', '缺氧', 'Baldur', '博德之门',
  'Witcher', '巫师', 'Cyberpunk', '赛博朋克', 'Persona', '女神异闻录', '逆转裁判',
  'Disco Elysium', '极乐迪斯科', 'Slay the Spire', '杀戮尖塔', 'Balatro', '小丑牌',
  'Fire Emblem', '火焰纹章', 'XCOM', 'Into the Breach', '陷阵之志', 'Terraria', '泰拉瑞亚',
  'Minecraft', '我的世界', 'Cities', '城市', 'Anno', '纪元', 'Tropico', '海岛大亨',
];

/** 动作/射击类关键词：只参考最近一小段时间，绝不把上一局的事张冠李戴。 */
const SHORT_MEMORY_HINTS = [
  'PUBG', 'BATTLEGROUNDS', 'APEX', 'VALORANT', 'CS2', 'Counter-Strike', 'Dota',
  'League of Legends', '英雄联盟', 'Overwatch', '守望先锋', 'Rainbow Six', '彩虹六号',
  'Tarkov', '塔科夫', 'NARAKA', '永劫无间', 'Call of Duty', '使命召唤', 'Battlefield',
  '战地', 'Halo', '光环', 'Destiny', '命运', 'Elden Ring', '艾尔登法环', 'Dark Souls',
  '黑暗之魂', 'Sekiro', '只狼', 'Monster Hunter', '怪物猎人', 'Hades', '哈迪斯',
  'Devil May Cry', '鬼泣', 'Armored Core', '装甲核心', 'Nioh', '仁王', 'Bloodborne',
  '血源', 'Wuthering', '鸣潮', '原神', 'Genshin', 'Star Rail', '崩坏', 'Honkai',
];

function haystack(windowInfo) {
  return `${windowInfo?.title ?? ''} ${windowInfo?.process ?? ''} ${windowInfo?.className ?? ''}`;
}

/** 命中任意关键词（不区分大小写）。 */
function includesAny(text, hints) {
  const lower = String(text ?? '').toLowerCase();
  return hints.some((hint) => lower.includes(hint.toLowerCase()));
}

/**
 * 判断前台窗口是不是游戏。
 * @param {object|null} windowInfo capture 服务返回的窗口信息
 * @param {object} behavior config.behavior
 * @param {{idleSec?: number}} extra 额外信息（键鼠空闲）
 */
export function identifyGame(windowInfo, behavior, extra = {}) {
  const result = { isGame: false, reason: '', genre: 'unknown', matched: '' };
  if (!windowInfo || windowInfo.available === false) {
    result.reason = 'no-window';
    return result;
  }
  const process = String(windowInfo.process ?? '');
  const title = String(windowInfo.title ?? '');

  if (behavior.ignoreMinimized !== false && windowInfo.minimized) {
    result.reason = 'minimized';
    return result;
  }
  const ignored = (behavior.ignoreProcesses ?? []).some(
    (pattern) => matchPattern(pattern, process) || matchPattern(pattern, title),
  );
  if (ignored) {
    result.reason = 'ignored-process';
    return result;
  }

  const matchedPattern = (behavior.games ?? []).find(
    (pattern) => matchPattern(pattern, title) || matchPattern(pattern, process),
  );
  if (matchedPattern) {
    result.isGame = true;
    result.matched = matchedPattern;
    result.reason = 'whitelist';
  } else if (behavior.requireFullscreen === false && windowInfo.fullscreen && !ignored) {
    result.isGame = true;
    result.reason = 'fullscreen';
  } else if (behavior.requireFullscreen === true && windowInfo.fullscreen) {
    // requireFullscreen=true 时仍要求白名单，只有全屏的白名单游戏才算——上面已处理白名单，
    // 这里不再放行，保持语义严格。
    result.reason = 'not-whitelisted';
  } else {
    result.reason = 'not-game';
  }

  if (!result.isGame) return result;
  result.genre = classifyGenre(haystack(windowInfo).slice(0, 400));
  return result;
}

/** 粗分类：short（动作射击）/ long（剧情策略）/ unknown。 */
export function classifyGenre(text) {
  const hay = String(text ?? '');
  if (includesAny(hay, SHORT_MEMORY_HINTS)) return 'short';
  if (includesAny(hay, LONG_MEMORY_HINTS)) return 'long';
  return 'unknown';
}

/**
 * 这一轮该给模型多少历史（秒）。
 * auto: short=短窗口，long=长窗口，unknown=短窗口（保守，宁可不联系久远上下文）
 */
export function memoryWindowSec(behavior, genre) {
  switch (behavior.memoryMode) {
    case 'short':
      return behavior.memoryShortSec;
    case 'long':
      return behavior.memoryLongSec;
    case 'auto':
    default:
      return genre === 'long' ? behavior.memoryLongSec : behavior.memoryShortSec;
  }
}

/** 给模型看的游戏标签：白名单命中的写 title，否则进程名。 */
export function gameLabel(windowInfo) {
  if (!windowInfo) return '';
  const title = String(windowInfo.title ?? '').trim();
  const process = String(windowInfo.process ?? '').replace(/\.exe$/i, '');
  if (title && title.length <= 60) return title;
  return process || title;
}

// ── 陪伴场景识别（游戏 / 看动漫看剧 / 写代码做文件）─────────────────────
//
// 判定都用前台窗口的进程名、标题、全屏与最小化状态；不注入、不读内存。
// 顺序：游戏 → 看剧 → 写代码 → 其它。场景开关在 config.behavior.scenarios。

/** 代码编辑器 / 终端类进程（小写精确匹配，逗号分隔的进程名也接受子串匹配）。 */
const CODING_PROCESSES = [
  'code', 'code - insiders', 'cursor', 'windsurf', 'zed', 'trae',
  'devenv', 'idea64', 'pycharm64', 'webstorm64', 'goland64', 'clion64', 'rider64', 'studio64',
  'sublime_text', 'notepad++', 'windows-terminal', 'windowsterminal', 'wt',
  'cmd', 'powershell', 'pwsh', 'bash', 'wsl', 'emacs', 'nvim', 'vim',
];

const CODING_TITLE_HINTS = [
  'visual studio code', 'vscode', 'cursor', 'intellij', 'pycharm', 'webstorm',
  'sublime text', 'notepad++', 'windows terminal', 'powershell', 'command prompt',
  '命令提示符', '终端', 'vim', 'neovim',
];

/** 视频播放器进程。 */
const WATCHING_PROCESSES = [
  'potplayermini64', 'potplayermini', 'mpv', 'vlc', 'kmplayer', 'mpc-hc64', 'mpc-hc',
  'mpc-be64', 'mpc-be', 'netflix', 'disneyplus', 'plex', 'kodi', 'qqlive', 'iqiyi',
  'bilibili', '哔哩哔哩', 'youku', '优酷', 'tvn', 'mgtv',
];

/** 标题里的影视/动漫特征（浏览器里看 B 站/YouTube/爱奇艺时靠它认）。 */
const WATCHING_TITLE_HINTS = [
  'bilibili', '哔哩哔哩', 'youtube', 'netflix', '爱奇艺', 'iqiyi', '腾讯视频',
  '优酷', 'youku', 'acfun', '动漫', '动画', '番剧', '新番', 'ova', '剧场版',
  '电影', '电视剧', '纪录片', '综艺', '中字', '字幕', '1080p', '4k',
];

const BROWSER_PROCESSES = ['msedge', 'chrome', 'firefox', 'brave', 'opera', 'vivaldi', 'iexplore'];

/**
 * 场景识别里只硬性排除 DSH 自己：浏览器/编辑器/播放器虽然都在 behavior.ignoreProcesses 里
 * （那是为了不让「游戏识别」把它们当游戏），但陪看剧/陪写代码恰恰要认它们。
 */
const HARD_IGNORE = ['DeepSeek Harness', 'dsh'];

function anyMatch(list, value) {
  const target = String(value ?? '').toLowerCase();
  if (!target) return false;
  return list.some((item) => target.includes(String(item).toLowerCase()));
}

function looksLikeEpisode(text) {
  return /第\s*\d+\s*[集话話期]/.test(String(text ?? '')) || /\bS\d{1,2}E\d{1,2}\b/i.test(String(text ?? ''));
}

/** 是不是在「看动漫/看剧/看电影」。 */
export function isWatching(windowInfo, behavior) {
  if (!windowInfo || windowInfo.available === false) return false;
  if (behavior?.ignoreMinimized !== false && windowInfo.minimized) return false;
  const process = String(windowInfo.process ?? '');
  const title = String(windowInfo.title ?? '');
  if (anyMatch(HARD_IGNORE, process) || anyMatch(HARD_IGNORE, title)) return false;

  if (anyMatch(WATCHING_PROCESSES, process)) return true;
  const titleHit = anyMatch(WATCHING_TITLE_HINTS, title) || looksLikeEpisode(title);
  if (titleHit) return true;
  // 全屏浏览器：大概率是在放视频（B 站/YouTube 全屏时标题不一定带关键词）
  if (anyMatch(BROWSER_PROCESSES, process) && windowInfo.fullscreen) return true;
  return false;
}

/** 是不是在「写代码 / 做文件」。 */
export function isCoding(windowInfo, behavior) {
  if (!windowInfo || windowInfo.available === false) return false;
  if (behavior?.ignoreMinimized !== false && windowInfo.minimized) return false;
  const process = String(windowInfo.process ?? '');
  const title = String(windowInfo.title ?? '');
  if (anyMatch(HARD_IGNORE, process) || anyMatch(HARD_IGNORE, title)) return false;
  if (anyMatch(CODING_PROCESSES, process)) return true;
  if (anyMatch(CODING_TITLE_HINTS, title)) return true;
  return false;
}

/**
 * 统一场景识别：返回 { kind, scenario, label, memoryGenre, reason, ... }。
 * kind: 'game' | 'watching' | 'coding' | 'other'
 */
export function identifyScene(windowInfo, behavior) {
  const game = identifyGame(windowInfo, behavior);
  if (game.isGame) {
    return {
      ...game,
      kind: 'game',
      scenario: 'game',
      memoryGenre: game.genre,
      label: gameLabel(windowInfo),
    };
  }
  if (behavior?.scenarios?.watching !== false && isWatching(windowInfo, behavior)) {
    return {
      isGame: false,
      kind: 'watching',
      scenario: 'watching',
      memoryGenre: 'long',
      reason: 'watching',
      label: gameLabel(windowInfo),
    };
  }
  if (behavior?.scenarios?.coding !== false && isCoding(windowInfo, behavior)) {
    return {
      isGame: false,
      kind: 'coding',
      scenario: 'coding',
      memoryGenre: 'long',
      reason: 'coding',
      label: gameLabel(windowInfo),
    };
  }
  return {
    isGame: false,
    kind: 'other',
    scenario: 'other',
    memoryGenre: 'unknown',
    reason: 'not-scene',
    label: gameLabel(windowInfo),
  };
}

/** 场景的中文标签（面板用）。 */
export function scenarioLabel(kind) {
  switch (kind) {
    case 'game':
      return '陪玩';
    case 'watching':
      return '陪看剧';
    case 'coding':
      return '陪写代码';
    default:
      return '陪着你';
  }
}

/**
 * 这个场景观察后该隔多久再看（秒）。
 *
 * 注意：传的是完整 settings 而不是 behavior —— 游戏的间隔在顶层 `settings.intervalSec`，
 * 早期版本误读 `behavior.intervalSec`（undefined），算出来 NaN 会让 setTimeout 变成 0，
 * 表现就是「关不掉、连续刷观察」。这里也做数字兜底，杜绝 NaN 再进调度。
 */
export function sceneIntervalSec(settings, kind) {
  // v1.5：不再给看剧/写代码单独间隔（用户实测容易和顶层观察间隔混淆），
  // 所有场景统一用顶层的「观察间隔」；节奏差异靠面板里的预设一次改三个值。
  const number = Number(settings?.intervalSec);
  return Number.isFinite(number) && number > 0 ? number : 45;
}

/** 这个场景该给模型多少历史（秒）；同样只接受完整 settings。 */
export function sceneMemoryWindowSec(settings, kind, memoryGenre) {
  const behavior = settings?.behavior ?? {};
  const longSec = Number(behavior.memoryLongSec) > 0 ? Number(behavior.memoryLongSec) : 1200;
  if (kind === 'watching') return Math.max(longSec, 1800);
  if (kind === 'coding') return Math.max(longSec, 1200);
  return memoryWindowSec(behavior, memoryGenre);
}
