// llm.mjs —— 模型调用层：模型选择、带图请求、流式取文、输出消毒、附件清理。
//
// 所有模型调用都走 DSH 的 ctx.llm（与对话页同一套服务商/凭据/路由），
// 不自己读 API Key、不自己拼服务商端点。
//
// 凭经验抄来的三条硬规矩（别改回去）：
//   1) 不要把 ImageBlock 塞给"自动识图包装"模型，否则模型会把工具调用标记当正文吐出来。
//      这里识图只选「声明支持 image 输入」的真实多模态模型。
//   2) 图像只能出现在 user 消息里（生产适配器的约束）。
//   3) 附件服务不可用时识图直接失败——宁可报错，也不把空图发给模型。
import { createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { errorText, memoizeAsync } from './util.mjs';

const CALL_IDENTITY = 'dsh-companion';

/** 从 llm 服务里安全地列 provider（兼容 string[] 与 {id,name}[] 两种形状）。 */
export async function listProviders(llm) {
  try {
    if (typeof llm?.listProviders !== 'function') return [];
    const raw = llm.listProviders();
    const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
    return list
      .map((item) => {
        if (typeof item === 'string') return { id: item, name: item };
        if (item && typeof item === 'object') {
          const id = item.id ?? item.provider ?? item.name;
          if (typeof id === 'string' && id) return { id, name: String(item.name ?? id) };
        }
        return null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 某个 provider 的模型清单（失败 → []）。 */
export async function listModels(llm, provider) {
  try {
    if (typeof llm?.listModels !== 'function') return [];
    const raw = await llm.listModels(provider);
    const list = Array.isArray(raw) ? raw : [];
    return list
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const id = item.id ?? item.model ?? item.name;
        if (typeof id !== 'string' || !id) return null;
        const modalities = Array.isArray(item.inputModalities)
          ? item.inputModalities.map((m) => String(m))
          : Array.isArray(item.modalities)
            ? item.modalities.map((m) => String(m))
            : [];
        return {
          id,
          name: String(item.name ?? id),
          description: typeof item.description === 'string' ? item.description : '',
          supportsImage: modalities.some((m) => m.toLowerCase().includes('image')),
          modalities,
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function modalitiesOf(llm, provider, model) {
  const cacheKey = `${provider}/${model}`;
  return memoizeAsync(async () => {
    try {
      const models = await listModels(llm, provider);
      const hit = models.find((item) => item.id === model);
      return hit ?? null;
    } catch {
      return null;
    }
  }, 60000)();
}

/**
 * 选模型：vision（要能看图）与 talk（出话）分开。
 * 规则：配置优先 → 当前对话模型（若支持图）→ 注册表里声明支持图的模型 → 当前对话模型（硬着头皮试）。
 */
export async function resolveTargets(ctx, config) {
  const llm = ctx.llm;
  const providers = await listProviders(llm);
  const current = (() => {
    try {
      const selection = ctx.agentDefaultModel?.currentSelection?.();
      if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        return { provider: selection.provider, model: selection.model };
      }
    } catch {
      // ignore
    }
    return null;
  })();

  const catalog = [];
  for (const provider of providers) {
    const models = await listModels(llm, provider.id);
    for (const model of models) catalog.push({ provider: provider.id, providerName: provider.name, ...model });
  }

  const configured = (value) =>
    value && typeof value.provider === 'string' && value.provider.trim() && typeof value.model === 'string' && value.model.trim()
      ? { provider: value.provider.trim(), model: value.model.trim() }
      : null;

  const vision = (() => {
    const forced = configured(config.vision);
    if (forced) return { ...forced, source: 'config' };
    const currentEntry = current ? catalog.find((item) => item.provider === current.provider && item.id === current.model) : null;
    if (currentEntry?.supportsImage) return { provider: current.provider, model: current.model, source: 'current' };
    const imageEntry = catalog.find((item) => item.supportsImage);
    if (imageEntry) return { provider: imageEntry.provider, model: imageEntry.id, source: 'catalog' };
    if (current) return { ...current, source: 'current-unsure' };
    return null;
  })();

  const talk = (() => {
    const forced = configured(config.talk);
    if (forced) return { ...forced, source: 'config' };
    if (current) return { ...current, source: 'current' };
    const first = catalog[0];
    if (first) return { provider: first.provider, model: first.id, source: 'catalog' };
    return null;
  })();

  return {
    vision,
    talk,
    report: {
      providers: providers.map((provider) => provider.id),
      current,
      imageModels: catalog.filter((item) => item.supportsImage).map((item) => `${item.provider}/${item.id}`),
      totalModels: catalog.length,
      catalog: catalog.slice(0, 200),
    },
  };
}

/** 给面板用的模型目录（含每个模型的图片能力）。 */
export async function modelCatalog(ctx) {
  const llm = ctx.llm;
  const providers = await listProviders(llm);
  const rows = [];
  for (const provider of providers) {
    const models = await listModels(llm, provider.id);
    rows.push({ provider: provider.id, name: provider.name, models });
  }
  let current = null;
  try {
    const selection = ctx.agentDefaultModel?.currentSelection?.();
    if (selection) current = { provider: selection.provider, model: selection.model };
  } catch {
    // ignore
  }
  return { providers: rows, current };
}

/** 把截图存成 DSH 附件，返回 {refs, cleanup}。附件服务缺失 → 抛错（识图无法进行）。 */
export async function saveImages(ctx, images) {
  const attachments = typeof ctx.get === 'function' ? ctx.get('attachments', false) : undefined;
  if (!attachments || typeof attachments.saveImage !== 'function') {
    throw new Error('附件服务不可用：无法把截图交给模型（ctx.attachments 缺失）');
  }
  const startedAt = Date.now();
  const refs = [];
  const cleanupPaths = [];
  for (const [index, image] of images.entries()) {
    const ref = await attachments.saveImage({
      data: image.data,
      mediaType: 'image/jpeg',
      name: `companion-${Date.now()}-${index}.jpg`,
    });
    refs.push(ref);
    try {
      const hostPath = typeof attachments.imageHostPath === 'function' ? attachments.imageHostPath(ref) : undefined;
      if (hostPath) cleanupPaths.push({ path: hostPath, ref });
    } catch {
      // ignore
    }
  }
  // 清理：删掉本次自己刚写进去的附件对象（内容寻址，删文件不会影响其它引用；
  // 但为了不误删别的会话刚存的同一张图，只删 mtime 在本次调用之后的文件）
  const cleanup = async () => {
    for (const item of cleanupPaths) {
      try {
        const stat = await import('node:fs/promises').then((fs) => fs.stat(item.path));
        if (stat.mtimeMs >= startedAt - 2000) await unlink(item.path);
      } catch {
        // ignore
      }
    }
  };
  return { refs, cleanup };
}

/**
 * 调用模型（流式）。
 * @returns {Promise<{ok:boolean, text?:string, usage?:object, finish?:object, message?:string}>}
 */
export async function streamText(ctx, { provider, model, content, system, maxTokens, temperature, timeoutMs, tools, reasoningEffort, signal }) {
  const llm = ctx.llm;
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, message: 'LLM 服务不可用（ctx.llm.stream 缺失）' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`模型调用超时（${timeoutMs ?? 90000}ms）`)), timeoutMs ?? 90000);
  // 外部取消（暂停/卸载时中止正在进行的模型调用）
  const onExternalAbort = () => controller.abort(signal?.reason ?? new Error('模型调用已取消'));
  if (signal) {
    if (signal.aborted) onExternalAbort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const options = {
    provider,
    model,
    sessionId: CALL_IDENTITY,
    messages: [{ role: 'user', content }],
    system,
    temperature: temperature ?? 1,
    signal: controller.signal,
    ...(maxTokens ? { maxTokens } : {}),
    ...(Array.isArray(tools) && tools.length > 0 ? { tools } : {}),
    ...(reasoningEffort && reasoningEffort !== 'auto' ? { reasoningEffort } : {}),
  };

  // 简单可靠的流式拼装：文本按 index 累积；block-end 提供兜底正文；usage 记账。
  const textByIndex = new Map();
  const sawDelta = new Set();
  let usage = null;
  let finish = null;
  try {
    for await (const chunk of llm.stream(options)) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        const index = Number(chunk.index) || 0;
        textByIndex.set(index, (textByIndex.get(index) ?? '') + chunk.text);
        sawDelta.add(index);
      } else if (chunk.type === 'block-end' && chunk.block) {
        const index = Number(chunk.index) || 0;
        const block = chunk.block;
        if (block.type === 'text' && typeof block.text === 'string' && !sawDelta.has(index)) {
          textByIndex.set(index, block.text);
        }
      } else if (chunk.type === 'usage' && chunk.usage) {
        usage = chunk.usage;
      } else if (chunk.type === 'finish') {
        finish = chunk.reason ?? null;
      }
    }
  } catch (error) {
    const aborted = controller.signal.aborted;
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
    return {
      ok: false,
      message: aborted ? `模型调用超时或被中断：${errorText(error)}` : errorText(error),
      aborted,
      cancelled: Boolean(signal?.aborted),
      usage: usage ?? undefined,
    };
  }
  clearTimeout(timer);
  if (signal) signal.removeEventListener('abort', onExternalAbort);

  const text = [...textByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, value]) => value)
    .join('')
    .trim();

  if (!text) {
    const kind = finish?.kind;
    if (kind === 'error') return { ok: false, message: `生成失败：${finish.failure?.message ?? '未知错误'}`, finish, usage };
    if (kind === 'aborted') return { ok: false, message: `生成中断：${finish.failure?.message ?? '未知原因'}`, finish, usage };
    if (kind === 'max-tokens') return { ok: false, message: '输出达到上限（max-tokens），没有留下正文', finish, usage };
    return { ok: false, message: '模型没有返回文本', finish, usage };
  }
  return { ok: true, text, usage, finish };
}

/** 把多个模型返回的识图 JSON 解析出来（容忍 markdown 代码块、前后废话）。 */
export function parseVisionJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const fenced = raw.replace(/```(?:json)?/gi, '').trim();
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(fenced.slice(start, end + 1));
      if (parsed && typeof parsed === 'object') {
        const pick = (key) => (typeof parsed[key] === 'string' ? parsed[key].trim().slice(0, 200) : '');
        const result = {
          game: pick('game'),
          scene: pick('scene'),
          state: pick('state'),
          objective: pick('objective'),
          threat: pick('threat'),
          options: pick('options'),
          notable: pick('notable'),
          motion: pick('motion'),
          frameDiff: pick('frameDiff'),
          action: pick('action'),
          highlight: pick('highlight'),
        };
        if (Object.values(result).some(Boolean)) return result;
      }
    } catch {
      // 落到纯文本
    }
  }
  return null;
}

/**
 * 从文本里抠出第一个完整的 JSON 对象（容忍 markdown 代码块、前后废话、字符串里的括号）。
 * 与 parseVisionJson 不同：不做字段裁剪，返回模型给的原始对象。
 */
export function extractJsonObject(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const fenced = raw.replace(/```(?:json)?/gi, '').trim();
  const start = fenced.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < fenced.length; index += 1) {
    const char = fenced[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === String.fromCharCode(92)) escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(fenced.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 识图输出的兜底消毒（不是 JSON 就把明显没用的行删掉）。 */
export function sanitizeVisionText(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s>*#\-+]+/, '').trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return '';
  return lines.slice(0, 8).join('\n').slice(0, 1200);
}

/**
 * 检测「放到任何场景都成立的陪聊空话」。命中则要求模型重写，避免 AI 助手腔。
 * 只做高置信度匹配：宁可漏，不要误杀正常台词。
 */
const FILLER_PATTERNS = [
  /我(会|一直|就)?(在这儿|在这里|在这)?(陪|伴)着?你/,
  /(需要|有事|想聊|要说话)?(就|随时|可以|记得)(喊|叫|找|戳|说|联系)我/,
  /随时(喊|叫|找|戳)我/,
  /我(会)?一直都在/,
  /一直在你(身边|这儿|这里)/,
  /慢慢来(就好)?/,
  /(^|[，。！？\s])加油(哦|鸭|呀|吧)?([，。！？\s]|$)/,
  /注意安全/,
  /(别|不要)急[，,]?\s*慢慢/,
  /有(什么|啥)(事|需要|问题)[^，。！？]{0,8}(找|喊|叫)我/,
  /我一直(都)?在(这儿|这里|你身边)/,
  /累了就休息/,
  /先(歇|休息)(一会儿|一下)(吧|哦)?[。！]?$/,
];

/**
 * 检测「仅凭静态截图就断言主人在站着不动/挂机」的话。
 * 只有在键鼠活跃度显示最近 5 秒内还有操作时才算误判；否则不拦。
 */
const STILLNESS_PATTERNS = [
  /站着?(不动|没动|发呆|挂机|发愣)/,
  /站(那|在|着)(儿|那|这儿)?(不|没)?(动|干|看|等)/,
  /别(站|杵|愣|发)着?/,
  /(怎么|你)(还|又)?(站着|杵着)/,
  /原地(不动|发呆|站着)/,
  /挂机/,
  /手(是不是)?(离开|没在)/,
  /不动(弹|了)?/,
];

export function isGroundlessStillness(text, idleSec) {
  const value = String(text ?? '').trim();
  const idle = Number(idleSec);
  if (!value || !Number.isFinite(idle) || idle > 5) return false;
  return STILLNESS_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * 「说教味」检测：命令式提醒/指导。喝彩模式下命中会要求重写（不是直接禁）。
 */
const NAG_PATTERNS = [
  /先(按|把|去|换|装|补|躲|撤|扔|丢)/,
  /你(应该|该|得|必须|需要)/,
  /别(再)?(站|冲|往|硬|浪|贪|急)/,
  /(赶紧|快去|快点|马上)(去)?/,
  /(建议|最好|记得|不要).{0,6}(用|换|打|跑|撤)/,
];

export function isNagging(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  return NAG_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * 「揪着 HUD 文字/数字不放」检测：弹药、任务目标、倒计时等。
 * 只在画面里真的有动作/高光时才用它触发重写（避免把救命提醒也误杀）。
 */
const HUD_FOCUS_PATTERNS = [
  /弹药|子弹|弹匣|还剩\s*\d+\s*发|几发|装弹/,
  /任务目标|目标点|目标区域|倒计时|剩余时间/,
  /血条|血量|生命值|护甲值/,
  /得分|分数|击杀数|K\/D/i,
];

export function mentionsHudFocus(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  return HUD_FOCUS_PATTERNS.some((pattern) => pattern.test(value));
}

export function isGenericFiller(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  return FILLER_PATTERNS.some((pattern) => pattern.test(value));
}

/** 从一段文本里抠出 {"say":"..."} / {"text":"..."} 这类外壳里的正文。 */
function extractJsonSay(text) {
  const source = String(text ?? '');
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(source.slice(start, end + 1));
    if (parsed && typeof parsed === 'object') {
      const value = parsed.say ?? parsed.text ?? parsed.content ?? parsed.message ?? parsed.reply;
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  } catch {
    // 不是完整 JSON，继续
  }
  return null;
}

/**
 * 扒掉模型偶发漏出来的工具调用 / JSON 外壳 / markdown。
 * 顺序很重要：先从（可能被代码围栏包着的）JSON 里取正文，再清工具标记，最后去围栏——
 * 反过来会先把 JSON 连同围栏一起删掉，剩个空串。
 */
export function stripModelNoise(input) {
  let text = String(input ?? '').trim();
  if (!text) return '';

  // 1) JSON 外壳（fence 里的也算）：这是最常见的「话说对了但包了一层」
  const unfenced = text.replace(/```(?:json)?/gi, '').trim();
  const jsonSay = extractJsonSay(unfenced);
  if (jsonSay !== null) return jsonSay;

  // 2) 工具调用标记（全角竖线是 DSML 特征）
  const hasToolMarkup =
    /[｜|]{2,}/.test(text) ||
    /<\/?[^<>\n]{0,60}(invoke|parameter|tool_calls?|function_calls?|antml:|DSML)[^<>\n]{0,60}>/i.test(text);
  if (hasToolMarkup) {
    text = text
      .replace(/<[^<>\n]{0,200}(invoke|parameter|tool_calls?|function_calls?|DSML)[^<>\n]{0,200}>/gi, ' ')
      .replace(/<\/[^<>\n]{0,200}>/gi, ' ')
      .replace(/[｜|]{2,}/g, ' ')
      .replace(/\b(invoke|parameter|tool_calls?|function_calls?)\b/gi, ' ')
      .trim();
    if (!/\S/.test(text)) return '';
  }

  // 3) 整段就是一个代码围栏：模型在吐代码/标记，没有可朗读内容
  if (/^```[\s\S]*```$/.test(text)) return '';

  // 4) 零散围栏与行内代码
  text = text.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]{0,300})`/g, '$1');
  return text;
}

/**
 * 台词消毒：只留能朗读的自然语言。
 * 去 markdown、括号舞台提示、引号、表情符号、多余的换行。
 */
export function sanitizeSpeech(input) {
  let text = stripModelNoise(input);
  if (!text) return '';
  // 括号里的动作/表情（（笑）、[叹气]、(sighs)）→ 去掉
  text = text.replace(/（[^（）]{0,40}）/g, ' ').replace(/\([^()]{0,40}\)/g, ' ');
  text = text.replace(/【[^【】]{0,40}】/g, ' ').replace(/\[[^\[\]]{0,40}\]/g, ' ');
  // markdown 标题/加粗/斜体/列表
  text = text.replace(/^#+\s*/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*\n]+)\*/g, '$1');
  text = text.replace(/^\s*[-*+]\s+/gm, '').replace(/^\s*\d+[.、)]\s*/gm, '');
  text = text.replace(/[>_~`|]/g, ' ');
  // emoji / 变体选择符 / 零宽字符
  text = text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '');
  // 引号
  text = text.replace(/^[\s"'“”「」『』]+|[\s"'“”「」『』]+$/g, '');
  // 折行合并成一段
  text = text.replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return text;
}

/** 支持的情绪标签（与 voice-service 的 emotion 参数一致）。 */
export const EMOTIONS = ['neutral', 'happy', 'excited', 'tsukkomi', 'serious', 'gentle', 'surprised', 'smug', 'sigh'];

const EMOTION_ALIASES = {
  平静: 'neutral', 正常: 'neutral', 普通: 'neutral',
  开心: 'happy', 高兴: 'happy', 愉快: 'happy', 乐: 'happy',
  兴奋: 'excited', 激动: 'excited', 上头: 'excited',
  吐槽: 'tsukkomi', 嫌弃: 'tsukkomi', 无语: 'tsukkomi', 调侃: 'tsukkomi',
  认真: 'serious', 严肃: 'serious', 提醒: 'serious', 分析: 'serious',
  温柔: 'gentle', 安慰: 'gentle', 轻声: 'gentle', 关心: 'gentle',
  惊讶: 'surprised', 震惊: 'surprised', 意外: 'surprised',
  坏笑: 'smug', 得意: 'smug', 腹黑: 'smug', 阴阳: 'smug',
  无奈: 'sigh', 叹气: 'sigh', 摆烂: 'sigh', 失落: 'sigh',
};

function normalizeEmotion(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return 'neutral';
  if (EMOTIONS.includes(value)) return value;
  for (const [cn, en] of Object.entries(EMOTION_ALIASES)) {
    if (value.includes(cn) || cn.includes(value)) return en;
  }
  return 'neutral';
}

export { normalizeEmotion };

const EMOTION_TAG = /^\s*[【\[]\s*情绪\s*[:：]\s*([^】\]\n]{1,16}?)\s*[】\]]\s*(.*)$/s;

/**
 * 从模型输出里拆出情绪标签与台词。
 * 兼容两种格式：标签单独一行 / 标签和台词在同一行；没有标签就当 neutral。
 * @returns {{text: string, emotion: string}}
 */
export function splitEmotion(raw) {
  const original = String(raw ?? '');
  const trimmed = original.replace(/^\s+/, '');
  const lines = trimmed.split(/\r?\n/);
  if (lines.length >= 2) {
    const match = EMOTION_TAG.exec(lines[0]);
    if (match) {
      const rest = [match[2].trim(), ...lines.slice(1)].filter((line) => line.length > 0).join('\n');
      return { text: rest.trim(), emotion: normalizeEmotion(match[1]) };
    }
  }
  const sameLine = EMOTION_TAG.exec(trimmed);
  if (sameLine && sameLine[2].trim()) {
    return { text: sameLine[2].trim(), emotion: normalizeEmotion(sameLine[1]) };
  }
  // 兜底：全文搜一次标签并剥掉
  const inline = /[【\[]\s*情绪\s*[:：]\s*([^】\]\n]{1,16}?)\s*[】\]]/.exec(trimmed);
  if (inline) {
    return {
      text: trimmed.slice(0, inline.index) + trimmed.slice(inline.index + inline[0].length),
      emotion: normalizeEmotion(inline[1]),
    };
  }
  return { text: trimmed, emotion: 'neutral' };
}

/** 从文本里抠出第一个完整的 JSON 数组（容忍代码围栏和前后废话）。 */
function extractJsonArray(text) {
  const raw = String(text ?? '').trim();
  const fenced = raw.replace(/```(?:json)?/gi, '').trim();
  const start = fenced.indexOf('[');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < fenced.length; index += 1) {
    const char = fenced[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === String.fromCharCode(92)) escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(fenced.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function matchCastRole(value, roles) {
  const key = String(value ?? '').trim().toLowerCase();
  if (!key) return null;
  return roles.find((role) => {
    const id = String(role?.id ?? '').trim().toLowerCase();
    const name = String(role?.name ?? '').trim().toLowerCase();
    return (id && id === key) || (name && name === key);
  }) ?? null;
}

function cleanCastLine(value, role) {
  let text = sanitizeSpeech(String(value ?? '').trim());
  if (!text) return '';
  const prefix = `${role?.name ?? ''}：`;
  if (role?.name && text.startsWith(prefix)) text = text.slice(prefix.length).trim();
  return text.replace(/\s+/g, ' ').slice(0, 120);
}

/**
 * 解析「一人分饰多角」剧本。优先解析严格 JSON：
 *   {"lines":[{"role":"r1","emotion":"开心","text":"..."}]}
 * 也兼容对象按角色 id/名字映射、以及逐行「角色名：台词」的兜底格式。
 * 返回的 lines 已消毒，每个角色最多一条，按模型给的顺序排列。
 */
export function parseCastScript(raw, roles) {
  const list = Array.isArray(roles) ? roles.filter((role) => role?.id) : [];
  if (list.length === 0) return { lines: [], error: '没有可用的角色' };
  const lines = [];
  const seen = new Set();

  const pushLine = (role, textValue, emotionValue) => {
    if (!role || seen.has(role.id)) return false;
    const parsed = splitEmotion(String(textValue ?? ''));
    const text = cleanCastLine(parsed.text, role);
    if (!text) return false;
    const emotion = normalizeEmotion(emotionValue ?? parsed.emotion);
    seen.add(role.id);
    lines.push({ roleId: role.id, name: role.name, emotion, text });
    return true;
  };

  const parsedObject = extractJsonObject(raw);
  if (parsedObject && typeof parsedObject === 'object') {
    let items = [];
    if (Array.isArray(parsedObject.lines)) items = parsedObject.lines;
    else if (Array.isArray(parsedObject.dialogue)) items = parsedObject.dialogue;
    else if (Array.isArray(parsedObject.script)) items = parsedObject.script;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const role = matchCastRole(item.role ?? item.id ?? item.speaker ?? item.name, list);
      if (role) pushLine(role, item.text ?? item.say ?? item.line ?? item.content, item.emotion ?? item.mood);
    }
    // 也支持 {"r1":"台词","r2":"台词"} 这种简写。
    if (lines.length === 0) {
      for (const role of list) {
        const value = parsedObject[role.id] ?? parsedObject[role.name];
        if (value != null) pushLine(role, value, null);
      }
    }
  }

  if (lines.length === 0) {
    const parsedArray = extractJsonArray(raw);
    if (Array.isArray(parsedArray)) {
      for (const item of parsedArray) {
        if (!item || typeof item !== 'object') continue;
        const role = matchCastRole(item.role ?? item.id ?? item.speaker ?? item.name, list);
        if (role) pushLine(role, item.text ?? item.say ?? item.line ?? item.content, item.emotion ?? item.mood);
      }
    }
  }

  if (lines.length === 0) {
    const rawLines = String(raw ?? '')
      .replace(/```(?:json)?/gi, '')
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*[-*+\d.、)]+\s*/, '').trim())
      .filter(Boolean);
    const unmatched = [];
    for (const rawLine of rawLines) {
      let role = null;
      let body = rawLine;
      for (const candidate of list) {
        const names = [candidate.id, candidate.name].filter(Boolean);
        const hit = names.find((name) => rawLine.toLowerCase().startsWith(`${String(name).toLowerCase()}：`)
          || rawLine.toLowerCase().startsWith(`${String(name).toLowerCase()}:`));
        if (hit) {
          role = candidate;
          body = rawLine.slice(String(hit).length + 1).trim();
          break;
        }
      }
      if (!role) {
        unmatched.push(rawLine);
        continue;
      }
      pushLine(role, body, splitEmotion(body).emotion);
    }
    // 模型没写角色名、但按顺序给了几行：按角色顺序分配（只在确实有内容时兜底）。
    if (lines.length === 0 && unmatched.length > 0) {
      for (const [index, rawLine] of unmatched.slice(0, list.length).entries()) {
        pushLine(list[index], rawLine, splitEmotion(rawLine).emotion);
      }
    }
  }

  return {
    lines: lines.slice(0, list.length),
    error: lines.length > 0 ? null : '没有解析出任何角色台词',
  };
}

/** 给日志/历史用的稳定哈希（去重用）。 */
export function textHash(text) {
  return createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 12);
}
