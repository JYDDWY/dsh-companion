// 发布前审查回归测试（隔离环境，不调用真实模型/屏幕/语音）。
// 用法：node test/regressions.mjs <mode>
import { mkdtemp, mkdir, readFile, writeFile, readdir, utimes } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const mode = process.argv[2];
const sandbox = await mkdtemp(path.join(process.env.TEMP ?? '.', `dsh-reg-${mode}-`));
process.env.DSH_HOME = sandbox;
const root = path.resolve(import.meta.dirname, '..');
const load = (name) => import(pathToFileURL(path.join(root, 'src/host', name)).href);
const { makeEngine } = await load('engine.mjs');
const { normalizeConfig, dataDir } = await load('config.mjs');
const { FRAMES_DIR, pruneFrames } = await load('capture.mjs');
const log = { info() {}, warn() {}, error() {} };

const win = { available: true, title: 'RimWorld', process: 'RimWorld.exe', hwnd: 123, idleSec: 0, minimized: false, fullscreen: false };
let calls = [], speaks = [], frameLabel = 'first-session', frameHash = 'same';
const ctx = {
  agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock' }) },
  get: () => ({ saveImage: async () => ({ id: 'mock-image' }) }),
  llm: {
    listProviders: () => ['mock'],
    listModels: async () => [{ id: 'mock', inputModalities: ['text', 'image'] }],
    async *stream(options) {
      const vision = options.messages[0].content.some((x) => x.type === 'image');
      calls.push({ kind: vision ? 'vision' : 'talk', at: Date.now() });
      yield { type: 'text-delta', index: 0, text: vision ? '{"game":"RimWorld","scene":"建造","state":"木墙","notable":"木材"}' : '【情绪：开心】这座木墙建得很整齐。' };
      yield { type: 'usage', usage: { inputTokens: vision ? 100 : 200, outputTokens: vision ? 11 : 23 } };
    },
  },
};

async function engine(extra = {}) {
  const result = makeEngine({
    ctx,
    deployConfig: {
      enabled: false, warmupSec: 0, services: { autoStart: false },
      persona: { useAgentsMd: false }, worldbook: { enabled: false },
      ...extra,
    },
    log,
  });
  result.CAPTURE.window = async () => win;
  result.CAPTURE.health = async () => ({ ok: true });
  result.VOICE.health = async () => ({ ok: true });
  result.VOICE.stop = async () => ({ ok: true });
  result.VOICE.speak = async (text) => { speaks.push(text); return { ok: true, backend: 'mock' }; };
  result.CAPTURE.grab = async ({ tickId }) => {
    const dir = path.join(FRAMES_DIR, String(tickId));
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'frame-0.jpg');
    await writeFile(file, frameLabel);
    return { ok: true, source: 'mock', frames: [{ path: file, hash: frameHash, width: 1, height: 1, mediaType: 'image/jpeg' }] };
  };
  await result.init();
  return result;
}
const emit = (value) => console.log(JSON.stringify({ mode, ...value }));

if (mode === 'pause') {
  const e = await engine({ enabled: true });
  let release, entered;
  const blocked = new Promise((resolve) => { entered = resolve; });
  e.CAPTURE.window = async () => { entered(); return new Promise((resolve) => { release = () => resolve(win); }); };
  const running = e.runTick(false);
  await blocked;
  await e.updateConfig({ enabled: false });
  const callsAtPause = calls.length;
  const speaksAtPause = speaks.length;
  release();
  const result = await running;
  assert.equal(e.getState().enabled, false);
  assert.equal(calls.length, callsAtPause, '暂停后不应再有模型调用');
  assert.equal(speaks.length, speaksAtPause, '暂停后不应再朗读');
  assert.equal(result.reason, 'cancelled');
  emit({ result: result.reason, phase: e.getState().phase, modelCallsAfterPause: calls.length - callsAtPause, speaksAfterPause: speaks.length - speaksAtPause });
  await e.dispose();
} else if (mode === 'restart') {
  let e = await engine();
  await e.captureNow();
  await e.dispose();
  const before = await readFile(path.join(FRAMES_DIR, '1', 'frame-0.jpg'), 'utf8');
  frameLabel = 'second-session';
  e = await engine();
  await e.captureNow();
  await e.cleanupFrames();
  const ids = e.getState().history.filter((x) => x.source === 'tick').map((x) => x.tickId);
  const after = await readFile(path.join(FRAMES_DIR, '1', 'frame-0.jpg'), 'utf8');
  assert.deepEqual(ids, [1, 2], '重启后 tickId 应延续而不是复用 1');
  assert.equal(before, 'first-session');
  emit({ historyTickIds: ids, firstDirIntact: before === 'first-session', secondDir: await readdir(path.join(FRAMES_DIR, '2')) });
  await e.dispose();
} else if (mode === 'prune-order') {
  const dirs = { 90: 'old-session', 91: 'old-session', 1: 'new-after-restart' };
  const now = Date.now() / 1000;
  for (const [id, content] of Object.entries(dirs)) {
    const dir = path.join(FRAMES_DIR, id);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'frame-0.jpg');
    await writeFile(file, content);
    const t = id === '1' ? now : id === '91' ? now - 20 : now - 60;
    await utimes(file, t, t);
  }
  const result = await pruneFrames({ keep: 2 });
  const kept = (await readdir(FRAMES_DIR)).sort();
  assert.deepEqual(kept, ['1', '91'], '应保留最新 mtime 的目录');
  emit({ result, kept });
} else if (mode === 'cache-limit') {
  const e = await engine({ enabled: true, capture: { keepFrames: 1 }, behavior: { skipUnchanged: false } });
  for (let i = 0; i < 5; i += 1) await e.runTick(false);
  await new Promise((r) => setTimeout(r, 400));
  const dirs = (await readdir(FRAMES_DIR)).length;
  assert.ok(dirs <= 1, `自动清理后最多保留 1 轮，实际 ${dirs}`);
  assert.ok(e.getState().storage.frames.dirs <= 1, '面板占用应同步更新');
  emit({ dirs, panelDirs: e.getState().storage.frames.dirs });
  await e.dispose();
} else if (mode === 'failed-rate-limit') {
  const originalStream = ctx.llm.stream;
  ctx.llm.stream = async function* (options) {
    if (options.messages[0].content.some((x) => x.type === 'image')) {
      yield* originalStream(options);
    } else {
      calls.push({ kind: 'talk-error', at: Date.now() });
      throw new Error('simulated provider failure after successful vision');
    }
  };
  const e = await engine({ enabled: true, behavior: { maxTicksPerHour: 1, skipUnchanged: false } });
  const results = [];
  for (let i = 0; i < 3; i += 1) results.push((await e.runTick(false)).reason);
  assert.equal(calls.length, 2, '上限 1 轮时应只发生第一轮的 2 次模型请求');
  assert.equal(results.filter((r) => r === 'rate-limited').length, 2);
  assert.ok(e.getState().stats.llmCalls >= 2, '失败轮次的调用也要记账');
  emit({ results, actualModelCalls: calls.length, panelReportedModelCalls: e.getState().stats.llmCalls, tokensIn: e.getState().stats.tokensIn });
  await e.dispose();
} else if (mode === 'tokens') {
  const e = await engine();
  await e.captureNow();
  assert.equal(e.getState().stats.tokensOut, 34, '11(识图)+23(出话)=34');
  assert.equal(e.getState().stats.tokensIn, 300);
  assert.equal(e.getState().stats.llmCalls, 2);
  emit({ tokensIn: e.getState().stats.tokensIn, tokensOut: e.getState().stats.tokensOut, llmCalls: e.getState().stats.llmCalls });
  await e.dispose();
} else if (mode === 'chat-mute') {
  const e = await engine({ voice: { speakReplies: false } });
  const reply = await e.chat('这面木墙怎么样');
  assert.equal(e.getSettings().voice.speakReplies, false);
  assert.equal(speaks.length, 0, '关闭聊天朗读后不应调用语音');
  assert.equal(reply.spoken, false);
  emit({ speakReplies: false, actualSpeakCalls: speaks.length });
  await e.dispose();
} else if (mode === 'patch') {
  const e = await engine();
  await e.updateConfig({ voice: { voiceId: 'test-voice', speed: 1.4 } });
  await e.updateConfig({ voice: { volume: 0.5 } });
  assert.equal(e.getSettings().voice.voiceId, 'test-voice');
  assert.equal(e.getSettings().voice.speed, 1.4);
  assert.equal(e.getSettings().voice.volume, 0.5);
  emit({ voiceId: e.getSettings().voice.voiceId, speed: e.getSettings().voice.speed, volume: e.getSettings().voice.volume });
  await e.dispose();
} else if (mode === 'worldbook-path') {
  const { saveWorldbook, getWorldbookById, deleteWorldbook } = await load('worldbook.mjs');
  await mkdir(dataDir(), { recursive: true });
  const target = path.join(dataDir(), 'outside-worldbooks.json');
  await writeFile(target, JSON.stringify({ sentinel: 'outside-worldbooks' }));
  assert.equal(await getWorldbookById('../outside-worldbooks'), null);
  assert.equal(await deleteWorldbook('../outside-worldbooks'), false);
  await saveWorldbook({ id: '../outside-worldbooks', game: 'RimWorld', synopsis: 'should-not-escape' });
  const sentinel = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(sentinel.sentinel, 'outside-worldbooks');
  emit({ traversalReadRejected: true, traversalDeleteRejected: true, outsideFileIntact: true });
} else if (mode === 'worldbook-collision') {
  const { worldbookId, saveWorldbook, getWorldbook } = await load('worldbook.mjs');
  const names = ['Resident Evil 2', 'Resident Evil 4'];
  const ids = names.map(worldbookId);
  assert.notEqual(ids[0], ids[1]);
  await saveWorldbook({ game: names[0], synopsis: 'game-two' });
  await saveWorldbook({ game: names[1], synopsis: 'game-four' });
  assert.equal((await getWorldbook(names[0])).synopsis, 'game-two');
  assert.equal((await getWorldbook(names[1])).synopsis, 'game-four');
  emit({ ids, bothCorrect: true });
} else if (mode === 'sapi') {
  let volumeArgs = [];
  let fail = false;
  childProcess.execFile = (file, args, options, callback) => {
    volumeArgs = args;
    setTimeout(() => callback(fail ? new Error('simulated sapi failure') : null, '', ''), 0);
    return { on() {} };
  };
  syncBuiltinESMExports();
  const { makeVoice } = await load('voice.mjs');
  const cfg = normalizeConfig({ voice: { backend: 'sapi', volume: 0 } });
  const voice = makeVoice({ getConfig: () => cfg, log });
  const okResult = await voice.speak('系统语音回归测试');
  assert.equal(okResult.ok, true, '系统语音成功时应返回 ok');
  assert.equal(volumeArgs[volumeArgs.indexOf('-Volume') + 1], '0', '音量 0 应原样传给 SAPI');
  fail = true;
  const failResult = await voice.speak('系统语音失败测试');
  assert.equal(failResult.ok, false, 'SAPI 失败不应返回成功');
  assert.ok(voice.getBackendInfo().lastError);
  emit({ ok: okResult.backend, volume: volumeArgs[volumeArgs.indexOf('-Volume') + 1], failureReported: failResult.ok === false });
} else if (mode === 'cleanup-serialized') {
  const e = await engine({ enabled: true, capture: { keepFrames: 1 } });
  const started = Date.now();
  await e.runTick(false);
  assert.ok(e.getState().storage.lastCleanupAt >= started, '本轮返回前必须已完成清理');
  emit({ lastCleanupAt: e.getState().storage.lastCleanupAt, dirs: e.getState().storage.frames.dirs });
  await e.dispose();
} else if (mode === 'partial-capture-cache') {
  const e = await engine({ enabled: true, capture: { keepFrames: 1 }, behavior: { skipUnchanged: false } });
  e.CAPTURE.grab = async ({ tickId }) => {
    const dir = path.join(FRAMES_DIR, String(tickId));
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'frame-0.jpg');
    await writeFile(file, 'partial');
    return { ok: false, error: 'partial capture failed', frames: [{ path: file, hash: 'x', width: 1, height: 1 }], source: 'mock' };
  };
  for (let i = 0; i < 5; i += 1) await e.runTick(false);
  await new Promise((r) => setTimeout(r, 100));
  const dirs = (await readdir(FRAMES_DIR)).length;
  assert.ok(dirs <= 1, `截图失败残留应受 keep=1 限制，实际 ${dirs}`);
  assert.ok(e.getState().storage.frames.dirs <= 1, '面板占用应同步更新');
  emit({ dirs, panelDirs: e.getState().storage.frames.dirs });
  await e.dispose();
} else if (mode === 'cancelled-usage') {
  let e;
  const originalStream = ctx.llm.stream;
  ctx.llm.stream = async function* (options) {
    const vision = options.messages[0].content.some((x) => x.type === 'image');
    if (!vision) {
      setTimeout(() => { void e.updateConfig({ enabled: false }); }, 0);
      await new Promise((resolve, reject) => {
        if (options.signal.aborted) reject(new Error('aborted'));
        else options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return;
    }
    yield* originalStream(options);
  };
  e = await engine({ enabled: true });
  const result = await e.runTick(false);
  assert.equal(result.reason, 'cancelled');
  assert.equal(e.getState().stats.tokensIn, 100, '已完成的识图输入 Token 应保留');
  assert.equal(e.getState().stats.tokensOut, 11, '已完成的识图输出 Token 应保留');
  assert.equal(e.getState().stats.llmCalls, 2, '取消分支也要记录已发生的调用');
  emit({ result: result.reason, tokensIn: e.getState().stats.tokensIn, tokensOut: e.getState().stats.tokensOut, llmCalls: e.getState().stats.llmCalls });
  await e.dispose();
} else if (mode === 'legacy-worldbook') {
  const wb = await load('worldbook.mjs');
  await mkdir(path.join(dataDir(), 'worldbooks'), { recursive: true });
  const legacyId = wb.legacyWorldbookId('Resident Evil 2');
  assert.equal(legacyId, wb.legacyWorldbookId('Resident Evil 4'));
  await writeFile(path.join(dataDir(), 'worldbooks', `${legacyId}.json`), JSON.stringify({ id: legacyId, game: 'Resident Evil 4', synopsis: 'four' }));
  assert.equal(await wb.getWorldbook('Resident Evil 2'), null, '旧资料属于 4 时不能返回给 2');
  const four = await wb.getWorldbook('Resident Evil 4');
  assert.ok(four && four.synopsis === 'four', '旧资料游戏名匹配时仍可读取');
  emit({ legacyId, re2Rejected: true, re4Accepted: true });
} else if (mode === 'research-cancel') {
  const { researchWorldbook } = await load('research.mjs');
  const controller = new AbortController();
  let searches = 0;
  let modelCalls = 0;
  const ctx2 = {
    get: () => ({
      search: async () => {
        searches += 1;
        await new Promise((resolve) => setTimeout(resolve, 120));
        return { results: [{ title: 'x', url: 'https://example.com/x' }] };
      },
      fetch: async () => ({ body: { kind: 'text', content: 'x' } }),
    }),
    llm: { listProviders: () => [], listModels: async () => [], stream: async function* () { modelCalls += 1; yield { type: 'text-delta', index: 0, text: '{}' }; } },
  };
  const settings = normalizeConfig({ worldbook: { enabled: true } });
  const task = researchWorldbook({ ctx: ctx2, settings, gameName: 'RimWorld', log, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(task, (error) => error?.code === 'CANCELLED');
  assert.equal(modelCalls, 0, '取消后不应再调用整理模型');
  emit({ searches, modelCalls, cancelled: true });
} else if (mode === 'pause-research') {
  let releaseSearch;
  const searchGate = new Promise((resolve) => { releaseSearch = resolve; });
  const web = {
    search: async () => { await searchGate; return { results: [{ title: 'x', url: 'https://example.com/x' }] }; },
    fetch: async () => ({ body: { kind: 'text', content: 'x' } }),
  };
  ctx.get = (name) => (name === 'web' ? web : { saveImage: async () => ({ id: 'mock-image' }) });
  let releaseGrab;
  const grabGate = new Promise((resolve) => { releaseGrab = resolve; });
  let enteredGrab;
  const grabEntered = new Promise((resolve) => { enteredGrab = resolve; });
  const e = await engine({ enabled: true, worldbook: { enabled: true, autoResearch: true } });
  e.CAPTURE.grab = async ({ tickId }) => {
    const dir = path.join(FRAMES_DIR, String(tickId));
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'frame-0.jpg');
    await writeFile(file, 'frame');
    enteredGrab();
    await grabGate;
    return { ok: true, source: 'mock', frames: [{ path: file, hash: 'x', width: 1, height: 1, mediaType: 'image/jpeg' }] };
  };
  const running = e.runTick(false);
  await grabEntered;
  await e.updateConfig({ enabled: false });
  releaseSearch();
  releaseGrab();
  const result = await running;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(result.reason, 'cancelled');
  assert.notEqual(e.getState().worldbook.status, 'ready', '暂停后自动调研不应完成');
  const wbFiles = await readdir(path.join(dataDir(), 'worldbooks')).catch(() => []);
  assert.equal(wbFiles.filter((x) => x.endsWith('.json')).length, 0, '暂停后不应保存世界书');
  emit({ result: result.reason, worldbookStatus: e.getState().worldbook.status, saved: wbFiles.length, modelCalls: calls.length });
  await e.dispose();
} else {
  throw new Error(`unknown mode ${mode}`);
}
