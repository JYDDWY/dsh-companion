// services.mjs —— 本地服务管家：截图服务 + 语音服务的拉起、健康检查、重启。
//
// 两个服务都是「插件装好就能用」的一部分：插件启动时探一下健康，不在就按配置的
// Python 把脚本拉起来（后台子进程，日志写到 $DSH_HOME/dsh-companion/services/）。
// 不用 pm2/systemd 这类外部进程管理——插件自己就是它们的生命周期主人。
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './config.mjs';
import { errorText } from './util.mjs';
import { installedVoiceRuntime, modelFiles } from './voice-runtime.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVICES_DIR = path.join(dataDir(), 'services');

/** Python 候选路径：先配置、再 PATH、再常见安装位置。 */
function pythonCandidates(kind, configured) {
  const list = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim() && !list.includes(value.trim())) list.push(value.trim());
  };
  push(configured);
  const localAppData = process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
  push(path.join(localAppData, 'Programs', 'Python', 'Python313', 'python.exe'));
  push(path.join(localAppData, 'Programs', 'Python', 'Python312', 'python.exe'));
  push(path.join(localAppData, 'Programs', 'Python', 'Python311', 'python.exe'));
  // RVC 工程的 venv（语音服务要 torch，非它不可；截图服务用它也能跑）
  push('E:/codx_workspace/gpt-voice-playground/.venv/Scripts/python.exe');
  // dsh 自带运行时里的 python
  push(path.join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'));
  // 不要用裸 'python'：Windows 10/11 的“应用执行别名”会把人带到 Microsoft Store
  if (kind === 'voice') {
    // 语音服务必须用带 torch 的解释器：发行包里是 services/voice/.venv，
    // 开发机上是 RVC 工程的 venv；环境变量 DSH_COMPANION_VOICE_PYTHON 可强制指定。
    return [
      process.env.DSH_COMPANION_VOICE_PYTHON || '',
      path.join(PACKAGE_ROOT, 'services', 'voice', '.venv', 'Scripts', 'python.exe'),
      'E:/codx_workspace/gpt-voice-playground/.venv/Scripts/python.exe',
      ...list,
    ].filter(Boolean);
  }
  return list;
}

/** 服务脚本默认位置：包内副本优先，其次项目目录里的实现。 */
function scriptCandidates(kind, configured) {
  const list = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim() && !list.includes(value.trim())) list.push(value.trim());
  };
  push(configured);
  if (kind === 'capture') {
    push(path.join(PACKAGE_ROOT, 'services', 'capture_server.py'));
    push('E:/dsh陪玩/capture-service/capture_server.py');
  } else {
    push(path.join(PACKAGE_ROOT, 'services', 'voice', 'voice_service.py'));
    push(path.join(PACKAGE_ROOT, 'services', 'voice_server.py'));
    push('E:/dsh陪玩/voice-service/voice_service.py');
  }
  return list;
}

function firstExisting(list) {
  return list.find((item) => item === 'python' || item === 'python3' || existsSync(item)) ?? '';
}

export function makeServices({ getConfig, log }) {
  /** @type {Map<string, {child: any, starting: Promise<any>|null, logStream: any, lastError: string|null, startedAt: number}>} */
  const running = new Map();

  function entry(kind) {
    if (!running.has(kind)) {
      running.set(kind, { child: null, starting: null, logStream: null, lastError: null, startedAt: 0, spawnedByUs: false });
    }
    return running.get(kind);
  }

  function serviceSpec(kind) {
    const config = getConfig();
    const runtime = kind === 'voice' ? installedVoiceRuntime() : null;
    const configuredScript = kind === 'capture' ? config.services.captureScript : config.services.voiceScript;
    const script = firstExisting([configuredScript, runtime?.script, ...scriptCandidates(kind, configuredScript)].filter(Boolean));
    const managed = Boolean(runtime && script === runtime.script);
    const availableVoices = managed ? modelFiles(runtime.models).voices.map(name => name.slice(0, -4)) : [];
    const python = managed
      ? firstExisting([config.services.voicePython, process.env.DSH_COMPANION_VOICE_PYTHON, runtime.python].filter(Boolean))
      : firstExisting(pythonCandidates(kind, kind === 'capture' ? config.services.capturePython : config.services.voicePython));
    const port = kind === 'capture'
      ? Number(new URL(config.services.captureUrl).port || 9124)
      : Number(new URL(config.services.voiceUrl).port || 9123);
    return { script, python, port, url: kind === 'capture' ? config.services.captureUrl : config.services.voiceUrl,
      rvc: managed ? runtime.rvc : null, voiceId: managed ? (availableVoices.includes(config.voice.voiceId) ? config.voice.voiceId : availableVoices[0]) : null,
      missingModels: managed && !process.env.RVC_HOME && !modelFiles(runtime.models).present };
  }

  /** 探服务健康（由调用方传入 fetcher，避免这里依赖 capture/voice 模块）。 */
  async function check(kind, probe) {
    const result = await probe();
    const state = entry(kind);
    if (result.ok) {
      state.lastError = null;
    } else {
      state.lastError = result.error ?? 'unreachable';
    }
    return result;
  }

  /**
   * 确保服务在跑：先探健康，不在就拉起来并轮询到就绪。
   * @param {'capture'|'voice'} kind
   * @param {() => Promise<{ok:boolean,error?:string}>} probe
   * @param {{timeoutMs?: number}} options
   */
  async function ensure(kind, probe, options = {}) {
    const timeoutMs = options.timeoutMs ?? (kind === 'voice' ? 90000 : 20000);
    const spec = serviceSpec(kind);
    const state = entry(kind);

    const now = await probe();
    if (now.ok) return { ok: true, already: true };

    if (spec.missingModels) {
      state.lastError = '语音增强环境已安装，请在设置的语音增强区域补齐模型后重启语音';
      return { ok: false, error: state.lastError };
    }

    if (!spec.script || !spec.python) {
      state.lastError = !spec.script ? '找不到服务脚本' : '找不到 Python 解释器';
      return { ok: false, error: state.lastError, script: spec.script, python: spec.python };
    }
    if (state.starting) return state.starting;

    state.starting = (async () => {
      await mkdir(SERVICES_DIR, { recursive: true });
      const logPath = path.join(SERVICES_DIR, `${kind}.log`);
      const logStream = createWriteStream(logPath, { flags: 'a' });
      state.logStream = logStream;
      const args = [spec.script, '--port', String(spec.port), '--host', '127.0.0.1'];
      if (kind === 'voice' && spec.voiceId) args.push('--voice', spec.voiceId);
      const env = {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
      };
      // 发行包的语音增强目录里自带一份 RVC 推理工程：告诉 voice_service 去哪里找
      const bundledRvc = spec.rvc || path.join(PACKAGE_ROOT, 'services', 'voice', 'rvc');
      if (kind === 'voice' && !env.RVC_HOME && existsSync(bundledRvc)) env.RVC_HOME = bundledRvc;
      // 告诉 voice_service 用哪个解释器拉 RVC worker（发行包里就是刚找到的 .venv python）
      if (kind === 'voice' && !env.RVC_PYTHON) env.RVC_PYTHON = spec.python;
      // 语音服务依赖装在我们自己目录里的包（edge-tts 之类）
      const pydeps = path.join(path.dirname(spec.script), 'pydeps');
      if (existsSync(pydeps)) {
        env.PYTHONPATH = env.PYTHONPATH ? `${pydeps}${path.delimiter}${env.PYTHONPATH}` : pydeps;
      }
      log.info(`拉起 ${kind} 服务：${spec.python} ${spec.script} --port ${spec.port}`);
      const child = spawn(spec.python, args, {
        cwd: path.dirname(spec.script),
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
      state.child = child;
      state.spawnedByUs = true;
      state.startedAt = Date.now();
      child.stdout?.on('data', (chunk) => logStream.write(chunk));
      child.stderr?.on('data', (chunk) => logStream.write(chunk));
      child.on('exit', (code, signal) => {
        state.child = null;
        try {
          logStream.end();
        } catch {
          // ignore
        }
        // 可能是「端口上已有同一个服务在跑」导致的正常退出（单实例锁）：探一下再决定怎么记录
        void probe().then((result) => {
          if (result.ok) {
            log.info(`${kind} 起动进程退出（code=${code}），但端口上已有实例在跑，沿用现有服务`);
            state.lastError = null;
          } else {
            log.warn(`${kind} 服务退出：code=${code} signal=${signal}`);
            state.lastError = `服务退出（code=${code}）`;
          }
        });
      });
      child.on('error', (error) => {
        state.lastError = errorText(error);
        log.warn(`${kind} 服务启动失败：${errorText(error)}`);
      });

      // 轮询就绪
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await sleep(500);
        const probeNow = await probe();
        if (probeNow.ok) {
          log.info(`${kind} 服务就绪（${Date.now() - state.startedAt}ms）`);
          return { ok: true, started: true, pid: child.pid };
        }
        if (state.child === null) break;
      }
      state.lastError = `服务在 ${timeoutMs}ms 内没有就绪（看日志：${logPath}）`;
      return { ok: false, error: state.lastError, logPath };
    })();

    try {
      return await state.starting;
    } finally {
      state.starting = null;
    }
  }

  /** 重启一个服务（面板按钮 / 改配置后用）。 */
  async function restart(kind, probe, options = {}) {
    await stop(kind);
    return ensure(kind, probe, options);
  }

  async function stop(kind) {
    const state = entry(kind);
    const child = state.child;
    if (!child) return { ok: true };
    try {
      child.kill();
    } catch {
      // ignore
    }
    // Windows 上 Python 子进程可能再套一层，最多等 3 秒
    for (let i = 0; i < 6; i += 1) {
      await sleep(500);
      if (state.child === null) break;
    }
    state.child = null;
    return { ok: true };
  }

  async function stopAll() {
    await Promise.all([...running.keys()].map((kind) => stop(kind)));
  }

  return { ensure, restart, stop, stopAll, serviceSpec };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
