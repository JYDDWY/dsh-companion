// research.mjs —— 通过 DSH 的 ctx.web 搜索/抓取，给某个游戏生成一份世界书。
//
// 现实约束：
//   - ctx.web.search/fetch 由 DSH 的 web 能力提供（web_search / web_fetch 同一套 provider）。
//     不可用、没配 provider、网络失败时**不报错**，退化成「仅模型知识」并把来源标成 model；
//   - 模型知识可能过时/有误，所以资料里明确写「不确定的字段留空，不要编」，
//     生成结果里也标注来源，面板里用户可以随时手改。
import { extractJsonObject, resolveTargets, streamText } from './llm.mjs';
import { isUsableGameName, normalizeWorldbook } from './worldbook.mjs';
import { errorText } from './util.mjs';

const MAX_MATERIAL_CHARS = 16000;

/**
 * 攻略/教学贴来源优先级：贴吧、小黑盒、NGA、B 站专栏等社区里的「玩家实际怎么玩」，
 * 比通用百科更接近真实玩法（也正是用户要的「取信度」）。
 */
const GUIDE_DOMAINS = [
  'tieba.baidu.com',
  'xiaoheihe.cn',
  'heybox',
  'nga.178.com',
  'bbs.nga.cn',
  'ngabbs.com',
  'bilibili.com',
  'gamefaqs',
  'reddit.com/r/',
  'steamcommunity.com',
  'gamer.com.tw',
  'gamersky.com',
  '3dmgame.com',
  '9game.cn',
  'gamerant.com',
  'vgtime.com',
  'indienova.com',
  '17173.com',
  'duowan.com',
  'bilibili',
];

function isGuideUrl(url) {
  const value = String(url ?? '').toLowerCase();
  return GUIDE_DOMAINS.some((domain) => value.includes(domain));
}

/** 来源归类：论坛/攻略页标成 guide，方便提示词区分可信度。 */
function classifySources(sources) {
  const guides = [];
  const others = [];
  for (const source of sources) {
    if (isGuideUrl(source?.url)) guides.push(source);
    else others.push(source);
  }
  return { guides, others };
}

function stripHtml(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeSources(sources) {
  const seen = new Set();
  const result = [];
  for (const source of sources) {
    const url = String(source?.url ?? '');
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    result.push({ title: String(source?.title ?? '').slice(0, 80), url });
    if (result.length >= 8) break;
  }
  return result;
}

/**
 * 搜索并抓取资料。返回 { material, sources, searched, error }。
 * 任何一步失败都只是少一点资料，不抛错。
 */

function cancelledResearchError() {
  const error = new Error('世界书调研已取消');
  error.code = 'CANCELLED';
  return error;
}

function ensureResearchAlive(signal) {
  if (signal?.aborted) throw cancelledResearchError();
}

export async function gatherGameMaterial(ctx, gameName, log, signal = null) {
  ensureResearchAlive(signal);
  const materialParts = [];
  const sources = [];
  const errors = [];
  let searched = false;
  let fetchedCount = 0;

  // ctx.web 是 DSH 可选能力：插件没有 inject 它时不能直接读属性，
  // 用 ctx.get() 拿（拿不到就退化成「仅模型知识」）。
  let web = null;
  try {
    web = typeof ctx?.get === 'function' ? ctx.get('web') : null;
  } catch {
    web = null;
  }
  if (!web) {
    try {
      web = ctx?.web ?? null;
    } catch {
      web = null;
    }
  }
  if (web && typeof web.search === 'function') {
    const queries = [
      `${gameName} 游戏 玩法 简介`,
      `${gameName} 新手 入门 攻略`,
      `${gameName} 百度贴吧 攻略 教学`,
      `${gameName} 小黑盒 攻略 心得`,
      `site:tieba.baidu.com ${gameName} 攻略`,
      `site:xiaoheihe.cn ${gameName} 攻略`,
      `${gameName} 贴吧 开荒 攻略 怎么玩`,
      `${gameName} NGA 攻略 心得`,
      `${gameName} 小黑盒 新手 怎么玩`,
      `${gameName} 术语 机制 设定`,
    ];
    for (const query of queries) {
      ensureResearchAlive(signal);
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('搜索超时（20s）')), 20000);
        let result;
        try {
          result = await web.search({ query, maxResults: 5 }, controller.signal);
        } finally {
          clearTimeout(timer);
        }
        searched = true;
        if (result?.content) materialParts.push(`【搜索：${query}】\n${String(result.content).slice(0, 2500)}`);
        for (const source of result?.sources ?? []) {
          if (source?.snippet) materialParts.push(`【摘要】${String(source.snippet).slice(0, 500)}`);
          sources.push(source);
        }
      } catch (error) {
        errors.push(`搜索失败：${errorText(error)}`);
        log?.warn?.(`世界书搜索失败（${query}）：${errorText(error)}`);
      }
    }

    // 抓正文：优先贴吧/小黑盒/NGA/攻略站的页面（最多 3 页），摘要太少再补普通页面
    const classified = classifySources(dedupeSources(sources));
    const toFetch = [
      ...classified.guides.slice(0, 3),
      ...classified.others.slice(0, classified.guides.length > 0 ? 1 : 2),
    ];
    if (typeof web.fetch === 'function') {
      for (const source of toFetch) {
        ensureResearchAlive(signal);
        try {
          let page = null;
          for (let attempt = 0; attempt < 2 && !page?.body?.content; attempt += 1) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(new Error('抓取超时（15s）')), 15000);
            try {
              page = await web.fetch({ url: source.url }, controller.signal);
            } finally {
              clearTimeout(timer);
            }
            if (!page?.body?.content) await new Promise((resolve) => setTimeout(resolve, 400));
          }
          if (page?.body?.content) {
            const text = page.body.kind === 'html' ? stripHtml(page.body.content) : String(page.body.content);
            if (text && text.length >= 120) {
              const tag = isGuideUrl(source.url) ? '教学/攻略贴页面' : '页面';
              materialParts.push(`【${tag}：${source.title || source.url}】\n${text.slice(0, 3200)}`);
              fetchedCount += 1;
            }
          }
        } catch (error) {
          errors.push(`抓取失败：${errorText(error)}`);
          log?.warn?.(`世界书抓取失败（${source.url}）：${errorText(error)}`);
        }
      }
    }
  } else {
    errors.push('当前 DSH 没有可用的网页搜索服务（ctx.web）');
  }

  // 抓不到正文时，至少把来源标题清单交给模型（明确标注只能参考标题，别编细节）
  if (materialParts.length === 0 && sources.length > 0) {
    const listing = sources
      .slice(0, 8)
      .map((source, index) => `${index + 1}. ${String(source.title ?? '').slice(0, 80)}（${source.url}）`)
      .join('\n');
    materialParts.push(
      `【只拿到搜索结果的标题清单，正文抓取受限】\n${listing}\n（只能据此确认来源存在；具体玩法不要编，写「资料不足」）`,
    );
  }
  const material = materialParts.join('\n\n').slice(0, MAX_MATERIAL_CHARS);
  const unique = dedupeSources(sources);
  const { guides } = classifySources(unique);
  return {
    material,
    sources: unique,
    guideSources: guides,
    fetchedCount,
    searched,
    fromWeb: material.length > 0 || unique.length > 0,
    error: errors.length > 0 ? errors[0] : null,
  };
}

const RESEARCH_PROMPT = `你是游戏资料整理助手。请根据下面提供的资料，为目标游戏整理一份给「陪玩 AI」用的世界书，让它别把游戏机制说错、别拿错误信息去指责玩家。
只输出一个 JSON 对象（不要 markdown 代码块、不要前后解释），字段：
{
  "title": "游戏名",
  "genre": "类型（如 合作射击/开放世界RPG/音游）",
  "synopsis": "一句话说清这游戏是什么（120 字内）",
  "coreLoop": "核心玩法循环（100 字内）",
  "beginnerSteps": ["新手该先做什么（3-6 条，每条 40 字内）"],
  "mechanics": ["关键机制（3-6 条，每条 40 字内）"],
  "tips": ["实用提示（3-8 条，每条 40 字内）"],
  "terms": [{"term": "游戏内术语/缩写", "meaning": "一句解释（40 字内）"}],
  "commonMistakes": ["常见误解/容易说错的地方（2-5 条，供 AI 避坑）"],
  "spoilerPolicy": "讨论剧情时的剧透边界（一句话）",
  "notes": "资料来源不足时说明（30 字内，没有就空字符串）"
}
规则：
- **优先采用教学贴/攻略贴里的说法**（贴吧、小黑盒、NGA、B 站专栏、Steam 指南等玩家社区），它们比百科更接近「这游戏实际怎么玩」。
- 同一个机制/术语如果有多个来源，要交叉验证；来源互相矛盾时，在 notes 里用一句话注明「某机制来源说法不一」，不要硬选一个当事实。
- 只提炼玩法结论，不要照抄攻略原文，不要写「帖子说」「楼主提到」这类话。
- 只使用资料里出现的信息。资料没写的字段写空字符串或空数组，**不要编造**。
- 不要写具体数值、版本号、DPS 之类的精确数据，除非资料里明确写了。
- 全部用简体中文。`;

/**
 * 为一个游戏生成世界书。
 * @param {object} options
 * @param {object} options.ctx
 * @param {object} options.settings 生效配置
 * @param {string} options.gameName
 * @param {object} [options.log]
 * @returns {Promise<object>} 保存后的世界书条目
 */
export async function researchWorldbook({ ctx, settings, gameName, log, signal = null }) {
  const name = String(gameName ?? '').trim();
  if (!isUsableGameName(name)) throw new Error(`游戏名不可用：「${name}」`);
  ensureResearchAlive(signal);

  const gathered = await gatherGameMaterial(ctx, name, log, signal);
  ensureResearchAlive(signal);
  const targets = await resolveTargets(ctx, settings);
  if (!targets.talk) throw new Error('没有可用的出话模型，无法整理世界书');

  const materialBlock = gathered.material
    ? gathered.material
    : '（没有可用的外部资料；请只依据你已经知道的该游戏信息来整理，不确定的字段留空，并在 notes 里写「仅凭模型知识，可能有误」）';

  const result = await streamText(ctx, {
    provider: targets.talk.provider,
    model: targets.talk.model,
    content: [
      { type: 'text', text: `${RESEARCH_PROMPT}\n\n游戏名：${name}\n\n资料：\n${materialBlock}` },
    ],
    system: '你是游戏资料整理助手：只输出 JSON，资料不足就留空，绝不编造。',
    maxTokens: 2400,
    temperature: 0.3,
    timeoutMs: 120000,
    reasoningEffort: 'off',
    signal,
  });
  if (result.cancelled) throw cancelledResearchError();
  if (!result.ok) throw new Error(`世界书整理失败：${result.message}`);

  const parsed = extractJsonObject(result.text);
  if (!parsed || typeof parsed !== 'object') throw new Error('世界书整理失败：模型没有返回可解析的 JSON');

  const guideCount = gathered.guideSources?.length ?? 0;
  const fetchedCount = gathered.fetchedCount ?? 0;
  const hadMaterial = String(gathered.material ?? '').length > 0;
  // 可信度由服务端按「实际拿到什么」计算，不采信模型自评
  let verification;
  let notes = String(parsed.notes ?? '').trim();
  if (guideCount > 0 && fetchedCount > 0) {
    verification = `参考 ${guideCount} 个玩家社区/攻略来源，抓到 ${fetchedCount} 篇正文，已交叉核对`;
  } else if (guideCount > 0) {
    verification = `找到 ${guideCount} 个玩家社区/攻略来源，但正文抓取受限，只能参考标题与摘要`;
    notes = notes || '正文抓取受限，玩法细节可能不够准';
  } else if (hadMaterial) {
    verification = '通用网页资料，未找到玩家教学贴正文，可信度一般';
    notes = notes || '未找到玩家教学贴，建议手动补充';
  } else {
    verification = '仅模型知识，可能有误';
    notes = notes || '联网资料不可用，仅凭模型知识';
  }
  ensureResearchAlive(signal);
  const entry = normalizeWorldbook(
    {
      ...parsed,
      game: name,
      confidence: gathered.fromWeb ? 'web' : 'model',
      verification,
      sources: gathered.sources,
      researchedAt: new Date().toISOString(),
      notes,
    },
    { gameName: name },
  );
  return entry;
}
