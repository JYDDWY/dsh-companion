// store.mjs —— 历史与统计的落盘（重启后还认得之前聊过什么、玩过什么）。
//
// 历史是有上限的：只保留最近 200 条，文件体积很小；帧文件由 capture.pruneFrames 清理。
import path from 'node:path';
import { dataDir } from './config.mjs';
import { readJsonFile, writeJsonFile } from './util.mjs';

const HISTORY_FILE = path.join(dataDir(), 'history.json');
const MAX_HISTORY = 200;

export async function loadHistory() {
  const data = await readJsonFile(HISTORY_FILE, { entries: [], stats: null });
  const entries = Array.isArray(data?.entries) ? data.entries.slice(-MAX_HISTORY) : [];
  return {
    entries,
    stats: data?.stats && typeof data.stats === 'object' ? data.stats : null,
    summary: typeof data?.summary === 'string' ? data.summary : '',
    nextId: entries.reduce((max, entry) => Math.max(max, Number(entry.id) || 0), 0) + 1,
  };
}

export function makeHistoryWriter(getSnapshot) {
  let timer = null;
  let writing = false;
  const flush = async () => {
    if (writing) return;
    writing = true;
    try {
      const snapshot = getSnapshot();
      await writeJsonFile(HISTORY_FILE, snapshot);
    } catch {
      // 落盘失败不影响运行
    } finally {
      writing = false;
    }
  };
  return {
    schedule() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, 800);
    },
    async flushNow() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await flush();
    },
  };
}

export function trimHistory(entries, limit = MAX_HISTORY) {
  if (entries.length <= limit) return entries;
  return entries.slice(entries.length - limit);
}
