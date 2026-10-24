// cast.mjs —— 「一人分饰多角」的角色、角色卡与配置归一化。
//
// 多人模式不改变识图链路：同一轮截图仍然只做一次识图，然后让一个模型按
// 角色表写一小段多角色剧本，再逐句交给不同声线朗读。这里只放纯数据与纯函数，
// 不碰 ctx / 文件 / 网络，方便单测和设置面板复用。
export const CAST_MAX_ROLES = 3;

/** 内置角色卡：id 会写进配置，不要随便改；改的是展示名和人格文案。 */
export const ROLE_CARDS = Object.freeze([
  Object.freeze({
    id: 'gentle',
    name: '温柔陪伴',
    style: 'gentle',
    relation: '温柔的陪伴者',
    blurb: '轻声接住情绪，先安慰再给建议，不嘲讽不施压。',
  }),
  Object.freeze({
    id: 'tsundere',
    name: '损友吐槽',
    style: 'tsundere',
    relation: '损友',
    blurb: '嘴硬心软，专挑槽点，但底子始终站在你这边。',
  }),
  Object.freeze({
    id: 'cheerful',
    name: '元气捧场',
    style: 'cheerful',
    relation: '元气搭子',
    blurb: '情绪外放，负责起哄、喝彩，把气氛炒热。',
  }),
  Object.freeze({
    id: 'analyst',
    name: '冷静军师',
    style: 'analyst',
    relation: '冷静军师',
    blurb: '先观察再判断，负责局势分析和关键提醒。',
  }),
]);

const CARD_BY_ID = new Map(ROLE_CARDS.map((card) => [card.id, card]));
const CARD_BY_STYLE = new Map(ROLE_CARDS.map((card) => [card.style, card]));

export function roleCard(id) {
  return CARD_BY_ID.get(String(id ?? '')) ?? ROLE_CARDS[0];
}

export function cardForStyle(style) {
  return CARD_BY_STYLE.get(String(style ?? '')) ?? ROLE_CARDS[0];
}

/** 默认三个角色槽：前两个开启、第三个关闭；总开关默认关闭。 */
const DEFAULT_ROLE_INPUTS = [
  { enabled: true, card: 'gentle', name: '陪伴者', voiceId: '', useAgentsMd: true, speakChance: 70, extra: '' },
  { enabled: true, card: 'tsundere', name: '损友', voiceId: '', useAgentsMd: false, speakChance: 70, extra: '' },
  { enabled: false, card: 'analyst', name: '军师', voiceId: '', useAgentsMd: false, speakChance: 70, extra: '' },
];

export function defaultCastRoles() {
  return DEFAULT_ROLE_INPUTS.map((role, index) => ({
    id: `r${index + 1}`,
    ...role,
  }));
}

export function defaultCastConfig() {
  return {
    enabled: false,
    mainChance: 70,
    randomOrder: true,
    roles: defaultCastRoles(),
  };
}

function clampChance(value, fallback = 70) {
  const number = Number(value);
  return Math.max(0, Math.min(100, Number.isFinite(number) ? number : fallback));
}

/** 把一个角色槽归一化；id 固定按槽位生成，避免用户配置里的旧 id 漂移。 */
function normalizeRole(raw, index, legacyChance = 70) {
  const fallback = DEFAULT_ROLE_INPUTS[index] ?? DEFAULT_ROLE_INPUTS[DEFAULT_ROLE_INPUTS.length - 1];
  const hasRaw = raw != null && typeof raw === 'object';
  const card = roleCard(hasRaw ? raw.card : fallback.card);
  const name = String(hasRaw ? raw.name : fallback.name).trim().slice(0, 20) || fallback.name;
  const rawChance = hasRaw ? raw.speakChance : undefined;
  const fallbackChance = rawChance ?? legacyChance ?? fallback.speakChance ?? 70;
  return {
    id: `r${index + 1}`,
    enabled: hasRaw ? raw.enabled === true : fallback.enabled === true,
    card: card.id,
    name,
    voiceId: String(hasRaw ? raw.voiceId : fallback.voiceId).trim().slice(0, 80),
    useAgentsMd: hasRaw ? raw.useAgentsMd === true : fallback.useAgentsMd === true,
    speakChance: clampChance(fallbackChance, 70),
    extra: String(hasRaw ? raw.extra : fallback.extra).trim().slice(0, 600),
  };
}

/**
 * 归一化多人配置：永远保留 3 个角色槽（多出的截掉），这样设置面板可以稳定渲染。
 * 旧配置没有 cast 字段时返回默认值。旧版的全局 speakChance 会迁移成每个角色的默认值。
 */
export function normalizeCast(input) {
  const source = input && typeof input === 'object' ? input : {};
  const roles = Array.isArray(source.roles) ? source.roles.slice(0, CAST_MAX_ROLES) : [];
  const legacyChance = clampChance(source.speakChance, 70);
  const normalized = [];
  for (let index = 0; index < CAST_MAX_ROLES; index += 1) {
    normalized.push(normalizeRole(roles[index], index, legacyChance));
  }
  return {
    enabled: source.enabled === true,
    mainChance: clampChance(source.mainChance, legacyChance),
    randomOrder: source.randomOrder !== false,
    roles: normalized,
  };
}

/**
 * 主角色固定使用设置页「人格」里那套原始配置（名字/风格/关系/额外人设/AGENTS.md）
 * 和当前声线；下面 cast.roles[1..2] 才是额外加入的角色 2、3。
 */
export function mainCastRole(settings) {
  const persona = settings?.persona ?? {};
  return {
    id: 'r1',
    main: true,
    enabled: true,
    card: cardForStyle(persona.style).id,
    style: String(persona.style || 'gentle'),
    name: String(persona.name || '陪玩').trim() || '陪玩',
    relation: String(persona.relation || '').trim(),
    voiceId: String(settings?.voice?.voiceId || ''),
    useAgentsMd: persona.useAgentsMd !== false,
    speakChance: clampChance(settings?.cast?.mainChance, 70),
    extra: String(persona.extra || '').trim(),
  };
}

/** 当前真正会开口的角色（主角色 + 额外角色 2/3；总开关关掉时为空）。 */
export function activeCastRoles(settings) {
  const cast = settings?.cast;
  if (!cast?.enabled) return [];
  const extras = (Array.isArray(cast.roles) ? cast.roles.slice(1) : [])
    .filter((role) => role?.enabled === true)
    .slice(0, CAST_MAX_ROLES - 1)
    .map((role) => ({ ...role, main: false }));
  return [mainCastRole(settings), ...extras].slice(0, CAST_MAX_ROLES);
}

/** 面板聊天由主角色回答；多人观察时也常用它当主声线。 */
export function castMainRole(settings) {
  return activeCastRoles(settings)[0] ?? null;
}

/**
 * 每轮独立给每个角色掷自己的开口概率，决定它这轮开不开口；至少保底一个角色开口。
 * 返回的角色顺序按设置决定是否打乱，避免每轮都是固定轮唱。
 */
export function chooseCastSpeakers(roles, random = Math.random, randomOrder = true) {
  const list = Array.isArray(roles) ? roles.filter((role) => role?.id) : [];
  if (list.length === 0) return [];
  let picked = list.filter((role) => (Number(random()) * 100) < clampChance(role.speakChance, 70));
  // 保底：哪怕概率是 0、或者全都没掷中，也至少让一个角色开口。
  if (picked.length === 0) {
    picked = [list[Math.floor(Number(random()) * list.length) % list.length]];
  }
  if (!randomOrder) return picked;
  for (let index = picked.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Number(random()) * (index + 1)) % (index + 1);
    [picked[index], picked[swap]] = [picked[swap], picked[index]];
  }
  return picked;
}

/** 把某个角色卡套到全局配置上，得到只属于这个角色的 persona 配置。 */
export function withRolePersona(settings, role) {
  const card = roleCard(role?.card);
  const isMain = role?.main === true;
  const overrides = settings?.persona?.promptOverrides && typeof settings.persona.promptOverrides === 'object'
    ? { ...settings.persona.promptOverrides }
    : {};
  // 额外角色的风格块必须由角色卡决定，否则全局的自定义 style 覆盖会把所有角色拉回同一种口吻；
  // 主角色就是原来的全局人格，所以保留它的 style 覆盖。
  if (!isMain) delete overrides.style;
  return {
    ...settings,
    persona: {
      ...settings.persona,
      name: String(role?.name ?? card.name).trim() || card.name,
      relation: String(role?.relation || (isMain ? settings?.persona?.relation : '') || card.relation).trim(),
      style: String(role?.style || card.style),
      extra: String(role?.extra ?? (isMain ? settings?.persona?.extra : '') ?? '').trim(),
      useAgentsMd: role?.useAgentsMd === true,
      promptOverrides: overrides,
    },
  };
}

/** 给日志/历史用的角色名。 */
export function roleDisplayName(role) {
  if (!role) return '';
  return String(role.name ?? '').trim() || roleCard(role.card).name;
}
