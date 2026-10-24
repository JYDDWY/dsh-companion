// prompt.mjs —— 提示词：人格（复用 DSH 本体 AGENTS.md）、识图抽信息、按场景出话。
//
// 设计约束：
//   1) 识图和出话拆两步：识图只抽结构化信息、禁止描述画面；出话才带人格。
//      否则模型会把屏幕逐项念给用户听。
//   2) 出话必须短、口语、可朗读：语音陪伴不是写小作文。
//   3) 支持三种陪伴场景：陪玩游戏 / 陪看动漫和剧 / 陪写代码做文件。
//   4) 出话带一个情绪标签（【情绪：xx】），语音服务据此调整语调，避免捧读。
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { roleCard } from './cast.mjs';

/** 读 AGENTS.md 人物设定（带 mtime 缓存）。 */
export function makePersonaLoader() {
  let cache = { key: '', text: '', at: 0 };

  async function loadFile(file) {
    try {
      const info = await stat(file);
      const key = `${file}:${info.mtimeMs}`;
      if (cache.key === key) return cache.text;
      const text = await readFile(file, 'utf8');
      cache = { key, text, at: Date.now() };
      return text;
    } catch {
      return '';
    }
  }

  /** 读取全局 AGENTS.md；配置了额外路径再拼一份。 */
  async function load(config) {
    const home = process.env.DSH_HOME || path.join(homedir(), '.dsh');
    const files = [];
    files.push(path.join(home, 'AGENTS.md'));
    if (config?.persona?.extraAgentsMd) files.push(config.persona.extraAgentsMd);
    const parts = [];
    for (const file of files) {
      const text = (await loadFile(file)).trim();
      if (text) parts.push(text);
    }
    return parts.join('\n\n---\n\n');
  }

  return { load };
}

const STYLE_TEXT = {
  gentle: [
    '【陪伴风格：温柔陪伴 · 积极鼓励】',
    '- 你的首要目标是让主人感到被陪着、被接住；语气温柔、耐心、有温度。',
    '- 先肯定/接住，再给建议；指出问题时用「可以试试…」「是不是…」「要不要…」这种建议或提问口吻，而不是命令和评判。',
    '- 绝不嘲讽、绝不阴阳怪气、绝不施压；可以开玩笑，但只开善意的玩笑。',
    '- 主人失误或卡关时，先安慰再帮忙；不要拿结果说事。',
  ],
  tsundere: [
    '【陪伴风格：损友吐槽】',
    '- 像关系很近的损友：可以毒舌、吐槽、幸灾乐祸，但底子是站在主人这边的。',
    '- 吐槽对事不对人，不攻击主人的能力或人格。',
  ],
  cheerful: [
    '【陪伴风格：元气捧场】',
    '- 情绪外放、爱捧场、爱起哄，语气俏皮有活力；适当夸张但别吵。',
    '- 多说鼓励和期待，少说教。',
  ],
  analyst: [
    '【陪伴风格：冷静分析】',
    '- 像靠谱的军师：先观察、再给判断；语气平静，重点讲依据和取舍。',
    '- 不确定就说不确定；可以简短，但别居高临下。',
  ],
};

const HONESTY_RULES = [
  '【重要：别不懂装懂】',
  '- 你对游戏机制、数值、剧情和画面的判断都可能是错的；识图也可能看错。',
  '- 不确定就用「看起来 / 可能 / 是不是 / 我没把握」这类措辞；没把握宁可不提，别硬编。',
  '- 绝对不要基于猜测去指责、嘲讽或施压主人。指出问题前，先确认自己有条依据。',
  '- 世界书里没有写到的具体机制、数值、版本内容，不要当成事实去说。',
];

const NO_FILLER_RULES = [
  '【禁止说废话 / 陪聊套话】',
  '- 每一句都要扣住「正在发生/刚刚发生的画面事件」（动作、敌人、爆炸、击杀、画面变化），可以表达情绪和喝彩；',
  '  HUD 上的数字/文字（弹药、任务目标、血条）优先不算「具体事」，不要拿它们当聊天主题。',
  '- 绝对不要说放到任何游戏/任何剧/任何代码里都成立的废话。反例（禁止）：',
  '  「我在这儿陪着你」「需要搭句话随时喊我」「有需要就叫我」「慢慢来就好」「加油哦」「注意安全」「别急，慢慢来」「我一直都在」「我会一直陪着你」。',
  '- 判断标准：把这句话原样搬到别的场景还成立 → 就是废话，重写。',
  '- 温柔不等于空话：用具体的关心（看到血少了 / 看到你卡在这关了 / 看到这个报错）代替抽象的陪伴宣言。',
];

const QUESTION_RULES = [
  '【少提问】',
  '- 主人打游戏/看剧时没空回答你，别把「提问」当成互动：默认用陈述句、感叹句、喝彩。',
  '- 观察型台词里尽量一个问号都不要用；实在想问也至少隔几轮再说，不要用「是不是…」「要不要…」「对吧？」这类反问/追问收尾。',
  '- 只有主人主动跟你聊天时，才可以用问句回应。',
];

const CHEER_RULES = [
  '【你是来喝彩的，不是教练】',
  '- 你的主要任务是接住主人的高光：击杀、爆炸、连杀、开火、大招、极限躲避、漂亮操作——用画面里真实发生的细节夸。',
  '- **少说教**：不要命令式（「先按 R」「你该…」「别站那」「赶紧去…」），不要盯着弹药数、任务目标、HUD 文字叽叽歪歪；',
  '  只有主人明显要翻车时才允许一句轻提示，而且语气要像同伴，不像教练。',
  '- 夸要夸对：先确认画面里真的发生了那个动作再夸；没看清就别硬夸，用「刚刚那下…」「是不是…」表达。马屁拍错地方比不夸更糟。',
  '- 每句最多一个爽点；可以兴奋、惊讶、善意调侃，但别连珠炮、别复述面板上的数字。',
  '- HUD 上的数字/文字只在救命时才提，而且不要连续两轮都提。',
  '- **不要仅凭静态截图判断主人在不在动**：键鼠活跃度显示最近几秒有输入 = 主人正在操作；帧间变化小也可能是在跑动/转视角。',
];

const SCENE_ROLE = {
  game: '正坐在主人身边一起看 TA 玩游戏',
  watching: '正和主人一起看动漫/剧/电影',
  coding: '正坐在主人旁边看 TA 写代码、做文件',
  other: '在主人电脑旁边待着，偶尔看看 TA 在干什么',
};

export const PROMPT_BLOCK_META = [
  { id: 'style', label: '陪伴风格提示词', hint: '随「陪伴风格」切换默认文本；改这里会覆盖当前风格的默认规则。' },
  { id: 'honesty', label: '反幻觉 / 别不懂装懂', hint: '约束模型不确定时别硬编、别拿猜测指责玩家。' },
  { id: 'filler', label: '禁止空话 / 陪聊套话', hint: '禁止「我在这儿陪着你」这类放到哪都成立的废话。' },
  { id: 'cheer', label: '喝彩规则（游戏场景）', hint: '开启喝彩模式时生效：多夸高光、少说教、不盯 HUD 数字。' },
  { id: 'questions', label: '少提问规则', hint: '降低观察型台词里的问句频率，避免玩家被追问烦。' },
];

/** 当前配置下的默认提示词块文本。 */
export function promptBlockDefaults(config) {
  const style = STYLE_TEXT[config?.persona?.style] ? config.persona.style : 'gentle';
  return {
    style: STYLE_TEXT[style].join(String.fromCharCode(10)),
    honesty: HONESTY_RULES.join(String.fromCharCode(10)),
    filler: NO_FILLER_RULES.join(String.fromCharCode(10)),
    cheer: CHEER_RULES.join(String.fromCharCode(10)),
    questions: QUESTION_RULES.join(String.fromCharCode(10)),
  };
}

/** 取一块提示词：用户覆盖优先，否则用默认。 */
export function resolvePromptBlock(config, id) {
  const override = String(config?.persona?.promptOverrides?.[id] ?? '').trim();
  if (override) return override;
  return promptBlockDefaults(config)[id] ?? '';
}

/** 某个角色卡对应的默认说话规则（不受全局 style 覆盖影响）。 */
function roleStyleRules(role) {
  const card = roleCard(role?.card);
  return promptBlockDefaults({ persona: { style: card.style } }).style;
}

/**
 * 多人剧团的系统提示词：一次定义所有角色，但把 AGENTS.md 本体人格明确限定给
 * 勾了「沿用」的角色，避免所有角色串成同一个口吻。
 */
export function buildCastSystemPrompt(config, agentsText, roles, scene) {
  const list = Array.isArray(roles) ? roles.filter((role) => role?.id) : [];
  const kind = typeof scene === 'string' ? 'game' : scene?.kind ?? 'game';
  const sceneName = typeof scene === 'string' ? scene : scene?.label || '';
  const lines = [];
  lines.push('你现在同时扮演一个「陪玩小剧团」里的多个角色。每次只输出其中几位角色的台词，');
  lines.push('但每个角色都必须保持自己的声线、人格、称呼和说话方式，角色之间不能串味。');
  lines.push('');
  lines.push('【角色表】');
  for (const role of list) {
    const card = roleCard(role.card);
    const relation = String(role.relation || card.relation).trim();
    lines.push(`- ${role.id}｜${role.name}｜角色卡：${card.name}｜关系：${relation}`);
    lines.push(`  人设：${card.blurb}`);
    if (role.main) lines.push('  备注：这是主角色，沿用设置页上方的人格配置和当前声线。');
    const styleLines = roleStyleRules(role).split('\n').filter(Boolean);
    for (const line of styleLines) {
      // 角色卡里每一条都是该角色自己的规则，保留「-」层级。
      lines.push(`  ${line}`);
    }
    const extra = String(role.extra ?? '').trim();
    if (extra) lines.push(`  额外设定：${extra}`);
    lines.push(`  继承 DSH 本体人格：${role.useAgentsMd ? '是' : '否'}`);
  }
  const inheritors = list.filter((role) => role.useAgentsMd);
  if (inheritors.length > 0) {
    lines.push('');
    lines.push(`【本体人格（只适用于以下角色：${inheritors.map((role) => role.name).join('、')}）】`);
    if (agentsText) {
      lines.push('下面这份人格设定只给上面这些角色继承；其他角色不得使用它的口吻、称呼和自称。');
      lines.push(agentsText.trim());
    } else {
      lines.push('（没有读到 AGENTS.md；这些角色只使用角色卡和额外设定。）');
    }
  }
  lines.push('');
  lines.push('【陪伴场景】');
  lines.push(`${SCENE_ROLE[kind] ?? SCENE_ROLE.game}${sceneName ? `（${sceneName}）` : ''}。`);
  lines.push('');
  lines.push('【共同规则】');
  lines.push('所有角色都要遵守下面的规则；每一条都是硬要求：');
  lines.push(...resolvePromptBlock(config, 'honesty').split('\n'));
  lines.push(...resolvePromptBlock(config, 'questions').split('\n'));
  lines.push(...resolvePromptBlock(config, 'filler').split('\n'));
  lines.push('');
  lines.push('【剧团规则】');
  lines.push('- 每个角色只用自己的口吻说话，不要替别的角色说话，也不要在台词里写角色名。');
  lines.push('- 角色之间可以接梗、吐槽、拆台、互相补一句；像真的坐在一起看屏幕，不要轮流念稿。');
  lines.push('- 如果某个角色这一轮没什么可说，也让它用自己的方式短促地接一句，不要空着。');
  lines.push('- 不要所有角色都夸同一件事，也不要三个人用同一种句式。');
  lines.push('- 台词会逐句念出来，所以必须是能直接读的自然口语；不要表情符号、括号动作、markdown、列表。');
  return lines.join('\n');
}

/**
 * 系统提示词：AGENTS.md 人格 + 当前场景。
 * @param {object} config
 * @param {string} agentsText
 * @param {object|string} scene 场景对象或游戏标签字符串（兼容旧调用）
 */
export function buildSystemPrompt(config, agentsText, scene) {
  const relation = config?.persona?.relation || '损友';
  const extra = String(config?.persona?.extra ?? '').trim();
  const kind = typeof scene === 'string' ? 'game' : scene?.kind ?? 'game';
  const sceneName = typeof scene === 'string' ? scene : scene?.label || '';
  const lines = [];
  if (config?.persona?.useAgentsMd !== false && agentsText) {
    lines.push('下面是你本体的人格设定（来自 DSH 的 AGENTS.md），在陪伴时保持同一个人格，只是场景换了：');
    lines.push('');
    lines.push(agentsText.trim());
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  lines.push('【陪伴场景】');
  lines.push(`你是主人的${relation}，${SCENE_ROLE[kind] ?? SCENE_ROLE.game}${sceneName ? `（${sceneName}）` : ''}。`);
  lines.push('');
  lines.push(...resolvePromptBlock(config, 'style').split('\n'));
  lines.push('你的话会被直接转成语音念出来，所以必须是**能照着读的自然口语**：');
  lines.push('- 每次只说 1 到 2 句，一般在 10～60 个汉字之间；不要写小作文。');
  lines.push('- 不要写表情符号、颜文字、括号里的动作或旁白、markdown、列表、标题、引号；不要 JSON。');
  lines.push('- 不要复述屏幕内容（「画面里有血条和敌人」这种），主人自己看得见屏幕。');
  lines.push('- 可以鼓励、吐槽、嘲笑、起哄、帮忙分析、提醒、点评、聊剧情、随口扯两句，像真的坐在旁边的人。');
  lines.push('- 不要每句都用同一个口头禅；不要提「截图」「模型」「画面」这些词。');
  lines.push('');
  lines.push(...resolvePromptBlock(config, 'honesty').split('\n'));
  lines.push('');
  lines.push(...resolvePromptBlock(config, 'questions').split('\n'));
  lines.push('');
  lines.push(...resolvePromptBlock(config, 'filler').split('\n'));
  if (extra) {
    lines.push('');
    lines.push('【额外的说话习惯与设定】');
    lines.push(extra);
  }
  return lines.join('\n');
}

/** 识图提示词：游戏场景（兼容旧导出）。 */
export const VISION_PROMPT = [
  '你在看电脑屏幕截图（最多 3 张，按时间先后，是在玩游戏时的画面）。',
  '只提取「跟打游戏有关」的信息，不要做画面翻译，不要评价，不要建议。',
  '',
  '只输出一个 JSON 对象（不要 markdown 代码块、不要前后解释），字段如下：',
  '{',
  '  "game": "这是哪款游戏；认不出就写「未知（特征：…）」；看不出是游戏就写「非游戏界面」",',
  '  "scene": "当前场景/界面：战斗中、背包、地图、对话剧情、结算、主菜单、加载中……",',
  '  "state": "玩家状态要点（血量/蓝量/弹药/金钱/等级/装备，尽量带数字，25 字内）",',
  '  "objective": "眼前目标/任务/倒计时/还差什么（25 字内）",',
  '  "threat": "对面/敌人/危险/正在发生什么（25 字内）",',
  '  "options": "眼下可用的手段：技能/道具/背包/菜单里能做的事（25 字内）",',
  '  "notable": "值得一说的细节：连招、失误、剧情台词、装备搭配、搞笑瞬间（30 字内，没有就空字符串）"',
  '  "motion": "对比三张图后的动作判断：在跑动/移动/瞄准/开火/交互/看菜单/画面几乎没变化（只写看到的变化）",',
  '  "frameDiff": "三张图之间发生的变化：位移、视角、特效、动画（没有就写「几乎无变化」）"',
  '  "action": "这一瞬间玩家/画面里正在发生的动作：开火、爆炸、击杀、大招、躲避、处决、跳跃、驾驶……（25 字内）",',
  '  "highlight": "最值得喝彩的高光/爽点：击杀、爆炸、连杀、极限操作、帅气的开火或躲避（30 字内；没有就空字符串）"',
  '}',
  '',
  '规则：',
  '  - 画面里的动作与视觉高光（爆炸/击杀/开火/连招/躲避）才是重点；HUD 上的文字和数字（弹药数、任务目标、血条、倒计时）只做背景，',
  '    不要写进 highlight，也不要让识图结论围着它们转。',
  '  - 每个字段只写一句，没有信息就写空字符串。',
  '- 全是中文。不要描述美术风格、界面布局、画面里长什么样。',
  '- 不确定的一律写不确定，不要编。',
  '- **绝对不要因为三张图看起来差不多就说「主人站着不动/没操作」**：截图间隔很短，跑动时画面变化也可能很小。',
  '  画面没变化就写「几乎无变化」，动作判断写「看不出移动状态」，让出话那步不要断言。',
].join('\n');

/** 识图提示词：看动漫/剧。 */
export const VISION_PROMPT_WATCHING = [
  '你在看电脑屏幕截图（最多 3 张，按时间先后，是主人正在看动漫/剧/电影时的画面）。',
  '只提取「跟看剧有关」的信息，不要做画面翻译，不要评价，不要建议。',
  '',
  '只输出一个 JSON 对象（不要 markdown 代码块、不要前后解释），字段如下：',
  '{',
  '  "game": "这是哪部作品（能认出来就写名字；认不出写「未知（特征：…）」；看不出是视频就写「非视频界面」）",',
  '  "scene": "当前画面/剧情节点：对话中、打斗、回忆、片头、片尾、字幕、暂停……",',
  '  "state": "画面里正在发生什么：人物在做什么、在说什么（25 字内）",',
  '  "objective": "当前故事进展/矛盾（25 字内，没有就空字符串）",',
  '  "threat": "紧张点/冲突/谁要倒霉了（25 字内，没有就空字符串）",',
  '  "options": "空字符串即可",',
  '  "notable": "值得吐槽或讨论的细节：表情、台词、作画、演出、人物关系（30 字内，没有就空字符串）"',
  '}',
  '',
  '规则：',
  '- 每个字段只写一句，没有信息就写空字符串。',
  '- 全是中文。不要描述画面构图、不要复述大段台词。',
  '- 不确定的一律写不确定，不要编。',
].join('\n');

/** 识图提示词：写代码/做文件。 */
export const VISION_PROMPT_CODING = [
  '你在看电脑屏幕截图（最多 3 张，按时间先后，是主人写代码/做文件时的桌面）。',
  '只提取「跟当前工作有关」的信息，不要做画面翻译，不要念代码。',
  '',
  '只输出一个 JSON 对象（不要 markdown 代码块、不要前后解释），字段如下：',
  '{',
  '  "game": "这是什么项目/任务（从窗口标题、文件、终端判断；不确定写「未知项目」）",',
  '  "scene": "现在在用哪个工具做什么：编辑器、终端、浏览器、设计工具、调试、测试……",',
  '  "state": "正在处理什么：文件/语言/模块/命令（25 字内，别抄代码）",',
  '  "objective": "当前目标/待办（25 字内）",',
  '  "threat": "看到的报错/警告/失败测试/可疑写法（25 字内，没有就空字符串）",',
  '  "options": "可用手段：命令、依赖、工具（25 字内，没有就空字符串）",',
  '  "notable": "值得一说的细节：明显的 bug、拼写错误、重复代码、有趣的命名（30 字内，没有就空字符串）"',
  '}',
  '',
  '规则：',
  '- 每个字段只写一句，没有信息就写空字符串。',
  '- 全是中文。不要抄代码原文，不要描述画面布局。',
  '- 不确定的一律写不确定，不要编。',
].join('\n');

/** 识图提示词：其它桌面场景（用户关掉了「只在陪伴场景里工作」时才会用到）。 */
export const VISION_PROMPT_OTHER = [
  '你在看电脑屏幕截图（最多 3 张，按时间先后）。',
  '只提取「主人在干什么」的简短信息，不要做画面翻译，不要评价，不要建议。',
  '只输出一个 JSON 对象：{"game":"在做什么（如浏览网页、看视频、写文档、聊天）","scene":"具体界面","state":"25 字内","objective":"","threat":"","options":"","notable":"值得一说的细节，30 字内"}',
  '规则：每个字段一句中文，没有就空字符串；不要念屏幕。',
].join('\n');

export function visionPromptFor(kind) {
  if (kind === 'watching') return VISION_PROMPT_WATCHING;
  if (kind === 'coding') return VISION_PROMPT_CODING;
  if (kind === 'other') return VISION_PROMPT_OTHER;
  return VISION_PROMPT;
}

/** 历史记录 → 文本（供出话那步参考）。 */
export function formatHistory(entries, now, windowSec) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const cutoff = now - windowSec * 1000;
  const recent = entries.filter((entry) => entry.at >= cutoff).slice(-16);
  if (recent.length === 0) return '';
  const ago = (at) => {
    const seconds = Math.max(0, Math.round((now - at) / 1000));
    if (seconds < 5) return '刚刚';
    if (seconds < 60) return `${seconds} 秒前`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
    return `${Math.round(seconds / 3600)} 小时前`;
  };
  return recent
    .map((entry) => {
      const who = entry.role === 'user' ? '主人' : '你';
      const text = String(entry.text ?? '').replace(/\s+/g, ' ').slice(0, 90);
      const emotion = entry.emotion && entry.emotion !== 'neutral' ? `（${entry.emotion}）` : '';
      return `- ${who}${emotion}：${text}（${ago(entry.at)}）`;
    })
    .join('\n');
}

/** 各场景的「怎么说」规则。 */
function sceneTalkRules(kind, cheerMode, config) {
  if (kind === 'watching') {
    return [
      '【怎么说】',
      '- 你是和主人一起看的人，可以猜人物心思、吐槽剧情和演出、评价作画/配音、聊刚发生的事；',
      '- **严禁剧透**：只能基于画面里已经发生的内容说话，不许提还没演到的剧情，也不要假装你看过原作；',
      '- 像一起看的人小声嘀咕，别像解说员。',
    ];
  }
  if (kind === 'coding') {
    return [
      '【怎么说】',
      '- 你是陪主人写代码/做文件的搭子，可以吐槽、鼓励、提醒你注意到的报错和可疑写法，也可以给一句很短的思路；',
      '- 不要长篇说教、不要抢活；**绝对不要念代码或命令的原文**（念出来很难听）；',
      '- 像坐在旁边的同事随口一句，别当审查官。',
    ];
  }
  if (kind === 'other') {
    return [
      '【怎么说】',
      '- 你不是监工，看到主人在干什么就随口聊一句，别显得在监视；',
      '- 主人明显在忙正事时，语气放轻一点。',
    ];
  }
  if (cheerMode) {
    return resolvePromptBlock(config, 'cheer').split('\n');
  }
  return [
    '【怎么说】',
    '- 结合这款游戏具体的玩法/机制/局势说话；换成别的游戏也成立的空话（「小心点」「注意安全」「加油」）不要说；',
    '- **不要仅凭静态截图判断主人在不在动**：键鼠活跃度显示最近几秒有输入 = 主人正在操作；',
    '  帧间变化小也可能是在跑动/转视角，不许说「站着不动」「挂机」「没操作」这类话；没把握就聊画面里实实在在的东西。',
  ];
}

/**
 * 出话提示词（第二步）。
 * @param {object} input
 */
export function buildTalkPrompt({
  kind = 'game',
  game,
  windowTitle,
  playingForSec,
  vision,
  worldbookText,
  activity,
  sinceLastSec,
  cheerMode = false,
  config,
  historyText,
  summaryText,
  windowSec,
  genre,
  isReply,
  userMessage,
  replyContext,
  cast,
}) {
  const lines = [];
  if (isReply) {
    lines.push('主人开口跟你说话了。结合你们刚才聊的内容和屏幕上正在发生的事，自然接话。');
  } else if (Array.isArray(cast) && cast.length > 0) {
    lines.push('你刚看了一眼主人现在的屏幕。这一轮由剧团里的几位角色一起接话，像真的坐在一起看屏幕。');
  } else {
    lines.push('你刚看了一眼主人现在的屏幕。现在说一句你此刻想说的话。');
  }
  lines.push('');
  const sceneNames = { game: '正在玩', watching: '正在看', coding: '正在做', other: '正在看' };
  lines.push(`【${sceneNames[kind] ?? '正在看'}】${game || windowTitle || '未知'}`);
  if (windowTitle && windowTitle !== game) lines.push(`【窗口】${windowTitle}`);
  if (playingForSec > 0) lines.push(`【已经陪了】约 ${Math.round(playingForSec / 60)} 分钟`);
  if (activity) {
    lines.push('');
    const idle = Number(activity.idleSec) || 0;
    lines.push(`【键鼠活跃度】最近一次键盘/鼠标输入在 ${idle} 秒前${idle <= 3 ? '（正在操作）' : idle <= 15 ? '（刚操作过）' : '（可能真的闲了一会儿）'}`);
    if (activity.framesIdentical) {
      lines.push('【帧间差异】三张截图几乎一样（可能是跑动中画面变化小，也可能是截图没更新）——不要据此断定主人站着不动。');
    } else if (activity.frameDiff) {
      lines.push(`【帧间差异】${activity.frameDiff}`);
    }
  }
  lines.push('');
  if (sinceLastSec != null) {
    lines.push(`【观察节奏】距离上次观察：${sinceLastSec} 秒前。`);
    lines.push('你看到的永远是「这一瞬间」的静态截图，不是连续视频。上一轮看到的爆炸、击杀、喊话、动作可能早就结束了，');
    lines.push('不要把它当成现在还在发生的事；也不要重复你上一轮说过的事/台词，除非这一轮画面里它又出现了。');
    if (genre === 'short') {
      lines.push('这是快节奏游戏：超过 15 秒的画面信息基本是旧闻，只聊眼前三张图里正在发生的。');
    } else if (sinceLastSec > 60) {
      lines.push(`已经过去 ${sinceLastSec} 秒了，别翻旧账，只聊现在。`);
    }
  } else {
    lines.push('【观察节奏】这是本次陪伴的第一次观察。');
  }
  if (vision) {
    lines.push('');
    lines.push('【你从屏幕里看出的情况】');
    const labels = kind === 'coding'
      ? [['game', '项目/任务'], ['scene', '在用'], ['state', '正在处理'], ['objective', '目标'], ['threat', '报错/风险'], ['options', '可用手段'], ['notable', '值得说的细节']]
      : kind === 'watching'
        ? [['game', '作品'], ['scene', '画面/剧情节点'], ['state', '正在发生'], ['objective', '故事进展'], ['threat', '冲突/紧张点'], ['notable', '值得说的细节']]
        : [['game', '游戏'], ['scene', '场景'], ['highlight', '高光/爽点'], ['action', '正在发生的动作'], ['motion', '动作判断'], ['frameDiff', '帧间变化'], ['notable', '值得一说的细节'], ['threat', '对面/危险'], ['state', '背景：玩家状态（数字类，别主动提）'], ['objective', '背景：任务目标（文字类，别主动提）'], ['options', '背景：可用手段']];
    for (const [key, label] of labels) {
      const value = String(vision[key] ?? '').trim();
      if (value) lines.push(`- ${label}：${value}`);
    }
    lines.push('（以上只是线索，不要念给主人听，主人看得见屏幕。）');
  }
  if (worldbookText) {
    lines.push('');
    lines.push('【世界书资料】（帮助你理解这款游戏，避免说错；资料可能不全，不确定就不要当事实）');
    lines.push(worldbookText);
  }
  if (summaryText) {
    lines.push('');
    lines.push('【之前聊过的前情提要】');
    lines.push(summaryText);
  }
  if (historyText) {
    lines.push('');
    lines.push(`【你们最近说过的话】（只看最近约 ${Math.round(windowSec / 60) || 1} 分钟，别把很久以前的事套到现在）`);
    lines.push(historyText);
  }
  if (kind === 'game') {
    if (genre === 'short') {
      lines.push('');
      lines.push('【注意】这是动作/竞技/射击类游戏，局势变化很快：只针对**眼前这一下**说话，不要翻旧账。');
    } else if (genre === 'long') {
      lines.push('');
      lines.push('【注意】这是剧情/策略类游戏，可以回顾前面做过的事、聊剧情和长期打算。');
    }
  }
  if (isReply && userMessage) {
    lines.push('');
    lines.push(`【主人刚说】${userMessage}`);
  }
  if (replyContext) {
    lines.push('');
    lines.push('【补充上下文】');
    lines.push(replyContext);
  }
  lines.push('');
  lines.push(...sceneTalkRules(kind, cheerMode, config));
  lines.push('');
  if (Array.isArray(cast) && cast.length > 0) {
    lines.push('【剧团输出格式（严格）】');
    lines.push('只输出一个 JSON 对象，不要 markdown 代码块，不要解释，不要前后缀：');
    lines.push('{"lines":[{"role":"r1","emotion":"开心","text":"..."}]}');
    lines.push(`本轮开口角色（按此顺序）：${cast.map((role) => `${role.id}（${role.name}）`).join(' → ')}`);
    lines.push(`规则：`);
    lines.push(`- 只让上面这些角色开口，每个角色各说 1 句，共 ${cast.length} 句；不要加入未列出的角色。`);
    lines.push('- 每条台词 8～40 个汉字，能直接照着读；不要写角色名、括号动作、表情符号、markdown。');
    lines.push('- 按上面列出的顺序排列；后一个角色可以回应前一个角色，但不要复述同一句。');
    lines.push('- role 必须用上面的角色 id（r1/r2/r3），不要写名字。');
    lines.push('- emotion 从：开心 / 兴奋 / 吐槽 / 认真 / 温柔 / 惊讶 / 坏笑 / 无奈 / 平静 里选一个。');
    lines.push('- 角色之间要有区别：不要让所有人用同一种语气，也不要所有人都夸同一个点。');
  } else {
    lines.push('【输出格式（严格）】');
    lines.push('第一行只写情绪标签，从下面选一个（原样用中文；当前是温柔风格的话，优先用 温柔/开心/认真/惊讶/无奈/平静，吐槽和坏笑只能是善意玩笑）：');
    lines.push('  【情绪：开心】【情绪：兴奋】【情绪：吐槽】【情绪：认真】【情绪：温柔】【情绪：惊讶】【情绪：坏笑】【情绪：无奈】【情绪：平静】');
    lines.push('第二行写你要说的那一两句台词。不要输出其它任何东西。');
    lines.push('');
    lines.push('自检：① 是不是在念屏幕？是就重写。② 换成别的场景还成立吗？成立就重写（太笼统）。');
    lines.push('③ 能直接读出来吗（没有表情符号/括号动作/markdown/引号）？不能就重写。④ 是不是太长？压到 60 字以内。');
    lines.push('⑤ 这句话里有没有一个「只属于当前屏幕」的具体信息（名字/数字/动作/台词）？没有就是废话，重写。');
    lines.push('⑥ 把这句话搬到别的游戏/别的剧里还成立吗？成立就是废话，重写。');
    lines.push('⑦ 是不是又在提问？观察型台词尽量别用问句，改成陈述句/感叹句；反问和追问收尾也不行。');
  }
  return lines.join('\n');
}

/** 用户打字回复时，如果还有上一轮画面信息，附一句上下文。 */
export function describeLastVision(entry) {
  if (!entry?.vision) return '';
  const fields = [
    ['scene', '场景'],
    ['state', '状态'],
    ['objective', '目标'],
    ['threat', '异常'],
  ];
  const parts = fields
    .map(([key, label]) => (entry.vision[key] ? `${label}：${entry.vision[key]}` : ''))
    .filter(Boolean);
  return parts.length > 0 ? `刚才的画面：${parts.join('；')}` : '';
}

/** 开新对话时让模型总结前情的提示词。 */
export function buildSummaryPrompt(historyText, kind) {
  const scene = kind === 'watching' ? '看剧' : kind === 'coding' ? '写代码' : '玩游戏';
  return [
    `下面是你陪主人${scene}时最近聊过的内容。请把它压缩成一句「前情提要」，用于新一段对话开始时提醒你自己：`,
    '- 只写 1 句，40 个汉字以内；',
    '- 保留：主人玩/看/做的是什么、你们聊到哪了、主人的偏好或情绪；',
    '- 不要写「我」开头，不要加引号/标题/解释；',
    '- 如果没什么值得记的，输出「（无）」。',
    '',
    '聊天记录：',
    historyText,
  ].join('\n');
}
