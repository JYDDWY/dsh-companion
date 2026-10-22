// voice.mjs —— 台词播报。两条后端，按可用性自动选：
//
//   1) 本地 voice-service（http://127.0.0.1:9123）：edge-tts → RVC 变声 → 扬声器。
//      音色最好（本机 11 个动漫声线），但需要 Python + torch + RVC 环境；
//      只有装了「RVC 语音增强包」的机器才有。
//   2) Windows 系统语音（SAPI，通过 PowerShell）：零依赖、离线可用。
//      音色一般，但「只装了 DSH」的朋友机器也能开口——这是发行包的兜底。
//
// 选择逻辑（voice.backend）：
//   auto（默认） 先试服务；服务不可用/报错就退到 SAPI，并记住 60 秒别再试服务
//   service      只用 RVC 语音服务（服务坏了就报错，不降级）
//   sapi         只用系统语音（不想动 RVC 时用）
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './config.mjs';
import { errorText, fetchJson } from './util.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAPI_SCRIPT = path.join(PACKAGE_ROOT, 'win', 'sapi-speak.ps1');
const TTS_DIR = path.join(dataDir(), 'tts');

/** SAPI 语速：config.voice.speed(0.5-2) → SAPI Rate(-10..10)。 */
function sapiRate(speed) {
  const value = Number(speed) || 1;
  return Math.max(-10, Math.min(10, Math.round((value - 1) * 10)));
}

export function makeVoice({ getConfig, log }) {
  const serviceUrl = () => getConfig().services.voiceUrl;
  let voiceCache = { at: 0, value: null };
  /** 服务不可用后的冷却时间：省得每句话都等一次连接失败。 */
  let serviceDownUntil = 0;
  const serviceAvailable = () => Date.now() >= serviceDownUntil;
  const markServiceDown = (error) => {
    const wasUp = serviceAvailable();
    serviceDownUntil = Date.now() + 60000;
    if (wasUp) log?.warn?.(`语音服务不可用，改用 Windows 系统语音：${error}`);
  };

  /** SAPI 播放队列：同一时间只播一句，按顺序排队。 */
  let sapiChain = Promise.resolve();
  let sapiChild = null;
  let lastBackend = null;
  let lastError = null;

  async function health(timeoutMs = 3000) {
    try {
      const info = await fetchJson(`${serviceUrl()}/health`, {}, timeoutMs);
      if (info?.ok) serviceDownUntil = 0;
      return { ok: Boolean(info?.ok), info };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  async function listVoices({ force = false } = {}) {
    if (!force && voiceCache.value && Date.now() - voiceCache.at < 60000) return voiceCache.value;
    try {
      const info = await fetchJson(`${serviceUrl()}/voices`, {}, 5000);
      const voices = Array.isArray(info?.voices) ? info.voices : Array.isArray(info) ? info : [];
      voiceCache = { at: Date.now(), value: voices };
      return voices;
    } catch {
      return [];
    }
  }

  /** 用 Windows SAPI 念一句（阻塞到念完；句与句之间串行）。返回真实成功/失败。 */
  function sapiSpeak(text, { rate = 0, volume = 1 } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      void (async () => {
        try {
          await mkdir(TTS_DIR, { recursive: true });
          const textFile = path.join(TTS_DIR, `sapi-${Date.now()}-${Math.round(Math.random() * 1e6)}.txt`);
          await writeFile(textFile, text, 'utf8');
          const rawVolume = Number(volume);
          // 注意：0 是合法音量（静音），不能写成 `Number(volume) || 1`
          const sapiVolume = Math.max(0, Math.min(100, Math.round((Number.isFinite(rawVolume) ? rawVolume : 1) * 100)));
          const args = [
            '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
            '-File', SAPI_SCRIPT,
            '-TextFile', textFile,
            '-Rate', String(rate),
            '-Volume', String(sapiVolume),
          ];
          const child = execFile('powershell.exe', args, { windowsHide: true, timeout: 120000 }, (error, stdout, stderr) => {
            if (sapiChild === child) sapiChild = null;
            if (error) {
              lastError = `${errorText(error)}${stderr ? ` ${String(stderr).trim().slice(0, 200)}` : ''}`;
              finish({ ok: false, error: lastError });
            } else {
              finish({ ok: true });
            }
          });
          sapiChild = child;
          child.on('error', (error) => {
            if (sapiChild === child) sapiChild = null;
            lastError = errorText(error);
            finish({ ok: false, error: lastError });
          });
        } catch (error) {
          lastError = errorText(error);
          finish({ ok: false, error: lastError });
        }
      })();
    });
  }

  /**
   * 说一句话。
   * @param {string} text 台词（已消毒）
   * @param {{reason?: string}} meta 仅用于日志
   * @returns {Promise<{ok:boolean, skipped?:boolean, backend?:'service'|'sapi', id?:string, clipped?:boolean, error?:string}>}
   */
  async function speak(text, meta = {}) {
    const config = getConfig();
    const clean = String(text ?? '').trim();
    if (!config.voice.enabled || !clean) return { ok: true, skipped: true };
    const clipped = clean.length > config.voice.maxChars ? `${clean.slice(0, config.voice.maxChars)}…` : clean;
    const backend = config.voice.backend ?? 'auto';

    // 1) RVC 语音服务
    if (backend !== 'sapi' && serviceAvailable()) {
      try {
        const result = await fetchJson(
          `${serviceUrl()}/speak`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              text: clipped,
              voiceId: config.voice.voiceId,
              pitch: config.voice.pitch,
              speed: config.voice.speed,
              volume: config.voice.volume,
              ...(config.voice.emotionEnabled && meta.emotion ? { emotion: meta.emotion } : {}),
            }),
          },
          10000,
        );
        if (!result?.ok) throw new Error(result?.error?.message ?? result?.message ?? '语音服务拒绝了这次请求');
        lastBackend = 'service';
        lastError = null;
        return { ok: true, id: result.id, clipped: clipped !== clean, backend: 'service', emotion: meta.emotion ?? null };
      } catch (error) {
        markServiceDown(errorText(error));
        if (backend === 'service') {
          lastError = errorText(error);
          return { ok: false, error: errorText(error) };
        }
      }
    }

    // 2) Windows 系统语音（离线兜底）
    if (backend === 'auto' || backend === 'sapi') {
      const rate = sapiRate(config.voice.speed);
      const job = sapiChain.then(() => sapiSpeak(clipped, { rate, volume: config.voice.volume }));
      sapiChain = job.catch(() => {});
      const sapiResult = await job;
      lastBackend = 'sapi';
      if (!sapiResult?.ok) {
        return { ok: false, error: sapiResult?.error ?? '系统语音播放失败', backend: 'sapi', clipped: clipped !== clean };
      }
      lastError = null;
      return { ok: true, clipped: clipped !== clean, backend: 'sapi', emotion: meta.emotion ?? null };
    }

    return { ok: false, error: lastError ?? '没有可用的语音后端' };
  }

  /** 停止当前朗读（服务端队列 + 正在播放的 SAPI 进程）。 */
  async function stop() {
    if (sapiChild) {
      try {
        sapiChild.kill();
      } catch {
        // ignore
      }
      sapiChild = null;
    }
    try {
      await fetchJson(`${serviceUrl()}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, 5000);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  async function status() {
    try {
      return await fetchJson(`${serviceUrl()}/status`, {}, 3000);
    } catch {
      return null;
    }
  }

  /** 面板/状态用的后端信息。 */
  function getBackendInfo() {
    const config = getConfig();
    return {
      backend: lastBackend ?? (config.voice.backend === 'sapi' ? 'sapi' : 'unknown'),
      configured: config.voice.backend ?? 'auto',
      serviceAvailable: serviceAvailable(),
      lastError,
    };
  }

  return { health, listVoices, speak, stop, status, getBackendInfo, isServiceAvailable: serviceAvailable };
}
