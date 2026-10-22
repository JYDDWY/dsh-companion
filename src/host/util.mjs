// util.mjs —— 插件内的小工具：日志、JSON 读写、时间格式化、安全 fetch。
import { appendFile, mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from './config.mjs';

/** 插件自己的日志文件：$DSH_HOME/dsh-companion/companion.log（超过 1MB 轮转一次）。 */
const LOG_MAX_BYTES = 1024 * 1024;

export function makeLogger(prefix = 'dsh-companion') {
  const file = path.join(dataDir(), 'companion.log');
  let lastSize = 0;
  const write = (level, message) => {
    const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
    // 不 await：日志永远不能拖慢/拖挂主流程
    void (async () => {
      try {
        await mkdir(dataDir(), { recursive: true });
        if (lastSize === 0) {
          try {
            lastSize = (await stat(file)).size;
          } catch {
            lastSize = 0;
          }
        }
        if (lastSize > LOG_MAX_BYTES) {
          await rename(file, `${file}.1`).catch(() => {});
          lastSize = 0;
        }
        await appendFile(file, line, 'utf8');
        lastSize += Buffer.byteLength(line);
      } catch {
        // 日志失败不影响业务
      }
    })();
  };
  return {
    file,
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
    log: (message) => write('info', message),
    tag: prefix,
  };
}

export function errorText(error) {
  if (error && typeof error === 'object') {
    if (error.message) return String(error.message);
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/** 带超时的 fetch（Node 24 全局 fetch 可用）。 */
export async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      const message = data?.error?.message ?? data?.message ?? text.slice(0, 200) ?? `HTTP ${response.status}`;
      throw new Error(`${response.status} ${message}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function readJsonFile(file, fallback) {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export async function writeJsonFile(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

export function formatTime(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 通配匹配：'PUBG*' / '*Hunter*' / 精确串；不区分大小写。 */
export function matchPattern(pattern, value) {
  const target = String(value ?? '').toLowerCase();
  const source = String(pattern ?? '').trim().toLowerCase();
  if (!source) return false;
  if (!source.includes('*')) return target.includes(source);
  const escaped = source
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  try {
    return new RegExp(`^.*${escaped}.*$`, 'i').test(target);
  } catch {
    return target.includes(source.replace(/\*/g, ''));
  }
}

export function truncate(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** 简单节流：同一 key 的调用在窗口内只执行一次，返回上一次的结果。 */
export function memoizeAsync(loader, ttlMs) {
  let at = 0;
  let value;
  let inflight = null;
  return async () => {
    const now = Date.now();
    if (now - at < ttlMs && value !== undefined) return value;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        value = await loader();
        at = Date.now();
        return value;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}
