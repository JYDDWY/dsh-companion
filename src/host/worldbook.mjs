// worldbook.mjs —— 游戏世界书：每个游戏一份可编辑的「设定 + 新手知识」资料，
// 用来压住模型的幻觉和游戏理解错误。生成来源分三种：web（联网调研）、model（仅模型知识）、
// manual（用户手改/手写）。agent 出话时把这份资料喂给提示词，并明确告诉它「资料可能不全，
// 不确定就不要当事实」。
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from './config.mjs';

const FIELDS = [
  'id',
  'game',
  'title',
  'genre',
  'synopsis',
  'coreLoop',
  'beginnerSteps',
  'mechanics',
  'tips',
  'terms',
  'commonMistakes',
  'spoilerPolicy',
  'verification',
  'sources',
  'confidence',
  'researchedAt',
  'updatedAt',
  'notes',
];

export function worldbookDir() {
  return path.join(dataDir(), 'worldbooks');
}

/** 世界书 id 的合法格式（12 位十六进制；用于路径与文件名白名单）。 */
export const WORLDBOOK_ID_RE = /^[0-9a-f]{12}$/;
export function isWorldbookId(id) {
  return WORLDBOOK_ID_RE.test(String(id ?? '').trim());
}

/** 游戏名 → 稳定 id。只忽略明确的版本标记（v1.2 / ver 2 / version 3），保留「2」「4」这种续作数字。 */
export function worldbookId(gameName) {
  const normalized = String(gameName ?? '')
    .replace(/[™®©]/g, '')
    .replace(/\b(?:v|ver\.?|version|版本)\s*\d+(?:\.\d+){0,3}\b/gi, '')
    .replace(/[\s\-_:：·・]+/g, ' ')
    .trim()
    .toLowerCase();
  return createHash('sha1').update(normalized || 'unknown').digest('hex').slice(0, 12);
}

/** 旧版算法（会误删续作数字）生成的 id，用来兼容已有世界书文件。 */
export function legacyWorldbookId(gameName) {
  const normalized = String(gameName ?? '')
    .replace(/[™®©]/g, '')
    .replace(/\b(v|ver\.?|version)?\s*\d+(\.\d+){0,3}\b/gi, '')
    .replace(/[\s\-_:：·・]+/g, ' ')
    .trim()
    .toLowerCase();
  return createHash('sha1').update(normalized || 'unknown').digest('hex').slice(0, 12);
}

/** 世界书文件的绝对路径；id 非法或解析后越界时返回 null。 */
function worldbookPath(id) {
  if (!isWorldbookId(id)) return null;
  const dir = worldbookDir();
  const resolved = path.resolve(dir, `${String(id)}.json`);
  const root = path.resolve(dir) + path.sep;
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

export function isUsableGameName(name) {
  const text = String(name ?? '').trim();
  if (text.length < 2 || text.length > 80) return false;
  if (/^未知|^非游戏|^unknown$/i.test(text)) return false;
  if (/^[\d\s.]+$/.test(text)) return false;
  return true;
}

function cleanString(value, max = 400) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanList(value, max = 12, each = 60) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanString(typeof item === 'object' ? item?.text ?? item?.name ?? '' : item, each))
    .filter(Boolean)
    .slice(0, max);
}

function cleanTerms(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      term: cleanString(item?.term ?? item?.name ?? '', 30),
      meaning: cleanString(item?.meaning ?? item?.desc ?? item?.text ?? '', 80),
    }))
    .filter((item) => item.term && item.meaning)
    .slice(0, 20);
}

function cleanSources(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({ title: cleanString(item?.title ?? '', 80), url: cleanString(item?.url ?? '', 300) }))
    .filter((item) => /^https?:\/\//i.test(item.url))
    .slice(0, 8);
}

/** 归一化任意输入（模型 JSON / 用户编辑）为世界书条目。 */
export function normalizeWorldbook(input, { gameName = '', keepId = false } = {}) {
  const game = cleanString(input?.game ?? gameName, 80);
  const id = keepId && isWorldbookId(input?.id) ? String(input.id) : worldbookId(game);
  const entry = {
    id,
    game,
    title: cleanString(input?.title ?? game, 80),
    genre: cleanString(input?.genre ?? '', 40),
    synopsis: cleanString(input?.synopsis ?? '', 400),
    coreLoop: cleanString(input?.coreLoop ?? '', 300),
    beginnerSteps: cleanList(input?.beginnerSteps),
    mechanics: cleanList(input?.mechanics),
    tips: cleanList(input?.tips),
    terms: cleanTerms(input?.terms),
    commonMistakes: cleanList(input?.commonMistakes),
    spoilerPolicy: cleanString(input?.spoilerPolicy ?? '', 120),
    verification: cleanString(input?.verification ?? '', 120),
    sources: cleanSources(input?.sources),
    confidence: ['web', 'model', 'manual'].includes(input?.confidence) ? input.confidence : 'model',
    researchedAt: cleanString(input?.researchedAt ?? '', 40),
    updatedAt: new Date().toISOString(),
    notes: cleanString(input?.notes ?? '', 400),
  };
  return entry;
}

async function ensureDir() {
  await mkdir(worldbookDir(), { recursive: true });
}

export async function listWorldbooks() {
  try {
    const dir = worldbookDir();
    const names = (await readdir(dir)).filter((name) => name.endsWith('.json') && isWorldbookId(name.slice(0, -5)));
    const result = [];
    for (const name of names) {
      try {
        const entry = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
        if (entry && entry.id) result.push(entry);
      } catch {
        // 单个文件坏了不影响其它
      }
    }
    result.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    return result;
  } catch {
    return [];
  }
}

export async function getWorldbookById(id) {
  const file = worldbookPath(id);
  if (!file) return null;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function getWorldbook(gameName) {
  if (!isUsableGameName(gameName)) return null;
  const requestedId = worldbookId(gameName);
  const entry = await getWorldbookById(requestedId);
  if (entry) return entry;
  // 兼容旧版本生成的世界书（续作数字被吃掉的旧 id）：
  // 旧 id 可能同时对应《生化危机 2》和《生化危机 4》，必须核对条目自己的游戏名，
  // 归一化后与请求 id 相同才接受；否则会把另一部续作的资料串过来。
  const legacy = await getWorldbookById(legacyWorldbookId(gameName));
  if (!legacy) return null;
  if (worldbookId(legacy.game) !== requestedId) return null;
  return legacy;
}

/** 保存世界书。keepId=true 用于用户在面板里编辑已有条目（保留原 id/旧文件）。 */
export async function saveWorldbook(entry, { keepId = false } = {}) {
  await ensureDir();
  const normalized = normalizeWorldbook(entry, { gameName: entry?.game ?? '', keepId });
  const file = worldbookPath(normalized.id);
  if (!file) throw new Error('世界书 id 不合法');
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(normalized, null, 2)}
`, 'utf8');
  await rename(tmp, file);
  return normalized;
}

export async function deleteWorldbook(id) {
  const file = worldbookPath(id);
  if (!file) return false;
  try {
    await unlink(file);
    return true;
  } catch {
    return false;
  }
}

/** 世界书 → 喂给模型的精简文本（不含来源 URL 之外的长篇内容）。 */
export function worldbookPromptText(entry, maxChars = 1400) {
  if (!entry) return '';
  const lines = [`【世界书 · ${entry.title || entry.game}】`];
  if (entry.genre) lines.push(`类型：${entry.genre}`);
  if (entry.synopsis) lines.push(`一句话设定：${entry.synopsis}`);
  if (entry.coreLoop) lines.push(`核心玩法：${entry.coreLoop}`);
  if (entry.beginnerSteps?.length) {
    lines.push('新手要点：');
    for (const item of entry.beginnerSteps.slice(0, 6)) lines.push(`- ${item}`);
  }
  if (entry.tips?.length) {
    lines.push('实用提示：');
    for (const item of entry.tips.slice(0, 6)) lines.push(`- ${item}`);
  }
  if (entry.terms?.length) {
    lines.push('术语：');
    for (const item of entry.terms.slice(0, 10)) lines.push(`- ${item.term}：${item.meaning}`);
  }
  if (entry.commonMistakes?.length) {
    lines.push('常见误解（不要犯）：');
    for (const item of entry.commonMistakes.slice(0, 5)) lines.push(`- ${item}`);
  }
  if (entry.spoilerPolicy) lines.push(`剧透规则：${entry.spoilerPolicy}`);
  if (entry.verification) lines.push(`资料可信度：${entry.verification}`);
  lines.push('（以上是背景资料，可能不完整或过时。不要把它没有提到的具体数值/机制当成事实，更不要据此指责主人；不确定就说不确定。）');
  return lines.join('\n').slice(0, Math.max(400, Number(maxChars) || 1400));
}

export { FIELDS };
