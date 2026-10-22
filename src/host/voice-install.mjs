import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, open, readFile, writeFile, unlink, copyFile, readdir, symlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { dataDir } from './config.mjs';
import { writeJsonFile } from './util.mjs';
import { childPath, extractTarGz } from './safe-tar.mjs';
import { installedVoiceRuntime, modelFiles, voicePaths } from './voice-runtime.mjs';

const RELEASE = JSON.parse(readFileSync(new URL('./voice-runtime-release.json', import.meta.url), 'utf8'));
const PYPI = 'https://pypi.tuna.tsinghua.edu.cn/simple';
const PYPI_BACKUP = 'https://mirrors.aliyun.com/pypi/simple/';
const TORCH = 'https://mirror.sjtu.edu.cn/pytorch-wheels/cpu/torch-2.9.1%2Bcpu-cp312-cp312-win_amd64.whl#sha256=a4e06b4f441675d26b462123c8a83e77c55f1ec8ebc081203be2db1ea8054add';
const AUDIO = 'https://mirror.sjtu.edu.cn/pytorch-wheels/cpu/torchaudio-2.9.1%2Bcpu-cp312-cp312-win_amd64.whl#sha256=53dd3155b794019e8de2dc49d044f410e6bce081d23a0e6548c156f37dfc9d0d';

function cancelled() { return Object.assign(new Error('安装已取消'), { code: 'ABORT_ERR' }); }
function checkAbort(signal) { if (signal.aborted) throw cancelled(); }

export async function downloadRuntime(release, { signal, progress }) {
  let url = new URL(release.url);
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmmirror.com') throw new Error('增强组件下载源不符合要求');
  const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(15 * 60 * 1000)]);
  let response;
  for (let redirects = 0; redirects <= 3; redirects++) {
    response = await fetch(url, { signal: downloadSignal, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects === 3) throw new Error('国内镜像下载跳转异常');
    url = new URL(location, url);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !['registry.npmmirror.com', 'cdn.npmmirror.com'].includes(url.hostname)) throw new Error('国内镜像跳转到了未认可的下载源');
  }
  if (!response.ok) throw new Error(`国内镜像下载失败（HTTP ${response.status}），请稍后重试`);
  const total = Number(response.headers.get('content-length') || 0);
  if (total > release.maxBytes) throw new Error('增强组件大小超出预期');
  const chunks = [];
  let downloaded = 0;
  for await (const chunk of response.body) {
    checkAbort(signal);
    downloaded += chunk.length;
    if (downloaded > release.maxBytes) throw new Error('增强组件大小超出预期');
    chunks.push(chunk);
    progress(downloaded, total);
  }
  const bytes = Buffer.concat(chunks);
  if (createHash('sha512').update(bytes).digest('hex') !== release.sha512) throw new Error('增强组件校验失败，请重新下载');
  return bytes;
}

export function runInstallerProcess(executable, args, { cwd, signal, line, timeoutMs = 45 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    checkAbort(signal);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PIP_|PYTHONHOME$|PYTHONPATH$)/i.test(key)));
    Object.assign(env, { PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
      PIP_CONFIG_FILE: 'NUL', PIP_DISABLE_PIP_VERSION_CHECK: '1' });
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => { try { child.kill(); } catch { /* exited */ } });
      } else { try { child.kill('SIGTERM'); } catch { /* exited */ } }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal.addEventListener('abort', stop, { once: true });
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8');
      let pending = '';
      stream.on('data', chunk => {
        pending += decoder.write(chunk);
        const lines = pending.split(/[\r\n]+/); pending = lines.pop() || '';
        for (const value of lines) if (value.trim()) line(value);
      });
      stream.on('end', () => { const rest = pending + decoder.end(); if (rest.trim()) line(rest); });
    }
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => {
      cleanup();
      if (signal.aborted) return reject(cancelled());
      if (timedOut) return reject(new Error('依赖安装超时，请检查网络后重试'));
      if (code !== 0) return reject(new Error(`安装程序退出码 ${code}；详情见安装日志`));
      resolve();
    });
  });
}

async function copyModelDefaults(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const target = childPath(destination, entry.name);
    if (entry.isDirectory()) await copyModelDefaults(path.join(source, entry.name), target);
    else if (entry.isFile()) {
      try { await copyFile(path.join(source, entry.name), target, 1); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    } else throw new Error('模型默认配置中包含不支持的链接');
  }
}

export function makeVoiceInstaller({ log, onReady = async () => {}, baseDir = dataDir(), release = RELEASE,
  download = downloadRuntime, run = runInstallerProcess, extract = extractTarGz,
  platform = process.platform, arch = process.arch } = {}) {
  const paths = voicePaths(baseDir);
  const supported = platform === 'win32' && arch === 'x64';
  let job = null, controller = null, task = null, disposed = false, writes = Promise.resolve(), lastSave = 0;
  const line = value => {
    if (!job) return;
    job.logs.push(String(value).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').slice(0, 1200));
    job.logs = job.logs.slice(-80);
    if (Date.now() - lastSave > 1500) save();
  };
  function save() {
    lastSave = Date.now();
    const snapshot = JSON.parse(JSON.stringify(job));
    writes = writes.then(() => writeJsonFile(paths.status, snapshot)).catch(error => log?.warn?.(`保存语音安装状态失败：${error.message}`));
  }
  function phase(value, message) { job.phase = value; job.message = message; save(); }
  async function status() {
    let last = job;
    if (!last) {
      try {
        last = JSON.parse(await readFile(paths.status, 'utf8'));
        if (last.running) {
          let alive = true;
          try { process.kill(last.pid, 0); } catch { alive = false; }
          if (!alive || last.pid === process.pid) last = { ...last, running: false, phase: 'interrupted', message: '上次安装已中断，可以重试' };
        }
      } catch { /* first use */ }
    }
    const runtime = installedVoiceRuntime(baseDir);
    return { ok: true, supported, mode: 'cpu', version: release.version, installedVersion: runtime?.version || null,
      runtimeReady: Boolean(runtime), models: modelFiles(paths.models), modelDir: paths.models,
      job: last ? { ...last, logs: (last.logs || []).slice(-40) } : null };
  }
  async function lock(id) {
    await mkdir(paths.root, { recursive: true });
    try {
      const existing = JSON.parse(await readFile(paths.lock, 'utf8'));
      let alive = true;
      try { process.kill(existing.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('另一个 DSH 进程正在安装语音增强，请等待它完成');
      await unlink(paths.lock);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const file = await open(paths.lock, 'wx');
    await file.writeFile(JSON.stringify({ pid: process.pid, id }));
    await file.close();
  }
  async function unlock(id) {
    try { if (JSON.parse(await readFile(paths.lock, 'utf8')).id === id) await unlink(paths.lock); }
    catch (error) { if (error.code !== 'ENOENT') log?.warn?.(`安装锁清理失败：${error.message}`); }
  }
  async function install(signal) {
    phase('downloading', '正在从国内镜像下载增强组件');
    const bytes = await download(release, { signal, progress: (downloaded, total) => {
      job.downloaded = downloaded; job.total = total;
      if (Date.now() - lastSave > 1500) save();
    } });
    checkAbort(signal);
    phase('extracting', '正在准备独立运行环境');
    const slot = `${release.version}-${randomUUID().slice(0, 8)}`;
    const root = childPath(paths.runtimes, slot);
    await mkdir(root, { recursive: true });
    await extract(bytes, root, { prefix: 'package/' });
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const runtime = JSON.parse(await readFile(path.join(root, 'runtime.json'), 'utf8'));
    if (manifest.name !== release.name || manifest.version !== release.version || runtime.version !== release.version) throw new Error('增强组件版本不匹配');
    const pythonArchive = await readFile(childPath(root, runtime.pythonArchive));
    if (createHash('sha256').update(pythonArchive).digest('hex') !== runtime.pythonSha256) throw new Error('独立 Python 校验失败');
    checkAbort(signal);
    await extract(pythonArchive, path.join(root, 'python'), { prefix: 'python/' });
    await copyModelDefaults(path.join(root, 'model-defaults'), paths.models);
    for (const folder of ['hubert_base', 'rmvpe', 'weights', 'indices']) await mkdir(path.join(paths.models, folder), { recursive: true });
    const assets = path.join(root, 'payload', 'rvc', 'assets');
    await symlink(await realpath(paths.models), assets, 'junction');
    const python = path.join(root, 'python', 'python.exe');
    const payload = path.join(root, 'payload');
    const options = { cwd: payload, signal, line };
    phase('python', '正在检查独立 Python');
    await run(python, ['-I', '-X', 'utf8', '-c', `import sys,pathlib;assert sys.version_info[:2]==(3,12);assert pathlib.Path(sys.prefix).resolve()==pathlib.Path(${JSON.stringify(path.join(root, 'python'))}).resolve();import pip;print(sys.version)`], options);
    checkAbort(signal);
    phase('torch', '正在从国内镜像安装 CPU 语音依赖，可能需要几分钟');
    const pip = ['-I', '-X', 'utf8', '-m', 'pip', 'install', '--index-url', PYPI, '--constraint', path.join(payload, 'requirements-rvc.txt'), '--only-binary=:all:', '--no-user', '--timeout', '30', '--retries', '3', '--cache-dir', path.join(paths.downloads, 'pip'), '--disable-pip-version-check', '--no-warn-script-location'];
    async function pipInstall(packages) {
      try { await run(python, [...pip, ...packages], options); }
      catch (error) {
        checkAbort(signal);
        line('当前依赖源安装失败，自动尝试另一个国内镜像');
        await run(python, [...pip.map(value => value === PYPI ? PYPI_BACKUP : value), ...packages], options);
      }
    }
    await pipInstall([TORCH, AUDIO]);
    checkAbort(signal);
    phase('dependencies', '正在安装其余语音依赖');
    await pipInstall(['-r', path.join(payload, 'requirements-rvc.txt')]);
    checkAbort(signal);
    phase('verifying', '正在验证语音环境');
    await run(python, ['-I', '-X', 'utf8', '-c', `import os,sys;os.chdir(${JSON.stringify(path.join(payload, 'rvc'))});sys.path.insert(0,${JSON.stringify(path.join(payload, 'pydeps'))});sys.path.insert(0,${JSON.stringify(path.join(payload, 'rvc'))});import torch,torchaudio,sounddevice,librosa,faiss,transformers,edge_tts,av;from infer.hubert import load_hubert_model;from infer.rmvpe import RMVPE;from infer.vc.modules import VC;print('VOICE_ENVIRONMENT_OK',torch.__version__)`], options);
    checkAbort(signal);
    phase('activating', '正在接入陪玩插件');
    await writeJsonFile(path.join(root, 'ready.json'), { ready: true, version: release.version, mode: 'cpu' });
    await writeJsonFile(paths.active, { slot, version: release.version, mode: 'cpu' });
    phase('complete', modelFiles(paths.models).present ? '增强环境安装完成，请重启语音并试听' : '增强环境安装完成，接下来请按说明下载模型');
    void Promise.resolve().then(() => onReady({ modelsPresent: modelFiles(paths.models).present })).catch(error => log?.warn?.(`语音启动检查失败：${error.message}`));
  }
  async function start({ confirmDownload = false } = {}) {
    if (disposed) throw new Error('插件正在退出');
    if (!supported) throw new Error('一键安装目前支持 Windows x64');
    if (confirmDownload !== true) throw new Error('请先确认下载并安装语音运行环境');
    if (!/^[a-f0-9]{128}$/.test(release.sha512)) throw new Error('增强组件尚未配置完成');
    if (job?.running) return status();
    const id = randomUUID();
    job = { id, pid: process.pid, running: true, phase: 'preparing', message: '准备安装', logs: [], startedAt: Date.now(), downloaded: 0, total: 0 };
    controller = new AbortController();
    try { await lock(id); }
    catch (error) { job.running = false; job.phase = 'failed'; job.message = error.message; save(); throw error; }
    save();
    task = install(controller.signal).catch(error => {
      job.phase = controller.signal.aborted ? 'cancelled' : 'failed';
      job.message = controller.signal.aborted ? '安装已取消，可以稍后重试' : `安装失败：${error.message}`;
      line(error.stack || error.message);
      log?.warn?.(job.message);
    }).finally(async () => { job.running = false; job.finishedAt = Date.now(); save(); await unlock(id); });
    return status();
  }
  async function cancel() {
    if (job?.running && job.phase !== 'activating' && job.phase !== 'complete') { controller?.abort(); job.message = '正在取消安装'; save(); }
    return status();
  }
  async function openModels() {
    if (!supported) throw new Error('此功能仅支持 Windows x64');
    await mkdir(paths.models, { recursive: true });
    const child = spawn('explorer.exe', [paths.models], { windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return { ok: true };
  }
  async function dispose() { disposed = true; await cancel(); await task; await writes; }
  return { status, start, cancel, openModels, dispose, wait: async () => { await task; await writes; return status(); } };
}
