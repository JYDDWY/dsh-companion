// subtitle.mjs —— 桌面字幕悬浮窗（像音乐软件歌词那样一直显示在桌面最上层）。
//
// 实现：插件宿主拉起一个独立的 WPF PowerShell 窗口（win/subtitle.ps1），
// 通过一个 JSON 状态文件通信；窗口每 150ms 轮询状态文件，显示最近一句台词，
// 支持拖动位置（位置会记住）、字号、字体、颜色、透明度。
//
// 为什么不用 Electron/BrowserWindow：插件活在 DSH 进程里，无法创建普通窗口；
// PowerShell + WPF 是 Windows 自带能力，零依赖，也不干扰游戏。
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './config.mjs';
import { errorText } from './util.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PS_SCRIPT = path.join(PACKAGE_ROOT, 'win', 'subtitle.ps1');
const DIR = path.join(dataDir(), 'subtitle');
const STATE_FILE = path.join(DIR, 'state.json');
const POSITION_FILE = path.join(DIR, 'position.json');

export function makeSubtitle({ getConfig, log }) {
  let child = null;
  let lastError = null;
  let lastShowAt = 0;
  let starting = false;

  function config() {
    return getConfig()?.subtitle ?? {};
  }

  function enabled() {
    return config().enabled === true;
  }

  function running() {
    return Boolean(child && child.exitCode === null && !child.killed);
  }

  async function ensureRunning() {
    if (!enabled()) return { ok: false, disabled: true };
    if (running()) return { ok: true, already: true };
    if (starting) return { ok: false, starting: true };
    starting = true;
    try {
      await mkdir(DIR, { recursive: true });
      try {
        await readFile(STATE_FILE, 'utf8');
      } catch {
        await writeFile(STATE_FILE, '{}', 'utf8');
      }
      const args = [
        '-NoProfile',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        PS_SCRIPT,
        '-StateFile',
        STATE_FILE,
        '-PositionFile',
        POSITION_FILE,
      ];
      child = execFile('powershell.exe', args, { windowsHide: true, timeout: 0 }, (error) => {
        if (error) {
          lastError = errorText(error).slice(0, 300);
          log?.warn?.(`字幕窗口退出：${lastError}`);
        }
        child = null;
      });
      child.on('error', (error) => {
        lastError = errorText(error).slice(0, 300);
        child = null;
      });
      log?.info?.('字幕悬浮窗已启动');
      return { ok: true, started: true };
    } catch (error) {
      lastError = errorText(error).slice(0, 300);
      log?.warn?.(`字幕窗口启动失败：${lastError}`);
      return { ok: false, error: lastError };
    } finally {
      starting = false;
    }
  }

  /** 把一句话写进字幕状态文件（窗口自己轮询显示）。 */
  async function show(text, meta = {}) {
    if (!enabled()) return { ok: false, disabled: true };
    const value = String(text ?? '').trim();
    if (!value) return { ok: false, empty: true };
    const cfg = config();
    try {
      await ensureRunning();
      await mkdir(DIR, { recursive: true });
      const payload = {
        text: value.slice(0, 300),
        at: Date.now(),
        ttlSec: Number(cfg.displaySec) > 0 ? Number(cfg.displaySec) : 8,
        fontSize: Number(cfg.fontSize) > 0 ? Number(cfg.fontSize) : 28,
        fontFamily: String(cfg.fontFamily || 'Microsoft YaHei'),
        color: String(cfg.color || '#ffffff'),
        bgOpacity: Number.isFinite(Number(cfg.bgOpacity)) ? Number(cfg.bgOpacity) : 0.45,
        opacity: Number.isFinite(Number(cfg.opacity)) ? Number(cfg.opacity) : 0.95,
        emotion: meta?.emotion ?? null,
      };
      await writeFile(STATE_FILE, JSON.stringify(payload), 'utf8');
      lastShowAt = Date.now();
      return { ok: true };
    } catch (error) {
      lastError = errorText(error).slice(0, 300);
      log?.warn?.(`字幕更新失败：${lastError}`);
      return { ok: false, error: lastError };
    }
  }

  async function clear() {
    try {
      await mkdir(DIR, { recursive: true });
      await writeFile(STATE_FILE, JSON.stringify({ text: '', at: Date.now() }), 'utf8');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  function stop() {
    if (child) {
      try {
        child.kill();
      } catch {
        // ignore
      }
      child = null;
      log?.info?.('字幕悬浮窗已关闭');
    }
  }

  /** 配置变化时调用：关了就停，开了就重启（让新窗口读新样式）。 */
  async function applyConfig() {
    stop();
    if (enabled()) {
      const result = await ensureRunning();
      return result;
    }
    return { ok: true, disabled: true };
  }

  function status() {
    return {
      enabled: enabled(),
      running: running(),
      lastError,
      lastShowAt: lastShowAt || null,
      stateFile: STATE_FILE,
      positionFile: POSITION_FILE,
    };
  }

  return { ensureRunning, show, clear, stop, applyConfig, status, STATE_FILE, POSITION_FILE };
}
