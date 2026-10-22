// R04 回归：仅窗口截图时，PowerShell 兜底必须带 -Hwnd（而不是截整个虚拟桌面）。
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.DSH_HOME = await mkdtemp(path.join(process.env.TEMP ?? '.', 'dsh-fallback-'));
const invocations = [];
childProcess.execFile = (file, args, options, callback) => {
  invocations.push(args);
  void (async () => {
    const arg = (name) => args[args.indexOf(name) + 1];
    if (arg('-Mode') === 'detect') {
      callback(null, JSON.stringify({ available: true, hwnd: 123, title: 'RimWorld', process: 'RimWorld.exe' }), '');
    } else {
      const dir = arg('-OutDir');
      await mkdir(dir, { recursive: true });
      const frame = path.join(dir, 'frame-0.jpg');
      await writeFile(frame, 'fake-frame');
      await writeFile(arg('-Out'), JSON.stringify({ frames: [{ path: frame, width: 1, height: 1 }] }));
      callback(null, '', '');
    }
  })().catch(callback);
  return { on() {} };
};
syncBuiltinESMExports();
globalThis.fetch = async () => { throw new Error('isolated offline test'); };

const root = path.resolve(import.meta.dirname, '..', 'src', 'host');
const { normalizeConfig } = await import(pathToFileURL(path.join(root, 'config.mjs')).href);
const { makeCapture } = await import(pathToFileURL(path.join(root, 'capture.mjs')).href);
const cfg = normalizeConfig({ capture: { fullScreen: false, frameCount: 1 } });
const capture = makeCapture({ getConfig: () => cfg, log: { warn() {} } });
const result = await capture.grab({ tickId: 1, windowInfo: { hwnd: 123, process: 'RimWorld.exe' }, preferWindow: true });
const burst = invocations.find((args) => args.includes('burst'));
assert.equal(result.ok, true, `PS 兜底应成功：${result.error ?? ''}`);
assert.ok(burst, '应调用 burst');
assert.ok(burst.includes('-Hwnd'), '仅窗口模式必须传 -Hwnd');
assert.equal(burst[burst.indexOf('-Hwnd') + 1], '123', '-Hwnd 应为前台窗口句柄');
// 服务路径：仅窗口模式也不能偷偷追加 desktop 兜底
const serviceCalls = [];
globalThis.fetch = async (url) => {
  const text = String(url);
  serviceCalls.push(text);
  if (text.includes('/window')) {
    return new Response(JSON.stringify({ ok: true, window: { hwnd: 123, process: 'RimWorld.exe', title: 'RimWorld' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ ok: false, error: 'window capture failed' }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const capture2 = makeCapture({ getConfig: () => cfg, log: { warn() {} } });
const result2 = await capture2.grab({ tickId: 2, windowInfo: { hwnd: 123, process: 'RimWorld.exe' }, preferWindow: true });
assert.equal(serviceCalls.some((url) => url.includes('mode=desktop')), false, '仅窗口模式不应请求 desktop 截图');
console.log(JSON.stringify({ ok: result.ok, hwndArg: burst[burst.indexOf('-Hwnd') + 1], serviceOnlyWindow: serviceCalls.every((u) => !u.includes('mode=desktop')), result2: result2.ok }));
