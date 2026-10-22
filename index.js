// dsh-companion 宿主半侧入口（DSH 插件三件套：name / inject / apply）。
//
// 这个文件刻意只做"接线"：真正的逻辑在 src/host/ 下。不 import 任何 @deepseek-ai/* 包——
// 插件装在 profile 的 node_modules（或作为链接包），而 DSH 的包在 app.asar 里，
// 静态裸 import 会解析失败并让整个插件**静默**不生效。需要的能力全部走 ctx 注入的服务。
import { apply as applyCompanion } from './src/host/plugin.mjs';

export const name = 'dsh-companion';

/**
 * 依赖的宿主服务：
 *   webServer        面板/路由
 *   llm              模型调用（与对话页同一套服务商与凭据）
 *   agentDefaultModel 当前对话模型（默认拿它当识图/出话模型）
 * attachments 是可选服务（ctx.get('attachments', false)）：没有它就只能纯文本。
 */
export const inject = ['webServer', 'llm', 'agentDefaultModel'];

/** @param {any} ctx Cordis 上下文 @param {any} config profile patch 里这一行的 config */
export function apply(ctx, config) {
  return applyCompanion(ctx, config);
}
