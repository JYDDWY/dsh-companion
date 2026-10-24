// routes.mjs —— 插件的 HTTP 路由（浏览器半侧轮询/操作都走这里）。

//

// 前缀 /dsh-companion：

//   GET  /state                 面板轮询的完整快照

//   GET  /config                当前配置

//   POST /config                改配置（只收白名单键，落盘用户层）

//   POST /start | /stop         开停检测

//   POST /capture-now           立刻看一眼（强制跑一轮）

//   POST /chat                  面板里打字聊天

//   POST /stop-speaking         闭嘴

//   GET  /models                可选模型目录（标出哪些支持图片）

//   GET  /voices                语音服务的声线清单

//   POST /services/ensure       手动拉起本地服务

//   POST /services/restart      重启某个本地服务

//   GET  /services/log?kind=..  看服务日志尾巴

//   GET  /probe                 只看前台窗口（不截图不调模型）

//   GET  /frame/<tick>/<i>      截图帧（面板缩略图）

//   GET  /logs?tail=200         插件日志尾巴

//   GET  /vision-report         识图候选诊断

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { modelCatalog } from './llm.mjs';

import { FRAMES_DIR } from './capture.mjs';

import { dataDir } from './config.mjs';

import { errorText, readJsonFile } from './util.mjs';



const MAX_BODY = 256 * 1024;



function sendJson(res, status, payload, headers = {}) {

  const body = JSON.stringify(payload);

  res.writeHead(status, {

    'content-type': 'application/json; charset=utf-8',

    'cache-control': 'no-store',

    ...headers,

  });

  res.end(body);

}



function readBody(req) {

  return new Promise((resolve, reject) => {

    let size = 0;

    const chunks = [];

    req.on('data', (chunk) => {

      size += chunk.length;

      if (size > MAX_BODY) {

        reject(new Error('请求体过大'));

        req.destroy();

        return;

      }

      chunks.push(chunk);

    });

    req.on('end', () => {

      const raw = Buffer.concat(chunks).toString('utf8');

      if (!raw.trim()) {

        resolve({});

        return;

      }

      try {

        resolve(JSON.parse(raw));

      } catch (error) {

        reject(new Error(`请求体不是合法 JSON：${errorText(error)}`));

      }

    });

    req.on('error', reject);

  });

}



async function tailFile(file, maxLines) {

  try {

    const raw = await readFile(file, 'utf8');

    const lines = raw.split(/\r?\n/);

    return lines.slice(Math.max(0, lines.length - maxLines - 1)).join('\n');

  } catch (error) {

    return `（读不到日志：${errorText(error)}）`;

  }

}



const SUPPORT_PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'support');

function supportDataDir() {
  return path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'dsh-companion', 'support');
}

function supportContentType(name) {
  const ext = String(name).toLowerCase().split('.').pop();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'application/octet-stream';
}

export function makeRoutes({ ctx, engine, log, prefix, diag, voiceInstaller }) {

  async function handler(req, res) {

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    const route = url.pathname.slice(prefix.length) || '/';

    const method = (req.method ?? 'GET').toUpperCase();

    const parts = route.split('/').filter(Boolean);



    try {

      if (route === '/voice-install' && method === 'GET' && voiceInstaller) {
        sendJson(res, 200, await voiceInstaller.status());
        return;
      }
      if (route.startsWith('/voice-install/') && method === 'POST' && voiceInstaller) {
        let originAllowed = !req.headers.origin;
        try { if (req.headers.origin) originAllowed = new URL(req.headers.origin).host === req.headers.host; } catch { /* reject invalid Origin */ }
        if (!originAllowed || !(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
          sendJson(res, 403, { ok: false, error: '请从陪玩插件面板操作语音安装' });
          return;
        }
        if (route === '/voice-install/start') sendJson(res, 202, await voiceInstaller.start(await readBody(req)));
        else if (route === '/voice-install/cancel') sendJson(res, 200, await voiceInstaller.cancel());
        else if (route === '/voice-install/open-models') sendJson(res, 200, await voiceInstaller.openModels());
        else sendJson(res, 404, { ok: false, error: '未知安装操作' });
        return;
      }

      if (method === 'GET' && (route === '/' || route === '/state')) {

        sendJson(res, 200, engine.getState());

        return;

      }

      if (method === 'GET' && route === '/config') {

        sendJson(res, 200, { ok: true, ...engine.getConfigPayload() });

        return;

      }

      if (method === 'POST' && route === '/config') {

        const body = await readBody(req);

        const patch = body && typeof body === 'object' ? body.patch ?? body : {};

        const config = await engine.updateConfig(patch);

        sendJson(res, 200, { ok: true, config });

        return;

      }

      if (method === 'POST' && route === '/start') {

        const config = await engine.updateConfig({ enabled: true });

        sendJson(res, 200, { ok: true, config });

        return;

      }

      if (method === 'POST' && route === '/stop') {

        const config = await engine.updateConfig({ enabled: false });

        await engine.stopSpeaking().catch(() => {});

        sendJson(res, 200, { ok: true, config });

        return;

      }

      if (method === 'POST' && route === '/capture-now') {

        const result = await engine.captureNow();

        sendJson(res, 200, { ok: result.ok, result, state: engine.getState() });

        return;

      }

      // ── 世界书 ─────────────────────────────────────────────────────
      if (method === 'GET' && route === '/subtitle/fonts') {
        const result = await engine.listSubtitleFonts({ force: url.searchParams.get('force') === '1' });
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (method === 'POST' && route === '/subtitle/test') {
        const body = await readBody(req);
        try {
          const result = await engine.testSubtitle(body?.text);
          sendJson(res, 200, result);
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
        return;
      }

      if (method === 'POST' && route === '/subtitle/restart') {
        const result = await engine.restartSubtitle();
        sendJson(res, 200, result);
        return;
      }

      if (method === 'GET' && route === '/support-assets') {
        const items = [];
        for (const dir of [SUPPORT_PACKAGE_DIR, supportDataDir()]) {
          try {
            for (const name of await readdir(dir)) {
              if (/\.(png|jpe?g|webp|gif)$/i.test(name)) items.push({ name });
            }
          } catch {
            // 目录不存在
          }
        }
        sendJson(res, 200, { ok: true, items });
        return;
      }

      if (method === 'GET' && route === '/support-asset') {
        const name = path.basename(url.searchParams.get('name') ?? '');
        if (!name) {
          sendJson(res, 400, { ok: false, error: '缺少 name' });
          return;
        }
        for (const dir of [SUPPORT_PACKAGE_DIR, supportDataDir()]) {
          try {
            const data = await readFile(path.join(dir, name));
            res.writeHead(200, { 'content-type': supportContentType(name), 'cache-control': 'no-store' });
            res.end(data);
            return;
          } catch {
            // 继续找下一个目录
          }
        }
        sendJson(res, 404, { ok: false, error: '找不到图片' });
        return;
      }

      if (method === 'POST' && route === '/cleanup-frames') {
        const storage = await engine.cleanupFrames(true);
        sendJson(res, 200, { ok: true, storage });
        return;
      }

      if (method === 'GET' && route === '/prompt-blocks') {
        sendJson(res, 200, { ok: true, ...engine.getPromptBlocks() });
        return;
      }

      if (method === 'GET' && route === '/worldbooks') {
        const items = await engine.listWorldbooks();
        const current = engine.getState().worldbook;
        sendJson(res, 200, { ok: true, items, current });
        return;
      }

      if (method === 'GET' && route === '/worldbook') {
        const entry = await engine.getWorldbookEntry({
          id: url.searchParams.get('id') ?? '',
          game: url.searchParams.get('game') ?? '',
        });
        sendJson(res, 200, { ok: Boolean(entry), entry });
        return;
      }

      if (method === 'POST' && route === '/worldbook') {
        const body = await readBody(req);
        const entry = await engine.saveWorldbookEntry(body?.entry ?? body ?? {});
        sendJson(res, 200, { ok: true, entry });
        return;
      }

      if (method === 'POST' && route === '/worldbook/research') {
        const body = await readBody(req);
        const game = String(body?.game ?? '').trim();
        try {
          const entry = await engine.researchWorldbookNow(game);
          sendJson(res, 200, { ok: true, entry });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
        return;
      }

      if (method === 'POST' && route === '/worldbook/delete') {
        const body = await readBody(req);
        const removed = await engine.removeWorldbook(String(body?.id ?? ''));
        sendJson(res, 200, { ok: true, removed });
        return;
      }

      if (method === 'POST' && route === '/new-conversation') {
        const body = await readBody(req);
        const result = await engine.newConversation({ summarize: body?.summarize !== false });
        sendJson(res, 200, { ok: true, ...result });
        return;
      }
      if (method === 'POST' && route === '/chat') {

        const body = await readBody(req);

        const text = String(body?.text ?? '').trim();

        if (!text) {

          sendJson(res, 400, { ok: false, error: '消息不能为空' });

          return;

        }

        const result = await engine.chat(text);

        sendJson(res, 200, { ok: true, ...result, state: engine.getState() });

        return;

      }

      if (method === 'POST' && route === '/stop-speaking') {

        await engine.stopSpeaking();

        sendJson(res, 200, { ok: true });

        return;

      }

      if (method === 'GET' && route === '/models') {

        const catalog = await modelCatalog(ctx);

        sendJson(res, 200, { ok: true, ...catalog });

        return;

      }

      if (method === 'GET' && route === '/voices') {

        const force = url.searchParams.get('force') === '1';
        const voices = await engine.VOICE.listVoices({ force });
        const settings = engine.getSettings?.() ?? engine.getState().config ?? {};

        // 语音服务是否在线：面板要区分“正在加载 / 服务未启动 / 未安装模型”
        let health = { ok: false, error: '语音服务未响应' };
        try { health = await engine.VOICE.health(1200); } catch (error) { health = { ok: false, error: errorText(error) }; }

        // 一键安装环境：/voices 会列出服务内置的全部声线（即使模型没下载），
        // 因此用磁盘上实际存在的 weights/*.pth 做交集；自定义外部服务仍用服务返回的列表。
        let install = null;
        try { install = voiceInstaller ? await voiceInstaller.status() : null; } catch { install = null; }

        let externalService = false;
        try {
          const voiceUrl = new URL(String(settings.services?.voiceUrl ?? 'http://127.0.0.1:9123'));
          const localHost = voiceUrl.hostname === '127.0.0.1' || voiceUrl.hostname === 'localhost';
          externalService = !localHost || voiceUrl.port !== '9123';
        } catch { externalService = true; }

        const managed = Boolean(install?.runtimeReady) && !externalService;
        const installed = new Set((install?.models?.voices ?? []).map((name) => String(name).replace(/\.pth$/i, '')));
        const catalog = managed
          ? voices.filter((voice) => installed.has(String(voice.id))).map((voice) => ({ ...voice, installed: true }))
          : voices;

        sendJson(res, 200, {
          ok: true,
          voices: catalog,
          allVoices: voices,
          service: engine.getState().services.voice,
          serviceOk: Boolean(health.ok),
          serviceError: health.ok ? null : (health.error ?? '语音服务未启动'),
          source: managed ? 'managed' : 'service',
          managed,
          externalService,
          runtimeReady: Boolean(install?.runtimeReady),
          models: install?.models ?? null,
          modelDir: install?.modelDir ?? null,
          installedVoices: managed ? [...installed] : null,
        });

        return;

      }

      if (method === 'POST' && route === '/services/ensure') {

        const report = await engine.ensureServices();

        sendJson(res, 200, { ok: true, report, services: engine.getState().services });

        return;

      }

      if (method === 'POST' && route === '/services/restart') {

        const body = await readBody(req);

        const kind = body?.kind === 'voice' ? 'voice' : 'capture';

        const probe = kind === 'capture' ? () => engine.CAPTURE.health() : () => engine.VOICE.health();

        await engine.SERVICES.stop(kind);

        const result = await engine.SERVICES.ensure(kind, probe, { timeoutMs: kind === 'voice' ? 120000 : 25000 });

        await engine.checkServices();

        sendJson(res, 200, { ok: true, kind, result, services: engine.getState().services });

        return;

      }

      if (method === 'GET' && route === '/services/log') {

        const kind = url.searchParams.get('kind') === 'voice' ? 'voice' : 'capture';

        const tail = Number(url.searchParams.get('tail') ?? '120');

        const text = await tailFile(path.join(dataDir(), 'services', `${kind}.log`), Math.min(2000, Math.max(10, tail)));

        sendJson(res, 200, { ok: true, kind, tail: text });

        return;

      }

      if (method === 'GET' && route === '/logs') {

        const tail = Number(url.searchParams.get('tail') ?? '200');

        const text = await tailFile(path.join(dataDir(), 'companion.log'), Math.min(5000, Math.max(10, tail)));

        sendJson(res, 200, { ok: true, tail: text });

        return;

      }

      if (method === 'GET' && route === '/probe') {

        const windowInfo = await engine.CAPTURE.window();

        sendJson(res, 200, { ok: true, window: windowInfo });

        return;

      }

      if (method === 'GET' && route === '/vision-report') {

        const targets = engine.getState().modelReport;

        sendJson(res, 200, { ok: true, report: targets });

        return;

      }

      // 帧图片：/frame/<tick>/<index>

      if (method === 'GET' && parts[0] === 'frame' && parts.length >= 3) {

        const tick = Number(parts[1]);

        const index = Number(parts[2].replace(/\.(jpg|jpeg|png)$/i, ''));

        if (!Number.isInteger(tick) || !Number.isInteger(index) || tick < 0 || index < 0 || tick > 1e9) {

          sendJson(res, 400, { ok: false, error: 'bad frame id' });

          return;

        }

        const dir = path.join(FRAMES_DIR, String(tick));

        const candidates = [

          path.join(dir, `frame-${index}.jpg`),

          path.join(dir, `frame-${index}.jpeg`),

          path.join(dir, `frame-${index}.png`),

          path.join(dir, `${index}.jpg`),

          path.join(dir, `${index}.png`),

        ];

        for (const file of candidates) {

          try {

            const buffer = await readFile(file);

            const type = file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

            res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=86400' });

            res.end(buffer);

            return;

          } catch {

            // try next

          }

        }

        sendJson(res, 404, { ok: false, error: 'frame not found' });

        return;

      }

      sendJson(res, 404, { ok: false, error: `未知路由 ${method} ${route}` });

    } catch (error) {

      log.warn(`路由 ${method} ${route} 失败：${errorText(error)}`);

      try {

        sendJson(res, 500, { ok: false, error: errorText(error) });

      } catch {

        // response already sent

      }

    }

  }



  return { handler };

}

