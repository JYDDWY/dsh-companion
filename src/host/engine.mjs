// engine.mjs —— 陪玩的核心循环：探窗口 → 判定游戏 → 连拍 → 两步模型 → 语音 → 记历史。
//
// 状态机（phase）：paused → checking → capturing → thinking → speaking → idle → checking …
// 所有对外可见的状态都在 getState() 里，面板靠轮询它。任何一步失败都写 lastError，
// 下一轮继续跑，不会因为一次失败彻底哑掉。
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dataDir, mergeConfig, mergeUserConfig, normalizeConfig, pickKnownKeys, readUserConfig, writeUserConfig } from './config.mjs';
import { makeCapture, pruneFrames, framesUsage, FRAMES_DIR } from './capture.mjs';
import { makeVoice } from './voice.mjs';
import { makeSubtitle } from './subtitle.mjs';
import { makeServices } from './services.mjs';
import { identifyScene, scenarioLabel, sceneIntervalSec, sceneMemoryWindowSec, classifyGenre, gameLabel } from './games.mjs';
import {
  makePersonaLoader,
  buildSystemPrompt,
  buildTalkPrompt,
  formatHistory,
  describeLastVision,
  visionPromptFor,
  buildSummaryPrompt,
  PROMPT_BLOCK_META,
  promptBlockDefaults,
  resolvePromptBlock,
} from './prompt.mjs';
import {
  isGenericFiller,
  isGroundlessStillness,
  isNagging,
  mentionsHudFocus,
  parseVisionJson,
  sanitizeSpeech,
  sanitizeVisionText,
  saveImages,
  resolveTargets,
  splitEmotion,
  streamText,
  textHash,
} from './llm.mjs';
import { loadHistory, makeHistoryWriter, trimHistory } from './store.mjs';
import {
  deleteWorldbook,
  getWorldbook,
  getWorldbookById,
  isUsableGameName,
  listWorldbooks,
  saveWorldbook,
  worldbookId,
  worldbookPromptText,
} from './worldbook.mjs';
import { researchWorldbook } from './research.mjs';
import { errorText, truncate, formatDuration } from './util.mjs';

const PHASES = ['paused', 'checking', 'capturing', 'thinking', 'speaking', 'idle'];

export function makeEngine({ ctx, deployConfig, log }) {
  const persona = makePersonaLoader();
  const capture = makeCapture({ getConfig: () => settings, log });
  const voice = makeVoice({ getConfig: () => settings, log });
  const services = makeServices({ getConfig: () => settings, log });
  const subtitle = makeSubtitle({ getConfig: () => settings, log });

  /** 生效配置（部署默认 ← 用户覆盖层），所有模块通过闭包读它。 */
  let settings = normalizeConfig({});
  let userConfig = {};

  /** 运行态。 */
  const state = {
    enabled: true,
    phase: 'paused',
    busy: false,
    timer: null,
    nextTickAt: 0,
    tickId: 0,
    ticks: 0,
    skipped: 0,
    game: null,
    scene: null,
    sceneKind: 'other',
    previousSummary: '',
    conversationStartedAt: Date.now(),
    startedAt: 0,
    lastTickAt: 0,
    lastCaptureAt: 0,
    lastCommentAt: 0,
    lastTickMs: 0,
    lastFrame: null,
    lastVision: null,
    lastError: null,
    history: [],
    historyNextId: 1,
    stats: {
      ticks: 0,
      skipped: 0,
      llmCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      spokenChars: 0,
      conversations: 0,
      failures: 0,
      startedAt: Date.now(),
    },
    services: {
      capture: { ok: false, error: '未检查', url: '' },
      voice: { ok: false, error: '未检查', url: '', voices: [] },
    },
    modelReport: null,
    storage: { frames: { dirs: 0, bytes: 0, mb: 0 }, lastCleanupAt: 0, lastRemoved: 0 },
    worldbook: { status: 'idle', game: '', id: '', title: '', error: null, updatedAt: null },
    recentHashes: [],
    tickTimestamps: [],
    lastSpeak: { text: '', at: 0 },
    /** 当前正在执行的自动观察（暂停/卸载时用它取消） */
    currentTick: null,
    /** 正在写入的截图目录 tickId（并发清理时保护，F01） */
    activeFrameTick: null,
  };
  let cleanupChain = Promise.resolve();
  /** 自动世界书调研的取消控制器（暂停/卸载时中止；手动调研不受影响） */
  let researchController = new AbortController();

  /** 取消当前自动观察；force=true 时连用户手动的「看一眼」也取消（卸载时用）。 */
  function cancelCurrentTick(reason = 'paused', { force = false } = {}) {
    const token = state.currentTick;
    if (!token) return false;
    if (!force && token.manual) return false;
    token.cancelled = true;
    token.reason = reason;
    try {
      token.controller?.abort(new Error(`自动观察已取消（${reason}）`));
    } catch {
      // ignore
    }
    return true;
  }

  function cancelledError(reason = 'paused') {
    const error = new Error(`自动观察已取消（${reason}）`);
    error.code = 'CANCELLED';
    return error;
  }

  // R05：重启后把 tickId 恢复到「历史/磁盘里出现过的最大值」，避免覆盖旧截图目录。
  async function restoreTickId(entries = []) {
    let max = 0;
    for (const entry of Array.isArray(entries) ? entries : []) {
      const id = Number(entry?.tickId);
      if (Number.isFinite(id) && id > max) max = id;
    }
    try {
      const names = await readdir(FRAMES_DIR);
      for (const name of names) {
        if (!/^\d+$/.test(name)) continue;
        const id = Number(name);
        if (Number.isFinite(id) && id > max) max = id;
      }
    } catch {
      // 目录不存在
    }
    return max;
  }

  let historyWriter = makeHistoryWriter(() => ({
    entries: state.history.slice(-200),
    stats: state.stats,
    summary: state.previousSummary,
  }));
  let initialized = false;
  let disposed = false;
  let healthTimer = null;
  let serial = Promise.resolve();

  /** 串行执行：同一时间只跑一轮观察或一次聊天，避免抢模型/抢语音。 */
  function serialize(task) {
    const run = serial.then(task, task);
    serial = run.catch(() => {});
    return run;
  }

  // ── 截图缓存清理 ──────────────────────────────────────────────────────────
  //
  // 截图是落盘的 JPEG（每轮 1-3 张），不清理会一直堆。这里按「保留轮数 + 总 MB + 保留小时」
  // 三条策略自动裁剪，每轮观察后跑一次；面板也能看到占用并手动清理。
  async function testSubtitle(text) {
    const result = await subtitle.show(String(text ?? '').trim() || '字幕测试：能看见我这行字吗？');
    if (!result.ok) throw new Error(result.error || '字幕未开启或启动失败');
    return { ok: true, subtitle: subtitle.status() };
  }

  async function restartSubtitle() {
    await subtitle.applyConfig();
    return { ok: true, subtitle: subtitle.status() };
  }

  async function cleanupFrames(force = false, { protectActive = true } = {}) {
    // F01：清理与下一轮截图/手动清理互斥；清理挂到同一串行链上
    const task = cleanupChain.then(async () => {
      const captureConfig = settings.capture ?? {};
      const keep = Number(captureConfig.keepFrames);
      const maxBytes = Number(captureConfig.maxFramesMB) * 1024 * 1024;
      const maxAgeMs = Number(captureConfig.retentionHours) * 3600 * 1000;
      const protect = protectActive && state.busy && state.activeFrameTick != null ? [String(state.activeFrameTick)] : [];
      const removed = await pruneFrames({
        keep: Number.isFinite(keep) ? Math.max(0, keep) : 20,
        maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 0,
        maxAgeMs: Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : 0,
        protect,
      });
      const usage = await framesUsage();
      state.storage = {
        frames: usage,
        lastCleanupAt: Date.now(),
        lastRemoved: removed.removed,
      };
      if (removed.removed > 0 || force) {
        log.info(`截图缓存清理：删除 ${removed.removed} 轮（${Math.round(removed.removedBytes / 1024 / 1024 * 10) / 10}MB），当前 ${usage.dirs} 轮 / ${usage.mb}MB`);
      }
      return state.storage;
    });
    cleanupChain = task.then(() => {}, () => {});
    return task;
  }

  // ── 世界书 ──────────────────────────────────────────────────────────────
  //
  // 第一次识别到某个游戏时，后台联网调研、生成一份可编辑的世界书（synopsis/玩法/新手要点/术语/
  // 常见误解），之后每次出话把精简版塞进提示词；用户可以在面板里随时改或重新调研。
  const worldbookCache = new Map(); // id -> entry | null
  const worldbookResearching = new Set(); // gameName，避免并发重复调研
  const worldbookTried = new Set(); // 本进程内已经尝试过（成功或失败）的游戏

  async function worldbookFor(gameName) {
    if (!settings.worldbook.enabled || !isUsableGameName(gameName)) return null;
    const id = worldbookId(gameName);
    if (worldbookCache.has(id)) return worldbookCache.get(id);
    const entry = await getWorldbook(gameName);
    worldbookCache.set(id, entry);
    return entry;
  }

  function refreshWorldbookState(entry, status, error) {
    state.worldbook = {
      status,
      game: entry?.game ?? state.worldbook.game ?? '',
      id: entry?.id ?? state.worldbook.id ?? '',
      title: entry?.title ?? state.worldbook.title ?? '',
      error: error ?? null,
      updatedAt: entry?.updatedAt ?? state.worldbook.updatedAt ?? null,
    };
  }

  async function researchAndSaveWorldbook(gameName, { signal = null } = {}) {
    if (!settings.worldbook.enabled || !settings.worldbook.autoResearch) return null;
    if (!isUsableGameName(gameName)) return null;
    if (worldbookResearching.has(gameName) || worldbookTried.has(gameName)) return null;
    worldbookResearching.add(gameName);
    worldbookTried.add(gameName);
    try {
      refreshWorldbookState({ game: gameName }, 'researching');
      log.info(`开始给「${gameName}」生成世界书（联网调研）…`);
      const entry = await researchWorldbook({ ctx, settings, gameName, log, signal });
      await saveWorldbook(entry);
      worldbookCache.set(entry.id, entry);
      refreshWorldbookState(entry, 'ready');
      log.info(`世界书就绪：${entry.title}（来源 ${entry.confidence}，${entry.sources?.length ?? 0} 条来源）`);
      return entry;
    } catch (error) {
      if (error?.code === 'CANCELLED' || signal?.aborted) {
        // 暂停/卸载触发的取消是正常控制流：允许下次恢复后重试
        worldbookTried.delete(gameName);
        refreshWorldbookState({ game: gameName }, 'idle');
        log.info(`世界书调研已取消：${gameName}`);
        return null;
      }
      refreshWorldbookState({ game: gameName }, 'error', errorText(error).slice(0, 300));
      log.warn(`世界书生成失败：${errorText(error)}`);
      return null;
    } finally {
      worldbookResearching.delete(gameName);
    }
  }

  /** 对外的手动调研入口（面板按钮）。 */
  async function researchWorldbookNow(gameName) {
    const name = String(gameName ?? '').trim();
    if (!isUsableGameName(name)) throw new Error('游戏名不可用');
    worldbookTried.delete(name);
    const entry = await researchAndSaveWorldbook(name);
    if (!entry) throw new Error(state.worldbook.error || '世界书生成失败');
    return entry;
  }

  async function removeWorldbook(id) {
    const removed = await deleteWorldbook(id);
    if (removed) worldbookCache.delete(id);
    return removed;
  }

  function getPromptBlocks() {
    const defaults = promptBlockDefaults(settings);
    const effective = {};
    for (const block of PROMPT_BLOCK_META) effective[block.id] = resolvePromptBlock(settings, block.id);
    return {
      blocks: PROMPT_BLOCK_META,
      defaults,
      effective,
      overrides: settings.persona.promptOverrides ?? {},
    };
  }

  async function getWorldbookEntry({ id, game } = {}) {
    if (id) return getWorldbookById(String(id));
    if (game) return getWorldbook(String(game));
    return null;
  }

  async function saveWorldbookEntry(input) {
    const saved = await saveWorldbook(input, { keepId: true });
    worldbookCache.set(saved.id, saved);
    if (state.worldbook.id === saved.id) refreshWorldbookState(saved, 'ready');
    return saved;
  }

  // ── 思考强度 ────────────────────────────────────────────────────────────
  //
  // ctx.llm.stream 支持 reasoningEffort（由模型声明的档位决定，如 off/low/high/max）。
  // 插件默认 auto = 不传，跟随 DSH/提供方默认；用户在面板里选了具体档位时，
  // 先向 llm 服务确认这个模型支不支持，不支持就回退默认（避免整轮调用报错）。
  const reasoningCache = new Map();

  async function resolveEffort(provider, model, requested) {
    const want = String(requested ?? 'auto').trim().toLowerCase();
    const result = { requested: want, effective: undefined, supported: [], defaultEffort: undefined, reason: '' };
    if (want === 'auto' || !provider || !model) {
      result.reason = '未指定，按默认';
      return result;
    }
    const key = `${provider}/${model}`;
    let info = reasoningCache.get(key);
    if (!info || Date.now() - info.at > 10 * 60_000) {
      try {
        const resolved = await ctx.llm.resolveModelInfo(provider, model);
        info = {
          at: Date.now(),
          supported: Array.isArray(resolved?.reasoning?.efforts) ? resolved.reasoning.efforts.map((effort) => effort.id) : [],
          defaultEffort: resolved?.reasoning?.defaultEffort,
        };
      } catch (error) {
        info = { at: Date.now(), supported: [], defaultEffort: undefined };
        log.warn(`读取模型思考档位失败：${errorText(error)}`);
      }
      reasoningCache.set(key, info);
    }
    result.supported = info.supported;
    result.defaultEffort = info.defaultEffort;
    if (info.supported.length === 0) {
      result.reason = '该模型未声明思考档位，按默认';
      return result;
    }
    if (info.supported.includes(want)) {
      result.effective = want;
      return result;
    }
    result.reason = `模型不支持「${want}」，按默认`;
    return result;
  }

  // ── 配置 ────────────────────────────────────────────────────────────────

  async function init() {
    userConfig = await readUserConfig();
    settings = normalizeConfig(mergeConfig(deployConfig ?? {}, userConfig));
    state.enabled = settings.enabled;
    const loaded = await loadHistory();
    state.history = loaded.entries;
    state.historyNextId = loaded.nextId;
    state.tickId = await restoreTickId(loaded.entries);
    state.previousSummary = String(loaded.summary ?? '');
    state.conversationStartedAt = state.history.length > 0 ? Date.now() : Date.now();
    if (loaded.stats) {
      state.stats = { ...state.stats, ...loaded.stats, startedAt: Date.now() };
    }
    await cleanupFrames();
    initialized = true;
    startHealthLoop();
    if (settings.enabled) {
      schedule(1500);
      state.phase = 'idle';
    } else {
      state.phase = 'paused';
    }
    // 服务拉起放后台，不阻塞插件挂载（模型/服务起得慢不该拖住 DSH 启动）
    if (settings.services.autoStart) void ensureServices().catch((error) => log.warn(`服务拉起失败：${errorText(error)}`));
    if (settings.subtitle.enabled) void subtitle.ensureRunning().catch((error) => log.warn(`字幕启动失败：${errorText(error)}`));
  }

  function getSettings() {
    return settings;
  }

  /** 应用设置补丁：只收白名单键，落盘用户层，重排节拍、必要时重启服务。 */
  async function updateConfig(patch) {
    const accepted = pickKnownKeys(patch ?? {});
    userConfig = mergeUserConfig(userConfig, accepted);
    const before = settings;
    settings = normalizeConfig(mergeConfig(deployConfig ?? {}, userConfig));
    await writeUserConfig(userConfig);
    state.enabled = settings.enabled;
    state.services.capture.url = settings.services.captureUrl;
    state.services.voice.url = settings.services.voiceUrl;

    // 字幕配置变化 → 重启悬浮窗（让字号/字体/开关立刻生效）
    if (JSON.stringify(before.subtitle) !== JSON.stringify(settings.subtitle)) {
      void subtitle.applyConfig().catch((error) => log.warn(`字幕重启失败：${errorText(error)}`));
    }

    // 采样频率/开关变化 → 重排
    if (!settings.enabled) {
      stopTimer();
      cancelCurrentTick('paused');
      try { researchController.abort(new Error('paused')); } catch { /* ignore */ }
      state.phase = 'paused';
      state.nextTickAt = 0;
      state.game = null;
      state.scene = null;
      state.sceneKind = 'other';
      state.startedAt = 0;
      await voice.stop().catch(() => {});
    } else if (
      before.enabled !== settings.enabled ||
      before.intervalSec !== settings.intervalSec ||
      before.behavior.watchingIntervalSec !== settings.behavior.watchingIntervalSec ||
      before.behavior.codingIntervalSec !== settings.behavior.codingIntervalSec
    ) {
      // 从暂停恢复时给自动调研一个新的取消控制器
      researchController = new AbortController();
      schedule(sceneIntervalSec(settings, state.sceneKind || 'game') * 1000);
    }
    // 服务地址变化 → 重新检查
    if (before.services.captureUrl !== settings.services.captureUrl || before.services.voiceUrl !== settings.services.voiceUrl) {
      void checkServices();
    }
    log.info(`配置已更新（enabled=${settings.enabled} interval=${settings.intervalSec}s）`);
    return settings;
  }

  function getConfigPayload() {
    return {
      config: settings,
      defaults: null,
      userConfig,
    };
  }

  // ── 服务健康 ──────────────────────────────────────────────────────────────

  async function checkServices() {
    const [captureHealth, voiceHealth] = await Promise.all([capture.health(), voice.health()]);
    state.services.capture = {
      ok: captureHealth.ok,
      error: captureHealth.ok ? null : captureHealth.error,
      url: settings.services.captureUrl,
      info: captureHealth.info ?? null,
    };
    state.services.voice = {
      ok: voiceHealth.ok,
      error: voiceHealth.ok ? null : voiceHealth.error,
      url: settings.services.voiceUrl,
      info: voiceHealth.info ?? null,
      backend: voice.getBackendInfo(),
    };
    if (voiceHealth.ok) {
      state.services.voice.voices = Array.isArray(voiceHealth.info?.voices) ? voiceHealth.info.voices : state.services.voice.voices;
    }
    return { capture: state.services.capture, voice: state.services.voice };
  }

  async function ensureServices() {
    const report = { capture: null, voice: null };
    // 语音服务（torch 加载慢）与截图服务（快）并行拉起
    const captureJob = (async () => {
      const health = await capture.health();
      state.services.capture = { ok: health.ok, error: health.ok ? null : health.error, url: settings.services.captureUrl, info: health.info ?? null };
      if (health.ok) return { ok: true, already: true };
      const result = await services.ensure('capture', () => capture.health(), { timeoutMs: 25000 });
      await checkServices();
      return result;
    })();
    const voiceJob = (async () => {
      if ((settings.voice.backend ?? 'auto') === 'sapi') return { ok: true, skipped: 'backend=sapi' };
      const health = await voice.health();
      state.services.voice = { ok: health.ok, error: health.ok ? null : health.error, url: settings.services.voiceUrl, info: health.info ?? null };
      if (health.ok) {
        state.services.voice.voices = Array.isArray(health.info?.voices) ? health.info.voices : [];
        return { ok: true, already: true };
      }
      const result = await services.ensure('voice', () => voice.health(), { timeoutMs: 120000 });
      await checkServices();
      return result;
    })();
    const [captureResult, voiceResult] = await Promise.allSettled([captureJob, voiceJob]);
    report.capture = captureResult.status === 'fulfilled' ? captureResult.value : { ok: false, error: errorText(captureResult.reason) };
    report.voice = voiceResult.status === 'fulfilled' ? voiceResult.value : { ok: false, error: errorText(voiceResult.reason) };
    log.info(`服务状态：截图=${report.capture?.ok ? 'ok' : report.capture?.error ?? 'fail'} 语音=${report.voice?.ok ? 'ok' : report.voice?.error ?? 'fail'}`);
    return report;
  }

  function startHealthLoop() {
    if (healthTimer) clearInterval(healthTimer);
    const interval = Math.max(5, settings.services.healthIntervalSec) * 1000;
    healthTimer = setInterval(() => {
      if (disposed) return;
      void checkServices().catch(() => {});
    }, interval);
    healthTimer.unref?.();
  }

  // ── 节拍 ────────────────────────────────────────────────────────────────

  function stopTimer() {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.nextTickAt = 0;
  }

  function schedule(delayMs) {
    stopTimer();
    if (!settings.enabled || disposed) {
      state.phase = 'paused';
      return;
    }
    const numeric = Number(delayMs);
    const delay = Math.max(1000, Math.round(Number.isFinite(numeric) ? numeric : 45_000));
    state.nextTickAt = Date.now() + delay;
    state.timer = setTimeout(() => {
      state.timer = null;
      void serialize(() => runTick(false)).catch((error) => log.warn(`tick 崩了：${errorText(error)}`));
    }, delay);
  }

  // ── 主循环 ────────────────────────────────────────────────────────────────

  async function runTick(force) {
    if (disposed) return { ok: false, reason: 'disposed' };
    if (!force && !settings.enabled) {
      state.phase = 'paused';
      return { ok: false, reason: 'disabled' };
    }
    if (state.busy) return { ok: false, reason: 'busy' };
    state.busy = true;
    const tickToken = {
      manual: Boolean(force),
      cancelled: false,
      reason: '',
      controller: new AbortController(),
    };
    state.currentTick = tickToken;
    const checkCancelled = () => {
      if (tickToken.cancelled) throw cancelledError(tickToken.reason);
    };
    const startedAt = Date.now();
    state.phase = 'checking';
    let frames = null;
    try {
      // 1) 前台窗口 → 陪伴场景识别（游戏 / 看剧 / 写代码 / 其它）
      const windowInfo = await capture.window();
      checkCancelled();
      const detection = identifyScene(windowInfo, settings.behavior);
      state.window = windowInfo;
      state.sceneKind = detection.kind;

      // 关掉了「只在陪伴场景里工作」时，任何窗口都算（other）；否则只认三类场景。
      const allowed = detection.kind !== 'other' || settings.behavior.onlyWhenGame === false;
      if (!force && !allowed) {
        if (state.scene) {
          log.info(`离开陪伴场景：${state.scene.label || state.scene.process}`);
          state.scene = null;
          state.game = null;
          state.sceneKind = 'other';
          state.startedAt = 0;
        }
        state.phase = 'idle';
        return { ok: false, reason: 'not-scene', detection };
      }

      const id = String(windowInfo?.hwnd ?? windowInfo?.process ?? '');
      const sceneChanged = !state.scene || state.scene.id !== id || state.scene.kind !== detection.kind;
      if (sceneChanged && (detection.kind !== 'other' || force)) {
        const scene = {
          id,
          kind: detection.kind,
          scenario: detection.scenario,
          sceneLabel: scenarioLabel(detection.kind),
          label: detection.label || gameLabel(windowInfo),
          process: String(windowInfo?.process ?? ''),
          title: String(windowInfo?.title ?? ''),
          fullscreen: Boolean(windowInfo?.fullscreen),
          genre: detection.memoryGenre ?? detection.genre ?? 'unknown',
        };
        state.scene = scene;
        state.game = { ...scene, since: Date.now() };
        state.startedAt = Date.now();
        log.info(`开始陪伴（${scene.sceneLabel}）：${scene.label || scene.process}`);
      } else if (state.scene) {
        state.scene.genre = detection.memoryGenre ?? detection.genre ?? state.scene.genre;
        if (state.game) state.game.genre = state.scene.genre;
      }

      // 1.5) 世界书：第一次见到这个游戏就后台调研（不阻塞当前这一轮）
      if (detection.kind === 'game' && isUsableGameName(detection.label)) {
        void worldbookFor(detection.label).then((entry) => {
          if (entry) refreshWorldbookState(entry, 'ready');
          else if (settings.enabled) void researchAndSaveWorldbook(detection.label, { signal: researchController.signal });
        }).catch(() => {});
      }

      // 2) 暂停条件（空闲 / 频率上限 / 热身期）
      if (!force) {
        const idleSec = Number(windowInfo?.idleSec) || 0;
        if (settings.behavior.pauseWhenIdleSec > 0 && idleSec > settings.behavior.pauseWhenIdleSec) {
          state.skipped += 1;
          state.phase = 'idle';
          return { ok: false, reason: 'idle', idleSec };
        }
        const hourAgo = Date.now() - 3600_000;
        state.tickTimestamps = state.tickTimestamps.filter((at) => at >= hourAgo);
        if (settings.behavior.maxTicksPerHour > 0 && state.tickTimestamps.length >= settings.behavior.maxTicksPerHour) {
          state.skipped += 1;
          state.phase = 'idle';
          return { ok: false, reason: 'rate-limited' };
        }
        if (Date.now() - state.startedAt < settings.warmupSec * 1000) {
          state.phase = 'idle';
          return { ok: false, reason: 'warming-up' };
        }
      }

      // 3) 连拍（游戏优先走窗口捕获；看剧/写代码截整屏更自然）
      state.phase = 'capturing';
      state.tickId += 1;
      const tickId = state.tickId;
      state.activeFrameTick = tickId;
      frames = await capture.grab({ tickId, windowInfo, preferWindow: detection.kind === 'game' });
      checkCancelled();
      if (!frames.ok) throw new Error(`截图失败：${frames.error ?? '未知原因'}`);
      state.lastTickMs = Date.now() - startedAt;

      if (!force && settings.behavior.skipUnchanged && state.recentHashes.length > 0) {
        const lastHash = state.recentHashes[state.recentHashes.length - 1];
        const lastFrameHash = frames.frames[frames.frames.length - 1]?.hash;
        if (lastFrameHash && lastFrameHash === lastHash) {
          state.skipped += 1;
          state.phase = 'idle';
          return { ok: false, reason: 'unchanged' };
        }
      }
      const finalHash = frames.frames[frames.frames.length - 1]?.hash;
      if (finalHash) {
        state.recentHashes.push(finalHash);
        if (state.recentHashes.length > 8) state.recentHashes.shift();
      }

      if (frames.black && !force) {
        state.skipped += 1;
        state.lastError = {
          at: Date.now(),
          message:
            detection.kind === 'game'
              ? '截到的画面是全黑的：这个游戏很可能在用「独占全屏」，任何用户态截图都拿不到画面。把游戏改成「无边框窗口」或「窗口化」就能正常看了。'
              : '截到的画面是全黑的：可能开了独占全屏/HDR/防截屏。换个窗口化方式通常就能看到。',
        };
        state.phase = 'idle';
        return { ok: false, reason: 'black-frame' };
      }

      const lastFrameDir = frames.frames[0]?.path ? path.dirname(frames.frames[0].path) : '';
      state.lastFrame = {
        tickId,
        at: Date.now(),
        count: frames.frames.length,
        dir: lastFrameDir,
        width: frames.frames[0]?.width ?? 0,
        height: frames.frames[0]?.height ?? 0,
        source: frames.source,
        black: Boolean(frames.black),
      };

      // 记录两次观察的间隔：射击/动作游戏里 30 秒前的画面就是旧闻，
      // 不告诉模型间隔，它会把上一轮看到的爆炸当成一直持续到现在。
      const sinceLastSec = state.lastCaptureAt
        ? Math.max(1, Math.round((Date.now() - state.lastCaptureAt) / 1000))
        : null;
      state.lastCaptureAt = Date.now();

      // 4) 识图 + 出话（带上「键鼠活跃度 / 帧间差异」，避免静态截图误判成站着不动）
      state.phase = 'thinking';
      const activity = {
        idleSec: Number(windowInfo?.idleSec) || 0,
        framesIdentical: frames.frames.length > 1 && frames.frames.every((frame) => frame.hash === frames.frames[0]?.hash),
        frameDiff: frames.frames.length > 1 && frames.frames.every((frame) => frame.hash === frames.frames[0]?.hash)
          ? '三张图几乎无变化'
          : '三张图有可见变化',
      };
      state.lastActivity = activity;
      // R07：在真正会产生费用的识图/出话之前先占配额；失败轮次也占用，避免上限被绕过
      if (!force) {
        const hourAgo = Date.now() - 3600_000;
        state.tickTimestamps = state.tickTimestamps.filter((at) => at >= hourAgo);
        if (settings.behavior.maxTicksPerHour > 0 && state.tickTimestamps.length >= settings.behavior.maxTicksPerHour) {
          state.skipped += 1;
          state.phase = 'idle';
          return { ok: false, reason: 'rate-limited' };
        }
        state.tickTimestamps.push(Date.now());
      }
      checkCancelled();
      const result = await analyze({ frames: frames.frames, windowInfo, detection, force, activity, sinceLastSec, signal: tickToken.controller.signal, isCancelled: () => tickToken.cancelled });
      checkCancelled();
      state.modelReport = { ...result.targets.report, reasoning: result.reasoning };

      if (!result.say) {
        state.phase = 'idle';
        return { ok: false, reason: 'empty', message: '模型没有给出可用的台词' };
      }

      // 5) 记录 + 语音
      const entry = {
        id: state.historyNextId++,
        role: 'assistant',
        text: result.say,
        at: Date.now(),
        game: gameLabel(windowInfo),
        scenario: result.kind,
        sceneLabel: scenarioLabel(result.kind),
        genre: result.genre,
        emotion: result.emotion,
        tickId,
        vision: result.vision ?? null,
        frameDir: lastFrameDir,
        frameCount: frames.frames.length,
        source: 'tick',
      };
      state.history.push(entry);
      state.history = trimHistory(state.history);
      historyWriter.schedule();
      state.stats.ticks += 1;
      state.stats.llmCalls += result.llmCalls;
      state.stats.tokensIn += result.tokensIn;
      state.stats.tokensOut += result.tokensOut;
      state.lastCommentAt = Date.now();
      state.lastVision = result.vision ?? null;
      state.lastTickAt = Date.now();

      state.phase = 'speaking';
      const speakResult = await maybeSpeak(result.say, { reason: 'tick', emotion: result.emotion });
      state.stats.spokenChars += speakResult.spoken ? result.say.length : 0;
      state.phase = 'idle';
      log.info(`说了（${result.emotion}）：${truncate(result.say, 80)}${speakResult.spoken ? '' : '（未朗读）'}`);
      return {
        ok: true,
        say: result.say,
        emotion: result.emotion,
        sinceLastSec,
        vision: result.vision,
        game: entry.game,
        scene: entry.sceneLabel,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      // F05：先结算已经发生的模型调用/Token，再区分取消和失败，避免取消分支漏记
      if (error?.usage) {
        state.stats.llmCalls += Number(error.llmCalls ?? error.usage.calls ?? 0) || 0;
        state.stats.tokensIn += Number(error.usage.tokensIn ?? 0) || 0;
        state.stats.tokensOut += Number(error.usage.tokensOut ?? 0) || 0;
      }
      if (error?.code === 'CANCELLED') {
        state.phase = settings.enabled ? 'idle' : 'paused';
        log.info('这一轮自动观察已取消（暂停/卸载）');
        return { ok: false, reason: 'cancelled' };
      }
      state.stats.failures += 1;
      state.lastError = { at: Date.now(), message: errorText(error).slice(0, 600) };
      state.phase = 'idle';
      log.warn(`观察失败：${errorText(error)}`);
      return { ok: false, reason: 'error', message: errorText(error) };
    } finally {
      const hadFrameAttempt = state.activeFrameTick != null;
      state.activeFrameTick = null;
      if (state.currentTick === tickToken) state.currentTick = null;
      // F04：只要本轮尝试过截图（哪怕只写出部分图片后失败）就清理；
      // F01：清理串行执行并等它结束，避免删掉下一轮正在写入的目录。
      if (hadFrameAttempt) {
        try {
          await cleanupFrames(false, { protectActive: false });
        } catch (error) {
          log.warn(`截图缓存清理失败：${errorText(error)}`);
        }
      }
      state.busy = false;
      if (settings.enabled && !disposed) {
        schedule(sceneIntervalSec(settings, state.sceneKind || 'game') * 1000);
      }
    }
  }

  /** 识图 + 出话（两步；按场景换提示词与记忆窗口）。 */
  async function analyze({ frames, windowInfo, detection, activity, sinceLastSec = null, signal, isCancelled = () => false }) {
    const usage = { calls: 0, tokensIn: 0, tokensOut: 0 };
    const addUsage = (result) => {
      usage.calls += 1;
      usage.tokensIn += Number(result?.usage?.inputTokens ?? 0) || 0;
      usage.tokensOut += Number(result?.usage?.outputTokens ?? 0) || 0;
      if (result?.cancelled) throw cancelledError('paused');
    };
    const throwIfCancelled = () => {
      if (isCancelled()) throw cancelledError('paused');
    };
    try {
    throwIfCancelled();
    const targets = await resolveTargets(ctx, settings);
    if (!targets.vision) {
      throw new Error(
        '没有可用的识图模型：当前对话模型不支持图片，注册表里也没有声明支持 image 的模型。' +
          `（providers=${JSON.stringify(targets.report.providers)} imageModels=${JSON.stringify(targets.report.imageModels)}）` +
          ' 可以在面板「模型」里手动指定一个多模态模型。',
      );
    }
    const kind = detection?.kind ?? 'game';
    const visionEffort = await resolveEffort(targets.vision.provider, targets.vision.model, settings.vision.reasoningEffort);
    const talkEffort = await resolveEffort(targets.talk.provider, targets.talk.model, settings.talk.reasoningEffort);
    const images = [];
    for (const frame of frames) {
      images.push({ data: await readFile(frame.path), mediaType: frame.mediaType ?? 'image/jpeg' });
    }

    // 第 1 步：识图
    let visionText = '';
    let visionUsage = null;
    const { refs, cleanup } = await saveImages(ctx, images);
    try {
      const content = [
        ...refs.map((ref) => ({ type: 'image', attachment: ref })),
        {
          type: 'text',
          text: [
            visionPromptFor(kind),
            '',
            `【键鼠活跃度】最近一次键盘/鼠标输入在 ${activity?.idleSec ?? 0} 秒前${Number(activity?.idleSec) <= 3 ? '（正在操作）' : ''}`,
            `【距离上次观察】${sinceLastSec != null ? `${sinceLastSec} 秒前` : '第一次观察'}（本次三张图只是这一瞬间的静态快照，不是这段间隔的完整过程）`,
            `【帧间差异】${activity?.framesIdentical ? '三张图几乎无变化' : '三张图有可见变化'}（帧间隔 ${settings.capture.frameIntervalMs}ms）`,
            `（窗口标题：${windowInfo?.title ?? '未知'}；进程：${windowInfo?.process ?? '未知'}）`,
          ].join(String.fromCharCode(10)),
        },
      ];
      const visionResult = await streamText(ctx, {
        provider: targets.vision.provider,
        model: targets.vision.model,
        content,
        system: '你是识图助手：只从屏幕截图里抽取结构化信息，不做画面描述，不给建议。',
        maxTokens: settings.vision.maxTokens,
        timeoutMs: settings.vision.timeoutMs,
        reasoningEffort: visionEffort.effective,
        signal,
      });
      addUsage(visionResult);
      if (!visionResult.ok) {
        throw new Error(`识图模型失败（${targets.vision.provider}/${targets.vision.model}）：${visionResult.message}`);
      }
      visionText = visionResult.text;
      visionUsage = visionResult.usage ?? null;
      state.lastVisionRaw = truncate(visionText, 1000);
    } finally {
      await cleanup();
    }

    const vision = parseVisionJson(visionText) ?? { raw: sanitizeVisionText(visionText) };
    const genre =
      detection?.memoryGenre && detection.memoryGenre !== 'unknown'
        ? detection.memoryGenre
        : classifyGenre(`${vision.game ?? ''} ${vision.raw ?? ''} ${windowInfo?.title ?? ''}`);
    const windowSec = sceneMemoryWindowSec(settings, kind, genre);
    const agentsText = settings.persona.useAgentsMd ? await persona.load(settings) : '';
    const label = detection?.label || gameLabel(windowInfo);
    const system = buildSystemPrompt(settings, agentsText, { kind, label });
    const worldbook = kind === 'game' ? await worldbookFor(label) : null;
    const worldbookText = worldbook ? worldbookPromptText(worldbook, settings.worldbook.maxPromptChars) : '';
    const historyText = formatHistory(state.history, Date.now(), windowSec);
    const prompt = buildTalkPrompt({
      kind,
      game: label,
      worldbookText,
      windowTitle: windowInfo?.title ?? '',
      playingForSec: state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0,
      vision,
      activity,
      sinceLastSec,
      cheerMode: settings.talk.cheerMode,
      config: settings,
      historyText,
      summaryText: state.previousSummary || '',
      windowSec,
      genre,
      isReply: false,
    });

    // 第 2 步：出话（带情绪标签）
    const talkResult = await streamText(ctx, {
      provider: targets.talk.provider,
      model: targets.talk.model,
      content: [{ type: 'text', text: prompt }],
      system,
      maxTokens: settings.talk.maxTokens,
      temperature: settings.talk.temperature,
      timeoutMs: settings.talk.timeoutMs,
      reasoningEffort: talkEffort.effective,
        signal,
    });
    addUsage(talkResult);
    if (!talkResult.ok) {
      throw new Error(`出话模型失败（${targets.talk.provider}/${targets.talk.model}）：${talkResult.message}`);
    }
    let { text: rawText, emotion } = splitEmotion(talkResult.text);
    let say = sanitizeSpeech(rawText);
    let extraCalls = 0;

    // 空话拦截：命中「放到任何场景都成立」的套话就要求重写一次
    if (settings.talk.banFiller && isGenericFiller(say)) {
      log.warn(`出话命中空话，要求重写：${truncate(say, 60)}`);
      const retryPrompt = [
        prompt,
        '',
        '【重写要求】你刚才那句是放到任何游戏/任何场景都成立的废话（比如「我在这儿陪着你」「随时喊我」「慢慢来就好」），不合格。',
        '现在重写：必须点名一个屏幕上具体的角色/敌人/物品/数字/动作，或者刚才发生的具体事，用一句 10–50 字的话说出来。',
        '只输出两行（情绪标签 + 台词），不要解释。',
      ].join(String.fromCharCode(10));
      const retry = await streamText(ctx, {
        provider: targets.talk.provider,
        model: targets.talk.model,
        content: [{ type: 'text', text: retryPrompt }],
        system,
        maxTokens: settings.talk.maxTokens,
        temperature: settings.talk.temperature,
        timeoutMs: settings.talk.timeoutMs,
        reasoningEffort: talkEffort.effective,
        signal,
      });
      extraCalls += 1;
      addUsage(retry);
      if (retry.ok) {
        const parsed = splitEmotion(retry.text);
        const retried = sanitizeSpeech(parsed.text);
        if (retried && !isGenericFiller(retried)) {
          say = retried;
          emotion = parsed.emotion;
        } else {
          log.warn(`重写后仍是空话，这一轮不开口：${truncate(retried || retry.text, 60)}`);
          say = '';
        }
      } else {
        log.warn(`空话重写失败：${retry.message}`);
        say = '';
      }
    }
    // 静止误判拦截：键鼠最近还在动，却断言主人「站着不动/挂机」→ 要求重写
    if (say && isGroundlessStillness(say, activity?.idleSec)) {
      log.warn(`出话误判主人不动（键鼠 ${activity?.idleSec ?? '?'} 秒前还在输入），要求重写：${truncate(say, 60)}`);
      const rewritePrompt = [
        prompt,
        '',
        '【重写要求】键鼠活跃度显示主人最近几秒还在操作（或画面变化小只是因为在跑动/转视角）。你刚才那句「站着不动/挂机」是错的，会惹主人生气。',
        '重写：不要再判断主人在不在动，直接聊画面里具体的东西（敌人、地形、目标、弹药、正在发生的事）或给出具体建议。只输出两行（情绪标签 + 台词）。',
      ].join(String.fromCharCode(10));
      const retry = await streamText(ctx, {
        provider: targets.talk.provider,
        model: targets.talk.model,
        content: [{ type: 'text', text: rewritePrompt }],
        system,
        maxTokens: settings.talk.maxTokens,
        temperature: settings.talk.temperature,
        timeoutMs: settings.talk.timeoutMs,
        reasoningEffort: talkEffort.effective,
        signal,
      });
      extraCalls += 1;
      addUsage(retry);
      if (retry.ok) {
        const parsed = splitEmotion(retry.text);
        const retried = sanitizeSpeech(parsed.text);
        if (retried && !isGroundlessStillness(retried, activity?.idleSec) && !isGenericFiller(retried)) {
          say = retried;
          emotion = parsed.emotion;
        } else {
          log.warn(`重写后仍然在误判/空话，这一轮不开口：${truncate(retried || retry.text, 60)}`);
          say = '';
        }
      } else {
        say = '';
      }
    }
    // 喝彩模式语气守卫：说教/命令式，或揪着 HUD 数字与任务目标不放 → 重写一次（不强制沉默）
    if (say && settings.talk.cheerMode) {
      const nagging = isNagging(say);
      const hudFocus = mentionsHudFocus(say) && Boolean(vision?.highlight || vision?.action);
      if (nagging || hudFocus) {
        const reason = nagging ? '像教练一样说教/命令式' : '揪着弹药数、任务目标这类 HUD 文字不放';
        log.warn(`出话${reason}，要求改成喝彩：${truncate(say, 60)}`);
        const cheerPrompt = [
          prompt,
          '',
          `【重写要求】你刚才那句是${reason}，主人要的是同伴的喝彩，不是教练指导。`,
          '重写：如果画面里有高光（击杀/爆炸/开火/连杀/帅气躲避），就具体夸这一个点；没有高光就描述你看到的动作和气氛。',
          '不要提弹药数、任务目标、血条等 HUD 文字/数字；不要用「先按」「你该」「别站」这种命令式。',
          '只输出两行（情绪标签 + 台词），10–50 字。',
        ].join(String.fromCharCode(10));
        const retry = await streamText(ctx, {
          provider: targets.talk.provider,
          model: targets.talk.model,
          content: [{ type: 'text', text: cheerPrompt }],
          system,
          maxTokens: settings.talk.maxTokens,
          temperature: settings.talk.temperature,
          timeoutMs: settings.talk.timeoutMs,
          reasoningEffort: talkEffort.effective,
          signal,
        });
        extraCalls += 1;
        addUsage(retry);
        if (retry.ok) {
            const parsed = splitEmotion(retry.text);
          const retried = sanitizeSpeech(parsed.text);
          if (retried && !isGenericFiller(retried) && !isNagging(retried)) {
            say = retried;
            emotion = parsed.emotion;
          }
        }
      }
    }
    // 少提问守卫：观察型台词尽量别问问题（玩家没空回答，被追问久了会烦）
    if (say && settings.talk.banQuestions && /[?？]/.test(say)) {
      log.warn(`出话带问句，要求改成陈述：${truncate(say, 60)}`);
      const rewritePrompt = [
        prompt,
        '',
        '【重写要求】你刚才那句在提问。主人正在打游戏/看剧，没空回答，问多了会很烦。',
        '重写：改成陈述句、感叹句或喝彩；不要问问题、不要用反问/追问收尾。只输出两行（情绪标签 + 台词）。',
      ].join(String.fromCharCode(10));
      const retry = await streamText(ctx, {
        provider: targets.talk.provider,
        model: targets.talk.model,
        content: [{ type: 'text', text: rewritePrompt }],
        system,
        maxTokens: settings.talk.maxTokens,
        temperature: settings.talk.temperature,
        timeoutMs: settings.talk.timeoutMs,
        reasoningEffort: talkEffort.effective,
        signal,
      });
      extraCalls += 1;
      addUsage(retry);
      if (retry.ok) {
        const parsed = splitEmotion(retry.text);
        const retried = sanitizeSpeech(parsed.text);
        if (retried && !isGenericFiller(retried)) {
          say = retried;
          emotion = parsed.emotion;
        }
      }
      // 兜底：重写后还是问句，就把问号改成句号（宁可陈述也别追问）
      if (/[?？]/.test(say)) {
        say = say.replace(/[?？]+/g, '。');
      }
    }
    if (!say) throw new Error('模型只给出了空话/误判内容，这一轮选择不开口（设置：禁止空话）');

    return {
      say,
      emotion,
      vision,
      genre,
      kind,
      targets,
      reasoning: { vision: visionEffort, talk: talkEffort },
      llmCalls: usage.calls,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
    };
  
    } catch (error) {
      // 失败/取消也把已经发生的调用与 Token 带出去
      error.usage = usage;
      error.llmCalls = usage.calls;
      throw error;
    }
}

  // ── 用户聊天 ────────────────────────────────────────────────────────────

  async function chat(rawText) {
    const text = String(rawText ?? '').trim();
    if (!text) throw new Error('消息是空的');
    return serialize(async () => {
      state.phase = 'thinking';
      try {
        const targets = await resolveTargets(ctx, settings);
        if (!targets.talk) throw new Error('没有可用的对话模型（面板里指定一个，或先在 DSH 里选好模型）');
        state.modelReport = targets.report;
        const agentsText = settings.persona.useAgentsMd ? await persona.load(settings) : '';
        const kind = state.sceneKind ?? 'other';
        const scene = state.scene;
        const label = scene?.label || '';
        const system = buildSystemPrompt(settings, agentsText, { kind, label });
        const genre = scene?.genre ?? 'unknown';
        const talkEffort = await resolveEffort(targets.talk.provider, targets.talk.model, settings.talk.reasoningEffort);
        // 聊天回复允许回顾更久：用户在主动提问，不是即兴吐槽
        const windowSec = Math.max(sceneMemoryWindowSec(settings, kind, genre), 900);
        const historyText = formatHistory(state.history, Date.now(), windowSec);
        const lastVisionEntry = [...state.history].reverse().find((entry) => entry.role === 'assistant' && entry.vision);
        const worldbook = kind === 'game' ? await worldbookFor(label) : null;
        const sinceLastSec = state.lastCaptureAt
          ? Math.max(1, Math.round((Date.now() - state.lastCaptureAt) / 1000))
          : null;
        const prompt = buildTalkPrompt({
          kind,
          game: label,
          worldbookText: worldbook ? worldbookPromptText(worldbook, settings.worldbook.maxPromptChars) : '',
          windowTitle: scene?.title ?? '',
          playingForSec: state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0,
          vision: lastVisionEntry?.vision ?? null,
          activity: state.lastActivity ?? null,
          sinceLastSec,
          cheerMode: settings.talk.cheerMode,
          config: settings,
          historyText,
          summaryText: state.previousSummary || '',
          windowSec,
          genre,
          isReply: true,
          userMessage: text,
          replyContext: describeLastVision(lastVisionEntry),
        });
        const reply = await streamText(ctx, {
          provider: targets.talk.provider,
          model: targets.talk.model,
          content: [{ type: 'text', text: prompt }],
          system,
          maxTokens: settings.talk.maxTokens,
          temperature: settings.talk.temperature,
          timeoutMs: settings.talk.timeoutMs,
          reasoningEffort: talkEffort.effective,
        });
        if (!reply.ok) throw new Error(`回复失败（${targets.talk.provider}/${targets.talk.model}）：${reply.message}`);
        let { text: rawReply, emotion } = splitEmotion(reply.text);
        let say = sanitizeSpeech(rawReply);
        if (!say) throw new Error('回复消毒后没有可用的自然语言');
        state.stats.llmCalls += 1;
        state.stats.tokensIn += reply.usage?.inputTokens ?? 0;
        state.stats.tokensOut += reply.usage?.outputTokens ?? 0;
        if (settings.talk.banFiller && isGenericFiller(say)) {
          log.warn(`聊天回复命中空话，要求重写：${truncate(say, 60)}`);
          const retryPrompt = [
            prompt,
            '',
            '【重写要求】你刚才那句是放到任何场景都成立的废话，不合格。重写：必须扣住屏幕上的具体内容或主人刚才那句话里的具体点，只输出两行（情绪标签 + 台词）。',
          ].join(String.fromCharCode(10));
          const retry = await streamText(ctx, {
            provider: targets.talk.provider,
            model: targets.talk.model,
            content: [{ type: 'text', text: retryPrompt }],
            system,
            maxTokens: settings.talk.maxTokens,
            temperature: settings.talk.temperature,
            timeoutMs: settings.talk.timeoutMs,
            reasoningEffort: talkEffort.effective,
          });
          state.stats.llmCalls += 1;
          if (retry.ok) {
            state.stats.tokensIn += retry.usage?.inputTokens ?? 0;
            state.stats.tokensOut += retry.usage?.outputTokens ?? 0;
            const parsed = splitEmotion(retry.text);
            const retried = sanitizeSpeech(parsed.text);
            if (retried && !isGenericFiller(retried)) {
              say = retried;
              emotion = parsed.emotion;
            }
          }
        }

        // 先记用户消息（保持时间顺序：用户在前）
        state.history.push({
          id: state.historyNextId++,
          role: 'user',
          text: truncate(text, 500),
          at: Date.now(),
          game: label,
          source: 'chat',
        });
        const entry = {
          id: state.historyNextId++,
          role: 'assistant',
          text: say,
          at: Date.now(),
          game: label,
          scenario: kind,
          sceneLabel: scenarioLabel(kind),
          genre,
          emotion,
          source: 'chat',
          replyTo: 'user',
        };
        state.history.push(entry);
        state.history = trimHistory(state.history);
        historyWriter.schedule();
        state.lastCommentAt = Date.now();
        state.lastError = null;

        state.phase = 'speaking';
        // R09：聊天朗读开关只控制音频；字幕仍按 setsubtitle 设置独立显示
        const speakResult = await maybeSpeak(say, { reason: 'chat', emotion, silent: settings.voice.speakReplies === false });
        state.stats.spokenChars += speakResult.spoken ? say.length : 0;
        state.phase = 'idle';
        log.info(`回复主人（${emotion}）：${truncate(say, 80)}`);
        return { ok: true, say, emotion, spoken: speakResult.spoken, reply };
      } catch (error) {
        state.lastError = { at: Date.now(), message: errorText(error).slice(0, 600) };
        state.phase = 'idle';
        log.warn(`聊天失败：${errorText(error)}`);
        throw error;
      }
    });
  }

  /** 去重 + 朗读（把情绪一起交给语音服务）。 */
  async function maybeSpeak(text, meta) {
    if (settings.subtitle?.enabled) {
      void subtitle.show(text, { emotion: meta?.emotion }).catch((error) => log.warn(`字幕更新失败：${errorText(error)}`));
    }
    if (meta?.silent) return { spoken: false, muted: true };
    if (!settings.voice.enabled) return { spoken: false };
    const now = Date.now();
    if (settings.voice.dedupeWindowSec > 0 && state.lastSpeak.text === text && now - state.lastSpeak.at < settings.voice.dedupeWindowSec * 1000) {
      log.info('同一句话刚说过，跳过朗读');
      return { spoken: false };
    }
    state.lastSpeak = { text, at: now };
    const result = await voice.speak(text, meta ?? {});
    state.lastVoice = {
      at: Date.now(),
      backend: result.backend ?? null,
      emotion: meta?.emotion ?? result.emotion ?? null,
      clipped: Boolean(result.clipped),
    };
    if (result.ok && !result.skipped) return { spoken: true, id: result.id, backend: result.backend };
    return { spoken: false, error: result.error };
  }

  /**
   * 开新对话：把当前对话总结成一句前情提要（可关），归档旧历史，清空上下文。
   * 面板上的「开新对话」就是调这个；不会中断正在玩的游戏 / 看的剧。
   */
  async function newConversation(options = {}) {
    return serialize(async () => {
      const history = state.history.slice();
      const summarize =
        options.summarize !== false &&
        settings.behavior.summaryOnNewConversation !== false &&
        history.length >= 2;
      let summary = '';
      if (summarize) {
        try {
          const targets = await resolveTargets(ctx, settings);
          if (targets.talk) {
            const kind = state.sceneKind ?? 'other';
            const longWindow = Math.max(sceneMemoryWindowSec(settings, kind, state.scene?.genre ?? 'unknown'), 3600);
            const historyText = formatHistory(history, Date.now(), longWindow);
            const summaryEffort = await resolveEffort(targets.talk.provider, targets.talk.model, 'off');
            const result = await streamText(ctx, {
              provider: targets.talk.provider,
              model: targets.talk.model,
              content: [{ type: 'text', text: buildSummaryPrompt(historyText, kind) }],
              system: '你是对话摘要助手：只输出一句简短的中文前情提要，不要解释、不要引号。',
              maxTokens: 200,
              temperature: 0.5,
              timeoutMs: 30000,
              reasoningEffort: summaryEffort.effective,
            });
            if (result.ok) {
              const { text: rawSummary } = splitEmotion(result.text);
              const clean = sanitizeSpeech(rawSummary).trim();
              if (clean && clean !== '（无）' && clean !== '(无)') summary = truncate(clean, 60);
            }
          }
        } catch (error) {
          log.warn(`前情摘要失败：${errorText(error)}`);
        }
      }

      // 归档旧历史（用户可以回看，但不进模型上下文）
      let archivePath = '';
      try {
        if (history.length > 0) {
          const archiveDir = path.join(dataDir(), 'history-archive');
          await mkdir(archiveDir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          archivePath = path.join(archiveDir, `${stamp}.json`);
          await writeFile(
            archivePath,
            JSON.stringify({ at: Date.now(), scene: state.scene?.kind ?? null, summary, entries: history }, null, 2),
            'utf8',
          );
        }
      } catch (error) {
        log.warn(`归档历史失败：${errorText(error)}`);
      }

      state.history = [];
      state.previousSummary = summary;
      state.conversationStartedAt = Date.now();
      state.stats.conversations = (state.stats.conversations ?? 0) + 1;
      state.lastError = null;
      historyWriter.schedule();
      log.info(`开新对话：归档 ${history.length} 条${summary ? `，前情提要：${summary}` : '（无前情）'}`);
      return { ok: true, archived: history.length, archivePath, summary, state: getState() };
    });
  }

  async function stopSpeaking() {
    await voice.stop();
    state.phase = settings.enabled ? 'idle' : 'paused';
    return { ok: true };
  }

  async function captureNow() {
    return serialize(() => runTick(true));
  }

  // ── 对外状态 ────────────────────────────────────────────────────────────

  function getState() {
    const now = Date.now();
    return {
      ok: true,
      enabled: settings.enabled,
      phase: state.phase,
      busy: state.busy,
      nextTickInMs: state.enabled && state.nextTickAt ? Math.max(0, state.nextTickAt - now) : null,
      intervalSec: settings.intervalSec,
      warmupSec: settings.warmupSec,
      game: state.scene
        ? {
            ...state.scene,
            playingForSec: state.startedAt ? Math.round((now - state.startedAt) / 1000) : 0,
            playingForText: state.startedAt ? formatDuration(now - state.startedAt) : '',
          }
        : null,
      scene: state.scene
        ? {
            kind: state.scene.kind,
            sceneLabel: state.scene.sceneLabel ?? scenarioLabel(state.scene.kind),
            label: state.scene.label,
            process: state.scene.process,
          }
        : null,
      sceneKind: state.sceneKind,
      sceneLabel: scenarioLabel(state.sceneKind),
      worldbook: state.worldbook,
      subtitle: subtitle.status(),
      storage: state.storage,
      activity: state.lastActivity ?? null,
      lastCaptureAt: state.lastCaptureAt || null,
      conversation: (() => {
        const kind = state.sceneKind ?? 'other';
        const windowSec = sceneMemoryWindowSec(settings, kind, state.scene?.genre ?? 'unknown');
        const recent = state.history.filter((entry) => entry.at >= now - windowSec * 1000);
        const chars = recent.reduce((sum, entry) => sum + String(entry.text ?? '').length, 0);
        return {
          startedAt: state.conversationStartedAt,
          turns: state.history.filter((entry) => entry.role === 'assistant').length,
          summary: state.previousSummary,
          windowSec,
          contextEntries: recent.length,
          contextChars: chars,
          contextTokensEstimate: Math.round(chars / 1.5),
        };
      })(),
      window: state.window
        ? {
            title: String(state.window.title ?? '').slice(0, 120),
            process: String(state.window.process ?? ''),
            fullscreen: Boolean(state.window.fullscreen),
            minimized: Boolean(state.window.minimized),
          }
        : null,
      lastFrame: state.lastFrame,
      lastVision: state.lastVision,
      lastVisionRaw: state.lastVisionRaw ?? null,
      lastError: state.lastError,
      lastTickAt: state.lastTickAt,
      lastCommentAt: state.lastCommentAt,
      lastTickMs: state.lastTickMs,
      history: state.history.slice(-60),
      stats: state.stats,
      services: { ...state.services, voice: { ...state.services.voice, backend: voice.getBackendInfo() } },
      lastVoice: state.lastVoice ?? null,
      modelReport: state.modelReport
        ? {
            providers: state.modelReport.providers,
            current: state.modelReport.current,
            imageModels: state.modelReport.imageModels,
            totalModels: state.modelReport.totalModels,
            reasoning: state.modelReport.reasoning ?? null,
          }
        : null,
      config: { ...settings, persona: { ...settings.persona } },
      dirs: { home: dataDir(), frames: FRAMES_DIR },
      startedAt: state.stats.startedAt,
      version: 1,
    };
  }

  async function dispose() {
    disposed = true;
    cancelCurrentTick('disposed', { force: true });
    try { researchController.abort(new Error('disposed')); } catch { /* ignore */ }
    stopTimer();
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = null;
    await historyWriter.flushNow().catch(() => {});
    await services.stopAll().catch(() => {});
    subtitle.stop();
  }

  return {
    init,
    getSettings,
    updateConfig,
    getConfigPayload,
    getState,
    runTick,
    captureNow,
    chat,
    newConversation,
    listWorldbooks,
    getPromptBlocks,
    getWorldbookEntry,
    saveWorldbookEntry,
    removeWorldbook,
    researchWorldbookNow,
    stopSpeaking,
    checkServices,
    ensureServices,
    cleanupFrames,
    testSubtitle,
    restartSubtitle,
    dispose,
    VOICE: voice,
    CAPTURE: capture,
    SERVICES: services,
  };
}
