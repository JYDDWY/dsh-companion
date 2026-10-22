// capture.mjs —— 「看屏幕」的数据来源。
//
// 首选本地截图服务（capture-service，127.0.0.1:9124，常驻、多帧连拍、低延迟）。
// 服务不可用时退回包内 PowerShell 助手（游戏窗口探测 + 一次进程连拍 N 帧），
// 这样「只装了 DSH、没有 Python」的朋友机器也能用，只是每轮多花约 0.5-1 秒。
//
// 截图帧写进 $DSH_HOME/dsh-companion/frames/<tickId>/，供：
//   - 插件把图喂给模型（附件服务）
//   - 侧栏面板显示缩略图（通过插件的 /frame 路由）
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './config.mjs';
import { errorText, fetchJson } from './util.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PS_HELPER = path.join(PACKAGE_ROOT, 'win', 'helper-win.ps1');

export const FRAMES_DIR = path.join(dataDir(), 'frames');

/** 帧文件哈希（用来判断画面有没有变化）。 */
export function hashFile(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function makeCapture({ getConfig, log }) {
  const serviceUrl = () => getConfig().services.captureUrl;
  /** 截图服务不可用后，先别每到一轮都去连它（朋友机器上可能根本没装 Python 服务）。 */
  let serviceDownUntil = 0;
  const serviceAvailable = () => Date.now() >= serviceDownUntil;
  const markServiceDown = (error) => {
    serviceDownUntil = Date.now() + 60000;
    log?.warn?.(`截图服务不可用，改用 PowerShell 兜底（60 秒内不再尝试服务）：${error}`);
  };

  /** 服务健康检查。 */
  async function health(timeoutMs = 3000) {
    try {
      const info = await fetchJson(`${serviceUrl()}/health`, {}, timeoutMs);
      if (!info?.ok) markServiceDown('健康检查失败');
      return { ok: Boolean(info?.ok), info };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  /** 只看前台窗口，不截图。 */
  async function window() {
    if (serviceAvailable()) {
      try {
        const info = await fetchJson(`${serviceUrl()}/window`, {}, 4000);
        if (info && info.ok) {
          const win = info.window ?? info;
          // 统一字段：截图服务用 isFullscreen，这里补成插件内部通用的 fullscreen；
          // idleSec 在 /window 顶层，也一并并进窗口对象（引擎只消费一个对象）。
          return {
            available: true,
            ...win,
            fullscreen: Boolean(win.isFullscreen ?? win.fullscreen),
            idleSec: Number(info.idleSec ?? win.idleSec ?? 0) || 0,
            screen: info.screen ?? null,
            source: 'service',
          };
        }
      } catch (error) {
        markServiceDown(errorText(error));
      }
    }
    const fallback = await psDetect();
    return {
      ...fallback,
      fullscreen: Boolean(fallback.fullscreen ?? fallback.isFullscreen),
      idleSec: Number(fallback.idleSec) || 0,
      source: 'ps',
    };
  }

  /**
   * 连拍一帧组。
   * @param {{tickId: number, windowInfo?: object, preferWindow?: boolean}} options
   * @returns {Promise<{ok:boolean, frames:Array<{path:string,width:number,height:number,bytes:number,hash:string,capturedAt:number,mediaType:string}>, window:object, black?:boolean, source:'service'|'ps'|'none', error?:string}>}
   */
  async function grab({ tickId, windowInfo, preferWindow }) {
    const config = getConfig();
    const count = config.capture.frameCount;
    const intervalMs = config.capture.frameIntervalMs;
    const maxLongEdge = config.capture.maxLongEdge;
    const quality = config.capture.jpegQuality;
    const dir = path.join(FRAMES_DIR, String(tickId));
    await mkdir(dir, { recursive: true });

    // 1) 本地截图服务（推荐）
    //    全屏游戏优先用 mode=window&exe=<process>（PrintWindow 路线）：
    //    DWM 全屏优化下桌面 BitBlt 可能截到错误画面，而且黑帧检测抓不出来（截图服务实测）。
    const onlyWindow = config.capture.fullScreen === false;
    if (serviceAvailable()) {
      const processName = String(windowInfo?.process ?? '').trim();
      const useWindowMode = Boolean(processName) && (preferWindow === true || onlyWindow);
      const modes = [];
      if (useWindowMode) modes.push({ mode: 'window', exe: processName });
      if (onlyWindow) {
        if (modes.length === 0) {
          return { ok: false, frames: [], window: {}, source: 'none', error: '仅窗口截图需要前台窗口进程名，但没有探测到' };
        }
      } else {
        // 明确选择「整屏」时才允许桌面兜底；仅窗口模式不能偷偷扩大到整桌面
        modes.push({ mode: 'desktop' });
      }
      try {
        let result = null;
        for (const attempt of modes) {
          const query = new URLSearchParams({
            count: String(count),
            intervalMs: String(intervalMs),
            maxLongEdge: String(maxLongEdge),
            quality: String(quality),
            outDir: dir,
            mode: attempt.mode,
            ...(attempt.exe ? { exe: attempt.exe } : {}),
          });
          try {
            const candidate = await fetchJson(`${serviceUrl()}/capture?${query.toString()}`, {}, 30000);
            if (candidate?.ok && Array.isArray(candidate.frames) && candidate.frames.length > 0 && !candidate.black) {
              result = candidate;
              break;
            }
            if (!result) result = candidate;
          } catch (error) {
            // 窗口那条路失败（窗口找不到/最小化）就走下一条
            log?.warn?.(`截图 ${attempt.mode} 模式失败：${errorText(error)}`);
          }
        }
        if (result?.ok && Array.isArray(result.frames) && result.frames.length > 0) {
          const frames = [];
          for (const [index, frame] of result.frames.entries()) {
            let filePath = String(frame.path ?? '');
            if (!filePath || !existsSync(filePath)) continue;
            // 服务给的文件名带时间戳；统一改名为 frame-<index>.jpg，面板的 /frame 路由靠这个名字找图
            const target = path.join(dir, `frame-${index}.jpg`);
            if (path.resolve(filePath) !== path.resolve(target)) {
              try {
                await rename(filePath, target);
                filePath = target;
              } catch {
                // 改名失败就继续用原路径（路由还有兜底候选）
              }
            }
            const buffer = await readFile(filePath);
            frames.push({
              path: filePath,
              width: Number(frame.width) || 0,
              height: Number(frame.height) || 0,
              bytes: buffer.length,
              hash: hashFile(buffer),
              capturedAt: Number(frame.capturedAt) || Date.now(),
              index,
              mediaType: 'image/jpeg',
            });
          }
          if (frames.length > 0) {
            return {
              ok: true,
              frames,
              window: result.window ?? {},
              black: Boolean(result.black),
              source: 'service',
              elapsedMs: Number(result.elapsedMs) || 0,
            };
          }
        }
        log?.warn?.(`截图服务返回了空帧组：${JSON.stringify(result).slice(0, 300)}`);
        markServiceDown('空帧组');
      } catch (error) {
        markServiceDown(error);
      }
    }

    // 2) PowerShell 兜底（一个进程连拍 N 帧 + JPEG，零依赖）
    try {
      const detection = await psDetect();
      const hwnd = onlyWindow ? Number(windowInfo?.hwnd || detection?.hwnd || 0) : 0;
      if (onlyWindow && !hwnd) {
        return { ok: false, frames: [], window: detection, source: 'none', error: '仅窗口截图需要窗口句柄，但没探测到前台窗口' };
      }
      const frames = await psCapture({ dir, count, intervalMs, maxLongEdge, quality, hwnd });
      if (frames.length === 0) throw new Error('PowerShell 截图没有产出文件');
      return { ok: true, frames, window: detection, black: false, source: 'ps' };
    } catch (error) {
      return { ok: false, frames: [], window: {}, source: 'none', error: errorText(error) };
    }
  }

  return { health, window, grab, isServiceAvailable: serviceAvailable };
}

/** 跑 PowerShell 助手（-File 方式，避免命令行解析吃掉脚本内容）。 */
function runPs(args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', PS_HELPER, ...args],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          error.stderrText = String(stderr ?? '');
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

let psDetectCache = { at: 0, value: null };

/** PowerShell 兜底：探前台窗口（缓存 1 秒，连拍/每轮里不必重复跑）。 */
async function psDetect() {
  if (Date.now() - psDetectCache.at < 1000 && psDetectCache.value) return psDetectCache.value;
  try {
    const { stdout } = await runPs(['-Mode', 'detect'], 15000);
    const line = stdout.trim().split(/\r?\n/).pop() ?? '';
    const parsed = line ? JSON.parse(line) : { available: false, error: 'no output' };
    const value = parsed?.available ? parsed : { available: false, ...parsed };
    psDetectCache = { at: Date.now(), value };
    return value;
  } catch (error) {
    const value = { available: false, error: errorText(error) };
    psDetectCache = { at: Date.now(), value };
    return value;
  }
}

/** PowerShell 兜底：一个进程里连拍 count 帧，返回帧列表。 */
async function psCapture({ dir, count, intervalMs, maxLongEdge, quality, hwnd = 0 }) {
  const metaPath = path.join(dir, 'frames.json');
  await runPs(
    [
      '-Mode', 'burst',
      '-OutDir', dir,
      '-Out', metaPath,
      '-Count', String(count),
      '-IntervalMs', String(Math.max(0, Math.round(intervalMs))),
      '-MaxLongEdge', String(maxLongEdge),
      '-Quality', String(quality),
      '-Hwnd', String(Number(hwnd) || 0),
    ],
    Math.max(30000, 8000 + count * (intervalMs + 1500)),
  );
  let meta = null;
  try {
    meta = JSON.parse(await readFile(metaPath, 'utf8'));
  } catch {
    meta = null;
  }
  const rows = Array.isArray(meta?.frames) ? meta.frames : [];
  const frames = [];
  for (const [index, row] of rows.entries()) {
    const filePath = String(row?.path ?? '');
    if (!filePath || !existsSync(filePath)) continue;
    const buffer = await readFile(filePath);
    if (buffer.length === 0) continue;
    frames.push({
      path: filePath,
      width: Number(row.width) || 0,
      height: Number(row.height) || 0,
      bytes: buffer.length,
      hash: hashFile(buffer),
      capturedAt: Number(row.capturedAt) || Date.now(),
      index,
      mediaType: 'image/jpeg',
    });
  }
  return frames;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 清掉过旧的帧目录（保留最近 keep 个 tick）。 */
/**
 * 自动清理截图缓存：
 *   - keep：最多保留最近多少轮（默认 20，面板可调）
 *   - maxBytes：总占用上限（默认 0 = 不限）
 *   - maxAgeMs：超过这个时间的轮次删掉（默认 0 = 不限）
 * 面板缩略图只用到最近的历史；删旧帧不影响新观察。
 */
export async function pruneFrames({ keep = 20, maxBytes = 0, maxAgeMs = 0, protect = [] } = {}) {
  const result = { removed: 0, kept: 0, bytes: 0, removedBytes: 0 };
  try {
    const entries = await readdir(FRAMES_DIR, { withFileTypes: true });
    const dirs = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const dir = path.join(FRAMES_DIR, entry.name);
      let bytes = 0;
      let mtime = 0;
      try {
        for (const file of await readdir(dir)) {
          const info = await statFile(path.join(dir, file));
          bytes += info.size;
          mtime = Math.max(mtime, info.mtimeMs);
        }
      } catch {
        continue;
      }
      dirs.push({ name: entry.name, dir, bytes, mtime });
    }
    // 按文件 mtime 排序（而不是目录名数字）：重启后 tickId 可能小于旧编号，
    // 按数字倒序会把刚拍的新图当成「最旧」删掉。
    dirs.sort((a, b) => (b.mtime - a.mtime) || (Number(b.name) - Number(a.name)));
    const now = Date.now();
    const protectedNames = new Set((Array.isArray(protect) ? protect : []).map((name) => String(name)));
    for (let index = 0; index < dirs.length; index += 1) {
      const item = dirs[index];
      if (protectedNames.has(item.name)) {
        // 正在写入的轮次目录不能删（F01 并发清理）
        result.kept += 1;
        result.bytes += item.bytes;
        continue;
      }
      const tooMany = index >= Math.max(0, Number(keep) || 0);
      const tooOld = maxAgeMs > 0 && now - (item.mtime || 0) > maxAgeMs;
      const tooBig = maxBytes > 0 && result.bytes + item.bytes > maxBytes;
      if (tooMany || tooOld || tooBig) {
        await rm(item.dir, { recursive: true, force: true });
        result.removed += 1;
        result.removedBytes += item.bytes;
      } else {
        result.kept += 1;
        result.bytes += item.bytes;
      }
    }
  } catch {
    // 目录不存在等：当作空闲
  }
  return result;
}

async function statFile(file) {
  const { stat } = await import('node:fs/promises');
  return stat(file);
}

/** 当前截图缓存占用（给面板显示）。 */
export async function framesUsage() {
  let dirs = 0;
  let bytes = 0;
  try {
    const entries = await readdir(FRAMES_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      dirs += 1;
      const dir = path.join(FRAMES_DIR, entry.name);
      try {
        for (const file of await readdir(dir)) {
          try {
            bytes += (await statFile(path.join(dir, file))).size;
          } catch {
            // 忽略
          }
        }
      } catch {
        // 忽略
      }
    }
  } catch {
    // 忽略
  }
  return { dirs, bytes, mb: Math.round((bytes / 1024 / 1024) * 10) / 10 };
}

/** 读一帧的字节（给附件服务用）。 */
export async function readFrame(frame) {
  return readFile(frame.path);
}
