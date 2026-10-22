// plugin.mjs —— 宿主半侧装配：日志 → 引擎 → 路由 → 生命周期。
//
// 这里是 DSH 插件契约的落点：apply(ctx, config)。config 是 profile patch 里那一行的
// config（部署默认值）；用户改的东西另存 $DSH_HOME/dsh-companion/config.json。
import { makeEngine } from './engine.mjs';
import { makeRoutes } from './routes.mjs';
import { makeLogger, errorText } from './util.mjs';
import { makeVoiceInstaller } from './voice-install.mjs';

export const ROUTE_PREFIX = '/dsh-companion';

export function apply(ctx, config) {
  const log = makeLogger('dsh-companion');
  log.info(`插件的 apply() 进入（pid ${process.pid}，node ${process.version}）`);

  let engine;
  try {
    engine = makeEngine({ ctx, deployConfig: config ?? {}, log });
  } catch (error) {
    log.error(`引擎创建失败：${errorText(error)}`);
    throw error;
  }

  // 初始化（读配置/历史、拉起本地服务）放后台，绝不阻塞宿主启动
  void engine.init().catch((error) => log.error(`初始化失败：${errorText(error)}`));

  // 路由
  const voiceInstaller = makeVoiceInstaller({ log });
  const routes = makeRoutes({ ctx, engine, log, prefix: ROUTE_PREFIX, voiceInstaller });
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: routes.handler,
      }),
    'dsh-companion: HTTP routes',
  );

  // 生命周期：插件卸载时停定时器、落盘历史、关掉自己拉起的服务
  ctx.effect(
    () => () => {
      log.info('插件卸载，正在收尾');
      void voiceInstaller.dispose().finally(() => engine.dispose()).catch((error) => log.warn(`收尾失败：${errorText(error)}`));
    },
    'dsh-companion: lifecycle',
  );

  // 让诊断信息在宿主日志里也有一行（用户排查"插件到底加载没有"时最有用）
  try {
    ctx.logger?.info?.('dsh-companion: 陪玩插件已挂载（面板在右侧栏「陪玩」）');
  } catch {
    // logger 可能不存在
  }
  return engine;
}
