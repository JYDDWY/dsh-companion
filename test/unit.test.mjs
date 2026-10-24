import { DEFAULTS, normalizeConfig, mergeConfig, mergeUserConfig, pickKnownKeys } from '../src/host/config.mjs';
import { identifyGame, classifyGenre, memoryWindowSec, identifyScene, isWatching, isCoding, scenarioLabel, sceneIntervalSec, sceneMemoryWindowSec } from '../src/host/games.mjs';
import { buildSystemPrompt, buildTalkPrompt, buildCastSystemPrompt, formatHistory, VISION_PROMPT, PROMPT_BLOCK_META, promptBlockDefaults, resolvePromptBlock } from '../src/host/prompt.mjs';
import { normalizeWorldbook, worldbookId, legacyWorldbookId, isWorldbookId, getWorldbookById, deleteWorldbook, worldbookPromptText } from '../src/host/worldbook.mjs';
import { sanitizeSpeech, parseVisionJson, sanitizeVisionText, stripModelNoise, splitEmotion, parseCastScript, EMOTIONS, extractJsonObject, isGenericFiller, isGroundlessStillness, isNagging, mentionsHudFocus } from '../src/host/llm.mjs';
import { normalizeCast, activeCastRoles, chooseCastSpeakers, withRolePersona, roleCard } from '../src/host/cast.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log('FAIL:', name); } };

// config
const c = normalizeConfig({ intervalSec: 9999, capture: { frameCount: 99, jpegQuality: 1 }, voice: { pitch: -99, speed: 9 }, behavior: { memoryMode: 'xxx' } });
ok(c.intervalSec === 3600, 'interval clamp');
ok(c.capture.frameCount === 8 && c.capture.jpegQuality === 40, 'capture clamp');
ok(c.voice.pitch === -12 && c.voice.speed === 2, 'voice clamp');
ok(c.behavior.memoryMode === 'auto', 'memory mode fallback');
ok(pickKnownKeys({ foo: 1, intervalSec: 3 }).intervalSec === 3 && pickKnownKeys({ foo: 1 }).foo === undefined, 'pickKnownKeys');
ok(mergeConfig({ capture: { frameCount: 2 } }).capture.frameIntervalMs === 300, 'deep merge keeps defaults');

// games
const behavior = c.behavior;
const rim = identifyGame({ available: true, title: 'RimWorld by Ludeon Studios', process: 'RimWorld.exe', fullscreen: false, minimized: false }, behavior);
ok(rim.isGame && rim.reason === 'whitelist' && rim.genre === 'long', 'rimworld classified long');
const pubg = identifyGame({ available: true, title: 'PUBG: BATTLEGROUNDS', process: 'TslGame.exe', fullscreen: true, minimized: false }, behavior);
ok(pubg.isGame && pubg.genre === 'short', 'pubg short');
const edge = identifyGame({ available: true, title: '某网页', process: 'msedge.exe', fullscreen: true, minimized: false }, behavior);
ok(!edge.isGame, 'edge ignored even fullscreen');
const desktopApp = identifyGame({ available: true, title: '开发陪玩应用 — DeepSeek Harness', process: 'DeepSeek Harness.exe', fullscreen: false }, behavior);
ok(!desktopApp.isGame, 'dsh ignored');
ok(memoryWindowSec(behavior, 'short') === 150 && memoryWindowSec(behavior, 'long') === 1200, 'memory windows');

// prompt
const agents = '你是高性能舰载AI……';
const sys = buildSystemPrompt(c, agents, 'RimWorld');
ok(sys.includes('AGENTS.md') && sys.includes('温柔') && sys.includes('RimWorld'), 'system prompt content');
const hist = formatHistory([{ role: 'assistant', text: 'a', at: Date.now() - 10_000 }, { role: 'user', text: 'b', at: Date.now() - 300_000 }], Date.now(), 150);
ok(hist.includes('你：a') && !hist.includes('主人：b'), 'history window filters old');
const talk = buildTalkPrompt({ game: 'RimWorld', windowTitle: 'RimWorld', playingForSec: 120, vision: { game: 'RimWorld', scene: '战斗中' }, historyText: '', windowSec: 150, genre: 'long' });
ok(talk.includes('剧情/策略') && talk.includes('战斗中'), 'talk prompt');

// sanitize
ok(sanitizeSpeech('（笑）这波真行！') === '这波真行！', 'strip stage direction');
ok(sanitizeSpeech('**你太强了**') === '你太强了', 'strip markdown');
ok(sanitizeSpeech('用 shift 翻滚') !== '', 'keep english');
ok(sanitizeSpeech('{\n "say": "哈哈，这下稳了"\n}') === '哈哈，这下稳了', 'json unwrap');
ok(sanitizeSpeech('```json\n{"say":"好啊"}\n```') === '好啊', 'code fence');
ok(sanitizeSpeech('<|tool_call|>invoke') === '' || !sanitizeSpeech('<|tool_call|>invoke').includes('invoke'), 'tool markup');
const v = parseVisionJson('```json\n{"game":"PUBG","scene":"战斗中","state":"血 30","notable":"两把狙"}\n```');
ok(v && v.game === 'PUBG' && v.state === '血 30', 'vision json parse');
ok(sanitizeVisionText('第一行\n第二行') === '第一行\n第二行', 'vision text');
ok(stripModelNoise('```x```') === '', 'noise strip');

// defaults complete
ok(Object.keys(DEFAULTS).length > 8 && DEFAULTS.intervalSec === 45, 'defaults');

// ── 场景识别 / 情绪标签 ──────────────────────────────────────────
const sceneBehavior = {
  ...c.behavior,
  ignoreProcesses: ['DeepSeek Harness', 'explorer', 'msedge', 'chrome'],
  scenarios: { game: true, watching: true, coding: true },
  games: ['RimWorld*', 'PUBG*', 'Monster Hunter*'],
};
const win = (patch) => ({ available: true, minimized: false, fullscreen: false, process: 'x.exe', title: 'x', ...patch });

ok(identifyScene(win({ title: 'RimWorld by Ludeon Studios', process: 'RimWorld.exe', fullscreen: true }), sceneBehavior).kind === 'game', 'scene game');
const watch1 = identifyScene(win({ title: '【第 3 集】某某动画 1080P 中字 - 哔哩哔哩', process: 'msedge.exe' }), sceneBehavior);
ok(watch1.kind === 'watching' && watch1.memoryGenre === 'long', 'scene watching by title');
ok(isWatching(win({ title: 'mpv', process: 'mpv.exe', fullscreen: true }), sceneBehavior) === true, 'watching by player process');
const code1 = identifyScene(win({ title: 'main.mjs - 我的项目 - Visual Studio Code', process: 'Code.exe' }), sceneBehavior);
ok(code1.kind === 'coding', 'scene coding by editor');
ok(isCoding(win({ title: '终端', process: 'WindowsTerminal.exe' }), sceneBehavior) === true, 'coding by terminal');
ok(identifyScene(win({ title: '随手记 - 记事本', process: 'notepad.exe' }), sceneBehavior).kind === 'other', 'plain notepad not coding');
ok(scenarioLabel('watching') === '陪看剧' && scenarioLabel('coding') === '陪写代码', 'scenario labels');
ok(sceneIntervalSec(sceneBehavior, 'watching') === 45 && sceneIntervalSec(sceneBehavior, 'coding') === 45, 'scene intervals use top-level');
ok(sceneMemoryWindowSec(sceneBehavior, 'watching', 'unknown') >= 1800, 'watching long memory');

const emo = splitEmotion('【情绪：吐槽】\n你居然真的带了两把狙？');
ok(emo.emotion === 'tsukkomi' && emo.text === '你居然真的带了两把狙？', 'split emotion line');
const emo2 = splitEmotion('【情绪：兴奋】哈哈这波漂亮！');
ok(emo2.emotion !== 'happy' && emo2.emotion === 'excited', 'split emotion same line');
ok(splitEmotion('你太强了').emotion === 'neutral', 'no emotion -> neutral');
ok(EMOTIONS.includes('sigh') && EMOTIONS.includes('tsukkomi'), 'emotion whitelist');

// ── 世界书 / 调度回归 ──────────────────────────────────────────
const fullSettings = { ...c, intervalSec: 45, behavior: { ...c.behavior, watchingIntervalSec: 60, codingIntervalSec: 90 } };
ok(sceneIntervalSec(fullSettings, 'game') === 45, 'game interval from top-level intervalSec');
ok(sceneIntervalSec(fullSettings, 'watching') === 45, 'watching uses top-level interval');
ok(sceneIntervalSec(fullSettings, 'coding') === 45, 'coding uses top-level interval');
ok(Number.isFinite(sceneIntervalSec({ intervalSec: 45, behavior: {} }, 'game')), 'interval never NaN (bug regression)');
ok(Number.isFinite(sceneIntervalSec({}, 'watching')), 'interval finite with empty settings');
ok(sceneMemoryWindowSec({ intervalSec: 45, behavior: { memoryLongSec: 1200 } }, 'watching', 'unknown') >= 1800, 'memory finite');

ok(worldbookId('HELLDIVERS™ 2') === worldbookId('helldivers 2'), 'worldbook id stable');
const wbEntry = normalizeWorldbook({ game: 'HELLDIVERS 2', title: 'HELLDIVERS 2', synopsis: '合作射击', beginnerSteps: ['先做教程'], terms: [{ term: '战略配备', meaning: '呼叫支援' }], confidence: 'web' }, { gameName: 'HELLDIVERS 2' });
ok(wbEntry.id && wbEntry.beginnerSteps.length === 1 && wbEntry.terms[0].term === '战略配备', 'worldbook normalize');
const wbText = worldbookPromptText(wbEntry, 800);
ok(wbText.includes('HELLDIVERS 2') && wbText.includes('战略配备') && wbText.includes('可能不完整'), 'worldbook prompt text');
const talkWithWb = buildTalkPrompt({ kind: 'game', game: 'HELLDIVERS 2', worldbookText: wbText, vision: null, historyText: '', windowSec: 150, genre: 'short' });
ok(talkWithWb.includes('世界书') && talkWithWb.includes('战略配备'), 'talk prompt injects worldbook');
const gentleSystem = buildSystemPrompt({ ...c, persona: { ...c.persona, style: 'gentle' } }, '', { kind: 'game', label: 'HELLDIVERS 2' });
ok(gentleSystem.includes('温柔') && gentleSystem.includes('别不懂装懂'), 'gentle style + honesty rules');
const parsedJson = extractJsonObject('好的，结果如下：\n```json\n{"title":"X","nested":{"a":"b}"},"list":[1,2]}\n```\n以上');
ok(parsedJson && parsedJson.title === 'X' && parsedJson.list.length === 2, 'extractJsonObject fenced + braces');

// ── 禁止空话 ───────────────────────────────────────────────────
ok(isGenericFiller('我在这儿陪着你，需要搭句话随时喊我。') === true, 'filler: companion cliché');
ok(isGenericFiller('慢慢来就好，我在这儿陪着你。') === true, 'filler: 慢慢来');
ok(isGenericFiller('加油哦，注意安全。') === true, 'filler: 加油/注意安全');
ok(isGenericFiller('你血只剩四分之一了，先往掩体后面撤，别硬冲。') === false, 'not filler: concrete');
ok(isGenericFiller('传送背包冷却好了，跳过去把黑匣子传了吧。') === false, 'not filler: concrete 2');
ok(DEFAULTS.talk.banFiller === true, 'banFiller default on');
const fillerSystem = buildSystemPrompt({ ...c, persona: { ...c.persona, style: 'gentle' } }, '', { kind: 'game', label: 'HELLDIVERS 2' });
ok(fillerSystem.includes('禁止说废话') && fillerSystem.includes('我在这儿陪着你'), 'system prompt bans filler with examples');

// ── 静止误判拦截 / 动作字段 ────────────────────────────────────
ok(isGroundlessStillness('你怎么还站着不动啊，赶紧走。', 1) === true, 'stillness claim with active input -> flagged');
ok(isGroundlessStillness('你怎么还站着不动啊，赶紧走。', 60) === false, 'stillness claim with long idle -> allowed');
ok(isGroundlessStillness('先别站着发呆，前面有虫。', 2) === true, 'stillness claim 2');
ok(isGroundlessStillness('你血不多了，先撤到掩体后面。', 1) === false, 'concrete advice not flagged');
ok(isGroundlessStillness('继续跑，前面虫巢快到了。', 0) === false, 'movement advice not flagged');
const vp = parseVisionJson('{"game":"X","scene":"战斗","state":"血少","objective":"","threat":"","options":"","notable":"","motion":"在跑动","frameDiff":"视角有变化"}');
ok(vp && vp.motion === '在跑动' && vp.frameDiff === '视角有变化', 'vision parse keeps motion/frameDiff');
const talkActivity = buildTalkPrompt({ kind: 'game', game: 'X', activity: { idleSec: 1.2, framesIdentical: false, frameDiff: '三张图有可见变化' }, vision: null, historyText: '', windowSec: 150, genre: 'short' });
ok(talkActivity.includes('键鼠活跃度') && talkActivity.includes('帧间差异'), 'talk prompt injects activity');

// ── 世界书可信度 / 来源 ────────────────────────────────────────
const wbWithSources = normalizeWorldbook({
  game: 'HELLDIVERS 2', title: 'HELLDIVERS 2', synopsis: '联机射击',
  verification: '参考 3 个玩家社区教学贴，已交叉核对',
  sources: [{ title: '贴吧攻略', url: 'https://tieba.baidu.com/p/123' }, { title: '小黑盒', url: 'https://xiaoheihe.cn/123' }],
  confidence: 'web',
}, { gameName: 'HELLDIVERS 2' });
ok(wbWithSources.verification.includes('教学贴') && wbWithSources.sources.length === 2, 'worldbook verification + sources');
const wbText2 = worldbookPromptText(wbWithSources, 800);
ok(wbText2.includes('资料可信度') && wbText2.includes('教学贴'), 'worldbook prompt shows credibility');

// ── 观察节奏（两次观察间隔）────────────────────────────────────
const cadencePrompt = buildTalkPrompt({ kind: 'game', game: 'HELLDIVERS 2', sinceLastSec: 45, vision: null, historyText: '', windowSec: 150, genre: 'short' });
ok(cadencePrompt.includes('距离上次观察：45 秒前'), 'talk prompt includes observation gap');
ok(cadencePrompt.includes('快节奏游戏') && cadencePrompt.includes('旧闻'), 'short genre warns stale events');
const firstPrompt = buildTalkPrompt({ kind: 'game', game: 'X', sinceLastSec: null, vision: null, historyText: '', windowSec: 150, genre: 'long' });
ok(firstPrompt.includes('第一次观察'), 'first observation marker');
const agedHistory = formatHistory([{ role: 'assistant', text: 'a', at: Date.now() - 42000 }], Date.now(), 150);
ok(agedHistory.includes('秒前') && agedHistory.includes('你：a'), 'history entries carry relative age');

// ── 喝彩模式（少说教、多夸高光）────────────────────────────────
ok(isNagging('先按 R 装弹，别站那儿发呆。') === true, 'nag detected');
ok(isNagging('你该先撤到掩体后面。') === true, 'nag detected 2');
ok(isNagging('卧槽，刚才那一下爆头太帅了！') === false, 'cheer not nag');
ok(mentionsHudFocus('你弹药只剩三发了。') === true, 'hud focus ammo');
ok(mentionsHudFocus('任务目标还没完成呢。') === true, 'hud focus objective');
ok(mentionsHudFocus('那一枪把整片虫群炸飞了！') === false, 'action not hud');
const cheerPrompt = buildTalkPrompt({ kind: 'game', game: 'HELLDIVERS 2', cheerMode: true, vision: { game: 'HELLDIVERS 2', highlight: '一发铝热剂清掉整窝虫', action: '开火', state: '弹药 12 发', objective: '上传黑匣子' }, historyText: '', windowSec: 150, genre: 'short' });
ok(cheerPrompt.includes('喝彩') && cheerPrompt.includes('高光') && cheerPrompt.includes('少说教'), 'cheer prompt injected');
ok(cheerPrompt.includes('背景：玩家状态') && cheerPrompt.includes('别主动提'), 'hud fields marked background');
const visionParsed = parseVisionJson('{"game":"X","scene":"战斗","state":"","objective":"","threat":"","options":"","notable":"","motion":"开火","frameDiff":"","action":"开火击杀","highlight":"一发火箭清场"}');
ok(visionParsed && visionParsed.highlight === '一发火箭清场' && visionParsed.action === '开火击杀', 'vision parses action/highlight');

// ── v1.5 音量/名字/预设 ─────────────────────────────────────────
const cfgVolume = normalizeConfig({ voice: { volume: 1.7 }, persona: { name: '小陪' } });
ok(Math.abs(cfgVolume.voice.volume - 1.7) < 0.001, 'voice volume normalized');
ok(cfgVolume.persona.name === '小陪', 'persona name normalized');
const cfgNameDefault = normalizeConfig({});
ok(cfgNameDefault.persona.name === '陪玩', 'persona name default 陪玩');

// ── v1.6 提示词块化 / 少提问 ──────────────────────────────────
ok(PROMPT_BLOCK_META.length === 5 && PROMPT_BLOCK_META.some((b) => b.id === 'cheer'), 'prompt blocks meta');
const pbDefaults = promptBlockDefaults(c);
ok(Object.keys(pbDefaults).length === 5 && pbDefaults.questions.includes('少提问'), 'prompt block defaults');
const pbOverride = { ...c, persona: { ...c.persona, promptOverrides: { filler: '自定义空话规则' } } };
ok(resolvePromptBlock(pbOverride, 'filler') === '自定义空话规则' && resolvePromptBlock(pbOverride, 'honesty') === pbDefaults.honesty, 'prompt block override resolves');
const sysWithQuestions = buildSystemPrompt(c, '', { kind: 'game', label: 'X' });
ok(sysWithQuestions.includes('少提问') && sysWithQuestions.includes('问号'), 'system prompt includes question rules');
const cfgPb = normalizeConfig({ persona: { promptOverrides: { style: '自定义', bogus: 'x' } }, talk: { banQuestions: false } });
ok(cfgPb.persona.promptOverrides.style === '自定义' && !('bogus' in cfgPb.persona.promptOverrides) && cfgPb.talk.banQuestions === false, 'prompt overrides normalized');

// ── 发布前审查回归（R03/R05/R10/R12/R13）────────────────────────
const mergedUser = mergeUserConfig({ voice: { voiceId: 'test-voice', speed: 1.4 } }, { voice: { volume: 0.5 } });
ok(mergedUser.voice.voiceId === 'test-voice' && mergedUser.voice.speed === 1.4 && mergedUser.voice.volume === 0.5, 'R12 patch deep merge keeps sibling fields');
ok(worldbookId('Resident Evil 2') !== worldbookId('Resident Evil 4'), 'R10 sequel numbers preserved');
ok(worldbookId('Elden Ring v1.2') === worldbookId('Elden Ring'), 'R10 explicit version stripped');
ok(legacyWorldbookId('Resident Evil 2') === worldbookId('Resident Evil'), 'R10 legacy id still available');
ok(isWorldbookId('a1b2c3d4e5f6') && !isWorldbookId('../config') && !isWorldbookId('a1b2c3d4e5f6.json'), 'R03 id whitelist');
ok((await getWorldbookById('../../config')) === null, 'R03 traversal read rejected');
ok((await deleteWorldbook('../outside-worldbooks')) === false, 'R03 traversal delete rejected');
ok(normalizeWorldbook({ game: 'Test Game', id: '../../evil' }).id === worldbookId('Test Game'), 'R03 model id ignored on create');

// ── 字幕延时 / 双色 / 多人角色 ─────────────────────────────────
const subtitleCfg = normalizeConfig({ subtitle: { delaySec: 99, color: 'bad', color2: '#123456' } });
ok(subtitleCfg.subtitle.delaySec === 10, 'subtitle delay clamps to 0-10s');
ok(subtitleCfg.subtitle.color === '#eaf6ff' && subtitleCfg.subtitle.color2 === '#123456', 'subtitle colors normalized');
const subtitleFallback = normalizeConfig({ subtitle: { color: '#112233', color2: 'nope' } });
ok(subtitleFallback.subtitle.color2 === '#112233', 'invalid color2 falls back to color');
ok(DEFAULTS.subtitle.color === '#eaf6ff' && DEFAULTS.subtitle.color2 === '#4da3ff', 'blue-white subtitle default');
ok(DEFAULTS.subtitle.clickThrough === true && normalizeConfig({ subtitle: { clickThrough: false } }).subtitle.clickThrough === false, 'subtitle click-through default + toggle');

const castDefaults = normalizeConfig({});
ok(castDefaults.cast.enabled === false && castDefaults.cast.roles.length === 3, 'cast defaults: off + 3 slots');
ok(castDefaults.cast.roles[0].enabled && castDefaults.cast.roles[1].enabled && !castDefaults.cast.roles[2].enabled, 'cast default role enablement');
ok(castDefaults.cast.mainChance === 70 && castDefaults.cast.roles[0].speakChance === 70 && castDefaults.cast.randomOrder === true, 'cast default per-role chance/order');
const castOn = normalizeConfig({
  persona: {
    name: '阿岚', style: 'cheerful', relation: '搭档', useAgentsMd: true, extra: '主角色人设',
    promptOverrides: { style: '主角色自定义风格' },
  },
  voice: { voiceId: 'march7' },
  cast: {
    enabled: true,
    mainChance: 100,
    randomOrder: false,
    roles: [
      { enabled: true, card: 'cheerful', name: '阿岚（这条不再使用）', voiceId: 'ignored', useAgentsMd: true },
      { enabled: true, card: 'tsundere', name: '小满', speakChance: 30 },
    ],
  },
});
ok(castOn.cast.roles.length === 3 && castOn.cast.roles[1].name === '小满', 'cast roles preserve names');
ok(castOn.cast.roles[2].enabled === false, 'missing third role stays disabled');
const castActive = activeCastRoles(castOn);
ok(castActive.length === 2 && castActive[0].main === true && castActive[0].name === '阿岚' && castActive[1].card === 'tsundere', 'activeCastRoles = main persona + extras');
ok(castActive[0].speakChance === 100 && castActive[1].speakChance === 30, 'each role keeps its own speak chance');
const castPersona = withRolePersona(castOn, castActive[0]);
ok(castPersona.persona.name === '阿岚' && castPersona.persona.style === 'cheerful' && castPersona.persona.useAgentsMd === true, 'main role reuses global persona');
ok(castPersona.persona.promptOverrides.style === '主角色自定义风格', 'main role keeps global style override');
const extraPersona = withRolePersona(castOn, castActive[1]);
ok(extraPersona.persona.name === '小满' && extraPersona.persona.promptOverrides.style === undefined, 'extra role uses role card and drops style override');
ok(roleCard('tsundere').name === '损友吐槽', 'role card lookup');
const castSystem = buildCastSystemPrompt(castOn, '本体人格文本', castActive, { kind: 'game', label: 'RimWorld' });
ok(castSystem.includes('角色表') && castSystem.includes('阿岚') && castSystem.includes('本体人格文本'), 'cast system includes roles + agents');
ok(castSystem.includes('只适用于以下角色：阿岚') && castSystem.includes('其他角色不得使用它的口吻'), 'agents scope is limited to selected roles');
const castTalk = buildTalkPrompt({ kind: 'game', game: 'RimWorld', cast: castActive, historyText: '', windowSec: 150, genre: 'long', config: castOn });
ok(castTalk.includes('剧团输出格式') && castTalk.includes('"role":"r1"') && castTalk.includes('每个角色各说 1 句'), 'cast talk prompt demands JSON script');
const castParsed = parseCastScript('{"lines":[{"role":"r1","emotion":"开心","text":"阿岚的台词。"},{"role":"r2","emotion":"吐槽","text":"小满的台词。"},{"role":"r1","emotion":"开心","text":"重复的角色。"}]}', castActive);
ok(castParsed.lines.length === 2 && castParsed.lines[0].roleId === 'r1' && castParsed.lines[1].emotion === 'tsukkomi', 'cast JSON parser + duplicate role dropped');
const castFallback = parseCastScript('阿岚：开心！\n小满：这墙有点挤。', castActive);
ok(castFallback.lines.length === 2 && castFallback.lines[0].name === '阿岚', 'cast fallback line parser');
const castNames = parseCastScript('{"lines":[{"role":"阿岚","emotion":"温柔","text":"按名字匹配也可以。"}]}', castActive);
ok(castNames.lines.length === 1 && castNames.lines[0].name === '阿岚' && castNames.lines[0].emotion === 'gentle', 'cast parser matches role name');
const noSpeakers = chooseCastSpeakers(castActive.map((role) => ({ ...role, speakChance: 0 })), () => 0.9, false);
ok(noSpeakers.length === 1, 'cast speaker probability always leaves one role');
const allSpeakers = chooseCastSpeakers(castActive.map((role) => ({ ...role, speakChance: 100 })), () => 0.5, false);
ok(allSpeakers.length === 2 && allSpeakers[0].id === 'r1' && allSpeakers[1].id === 'r2', 'cast speaker probability 100 picks all in order');
const independent = chooseCastSpeakers(castActive, () => 0.5, false);
ok(independent.length === 1 && independent[0].id === 'r1', 'each role rolls its own chance independently');
ok(normalizeCast({ enabled: true, roles: [] }).roles.length === 3, 'normalizeCast always returns three slots');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
