import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.mjs';

export function voicePaths(baseDir = dataDir()) {
  const root = path.join(baseDir, 'voice');
  return { root, models: path.join(root, 'models'), runtimes: path.join(root, 'runtimes'),
    downloads: path.join(root, 'downloads'), active: path.join(root, 'active.json'),
    status: path.join(root, 'install-status.json'), lock: path.join(root, 'install.lock') };
}

/** 扫描 models/weights/ 下实际存在的声线文件（不限内置名字，任何 >1MB 的 .pth 都算）。 */
export function modelFiles(models) {
  const present = file => { try { return statSync(file).isFile() && statSync(file).size > 1024 * 1024; } catch { return false; } };
  let voices = [];
  try {
    voices = readdirSync(path.join(models, 'weights'))
      .filter(name => /\.pth$/i.test(name) && present(path.join(models, 'weights', name)))
      .sort((a, b) => a.localeCompare(b));
  } catch { /* optional */ }
  const hubert = present(path.join(models, 'hubert_base', 'pytorch_model.bin'));
  const rmvpe = present(path.join(models, 'rmvpe', 'rmvpe.pt'));
  return { hubert, rmvpe, voices, present: hubert && rmvpe && voices.length > 0 };
}

/** 已安装声线 ID（去掉 .pth 扩展名），供 /voices 与安装环境做交集。 */
export function installedVoiceIds(models) {
  return modelFiles(models).voices.map(name => name.replace(/\.pth$/i, ''));
}

export function installedVoiceRuntime(baseDir = dataDir()) {
  const paths = voicePaths(baseDir);
  try {
    const active = JSON.parse(readFileSync(paths.active, 'utf8'));
    if (!/^\d+\.\d+\.\d+-public\d+-[a-f0-9]{8}$/.test(active.slot)) return null;
    const root = path.join(paths.runtimes, active.slot);
    const ready = JSON.parse(readFileSync(path.join(root, 'ready.json'), 'utf8'));
    if (ready.version !== active.version || ready.ready !== true) return null;
    const result = { root, version: active.version, python: path.join(root, 'python', 'python.exe'),
      script: path.join(root, 'payload', 'voice_service.py'), rvc: path.join(root, 'payload', 'rvc'), models: paths.models };
    return existsSync(result.python) && existsSync(result.script) ? result : null;
  } catch { return null; }
}
