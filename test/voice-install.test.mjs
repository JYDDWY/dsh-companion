import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { once } from 'node:events';
import vm from 'node:vm';
import { makeVoiceInstaller, downloadRuntime } from '../src/host/voice-install.mjs';
import { extractTarGz } from '../src/host/safe-tar.mjs';
import { installedVoiceRuntime, voicePaths, modelFiles, installedVoiceIds } from '../src/host/voice-runtime.mjs';
import { makeRoutes } from '../src/host/routes.mjs';

function tar(entries) {
  const chunks = [];
  for (const [name, value, type = '0'] of entries) {
    const data = Buffer.from(value), header = Buffer.alloc(512);
    header.write(name); header.write('0000600\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    header.fill(32, 148, 156); header.write(type, 156); header.write('ustar\0', 257);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
const pythonTar = tar([['python/python.exe', 'fixture-executable']]);
const release = { name: '@jyddwy/dsh-companion-rvc-runtime', version: '1.5.3-public1', sha512: 'a'.repeat(128) };
const bytes = tar([
  ['package/package.json', JSON.stringify(release)],
  ['package/runtime.json', JSON.stringify({ version: release.version, pythonArchive: 'bootstrap/python.tar.gz', pythonSha256: createHash('sha256').update(pythonTar).digest('hex') })],
  ['package/bootstrap/python.tar.gz', pythonTar], ['package/payload/voice_service.py', '# fixture'],
  ['package/payload/rvc/LICENSE', 'fixture'], ['package/payload/requirements-rvc.txt', '# fixture'],
  ['package/model-defaults/hubert_base/config.json', '{"fixture":true}'],
]);
async function fixture(overrides = {}) {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'dsc-voice-install-'));
  const calls = [];
  const installer = makeVoiceInstaller({ baseDir, release, platform: 'win32', arch: 'x64',
    download: async () => bytes, run: async (_exe, args) => { calls.push(args); }, ...overrides });
  return { baseDir, calls, installer, paths: voicePaths(baseDir) };
}

test('safe tar rejects traversal, links, corruption and truncation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsc-tar-'));
  for (const name of ['package/../escape', 'package/C:/escape', 'package/a\\escape', 'outside/file']) {
    await assert.rejects(extractTarGz(tar([[name, 'bad']]), root));
  }
  await assert.rejects(extractTarGz(tar([['package/link', 'target', '2']]), root));
  await assert.rejects(extractTarGz(Buffer.from('corrupt gzip'), root));
  const incomplete = gzipSync(Buffer.alloc(513, 1));
  await assert.rejects(extractTarGz(incomplete, root));
});
test('download refuses non-mirror URLs before network activity', async () => {
  await assert.rejects(downloadRuntime({ url: 'https://github.com/untrusted/file' }, { signal: new AbortController().signal, progress() {} }));
});
test('domestic CDN redirects are followed and other hosts remain rejected', async () => {
  const priorFetch = globalThis.fetch;
  const data = Buffer.from('verified runtime data');
  const release = { url: 'https://registry.npmmirror.com/test.tgz', maxBytes: 1024,
    sha512: createHash('sha512').update(data).digest('hex') };
  let count = 0;
  try {
    globalThis.fetch = async url => {
      count++;
      if (count === 1) return new Response(null, { status: 302, headers: { location: 'https://cdn.npmmirror.com/packages/test.tgz' } });
      assert.equal(new URL(url).hostname, 'cdn.npmmirror.com'); return new Response(data);
    };
    assert.deepEqual(await downloadRuntime(release, { signal: new AbortController().signal, progress() {} }), data);
    assert.equal(count, 2);
    globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/runtime.tgz' } });
    await assert.rejects(downloadRuntime(release, { signal: new AbortController().signal, progress() {} }), /未认可/);
  } finally { globalThis.fetch = priorFetch; }
});
test('no implicit installation, unsupported systems rejected', async () => {
  const a = await fixture(); await assert.rejects(a.installer.start(), /确认/); await a.installer.dispose();
  const b = await fixture({ platform: 'linux' }); await assert.rejects(b.installer.start({ confirmDownload: true }), /Windows/); await b.installer.dispose();
});
test('fresh install activates only after verification and preserves model files', async () => {
  const { baseDir, paths, calls, installer } = await fixture();
  await mkdir(path.join(paths.models, 'hubert_base'), { recursive: true });
  await writeFile(path.join(paths.models, 'hubert_base/config.json'), 'user config');
  await installer.start({ confirmDownload: true });
  const result = await installer.wait();
  assert.equal(result.job.phase, 'complete'); assert.equal(result.runtimeReady, true);
  assert.equal(result.models.present, false); assert.equal(calls.length, 4);
  assert.match(calls[1].join(' '), /mirror\.sjtu\.edu\.cn/); assert.match(calls[2].join(' '), /pypi\.tuna\.tsinghua\.edu\.cn/);
  assert.equal(await readFile(path.join(paths.models, 'hubert_base/config.json'), 'utf8'), 'user config');
  const runtime = installedVoiceRuntime(baseDir); assert.equal(runtime.version, release.version);
  assert.equal((await stat(path.join(runtime.rvc, 'assets/hubert_base/config.json'))).isFile(), true);
  await installer.dispose();
});
test('duplicate click starts one download and cancellation never activates', async () => {
  let count = 0;
  const a = await fixture({ download: async (_release, { signal }) => {
    count++; await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); if (signal.aborted) reject(new Error('cancelled')); });
  } });
  await Promise.all([a.installer.start({ confirmDownload: true }), a.installer.start({ confirmDownload: true })]);
  assert.equal(count, 1); await a.installer.cancel();
  const state = await a.installer.wait(); assert.equal(state.job.phase, 'cancelled'); assert.equal(state.runtimeReady, false);
  await a.installer.dispose();
});
test('failed reinstall leaves previous activation and models untouched', async () => {
  const a = await fixture(); await a.installer.start({ confirmDownload: true }); await a.installer.wait(); await a.installer.dispose();
  const active = await readFile(a.paths.active, 'utf8');
  const b = await fixture({ baseDir: a.baseDir, run: async () => { throw new Error('simulated pip failure'); } });
  await b.installer.start({ confirmDownload: true });
  const state = await b.installer.wait(); assert.equal(state.job.phase, 'failed'); assert.equal(state.runtimeReady, true);
  assert.equal(await readFile(a.paths.active, 'utf8'), active); await b.installer.dispose();
});
test('dependency source failure automatically retries another domestic mirror', async () => {
  const sources = [];
  const a = await fixture({ run: async (_exe, args) => {
    if (!args.includes('pip')) return;
    const index = args[args.indexOf('--index-url') + 1]; sources.push(index);
    if (index.includes('tuna.')) throw new Error('HTTP 403');
  } });
  await a.installer.start({ confirmDownload: true });
  const state = await a.installer.wait();
  assert.equal(state.runtimeReady, true);
  assert.equal(sources.filter(source => source.includes('aliyun.')).length, 2);
  await a.installer.dispose();
});
test('another DSH process cannot run a second installer', async () => {
  const a = await fixture({ download: async (_release, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })) });
  await a.installer.start({ confirmDownload: true });
  const b = await fixture({ baseDir: a.baseDir });
  await assert.rejects(b.installer.start({ confirmDownload: true }), /另一个 DSH/);
  await a.installer.dispose(); await b.installer.dispose();
});
test('dead installer status becomes retryable after restart', async () => {
  const a = await fixture(); await mkdir(a.paths.root, { recursive: true });
  await writeFile(a.paths.status, JSON.stringify({ running: true, pid: process.pid, logs: [] }));
  assert.equal((await a.installer.status()).job.phase, 'interrupted'); await a.installer.dispose();
});
test('managed runtime discovery uses persistent data and blocks incomplete models', async () => {
  const a = await fixture(); await a.installer.start({ confirmDownload: true }); await a.installer.wait();
  const priorHome = process.env.DSH_HOME, priorRvc = process.env.RVC_HOME;
  process.env.DSH_HOME = path.dirname(a.baseDir);
  // dataDir appends dsh-companion, so use a separate configured home and copy its activation.
  const home = await mkdtemp(path.join(tmpdir(), 'dsc-managed-'));
  process.env.DSH_HOME = home; delete process.env.RVC_HOME;
  const { cp } = await import('node:fs/promises');
  await cp(a.paths.root, path.join(home, 'dsh-companion/voice'), { recursive: true, dereference: true });
  try {
    const { makeServices } = await import('../src/host/services.mjs');
    const { normalizeConfig } = await import('../src/host/config.mjs');
    const config = normalizeConfig({});
    const services = makeServices({ getConfig: () => config, log: { info() {}, warn() {} } });
    const spec = services.serviceSpec('voice');
    assert.match(spec.script, /voice_service\.py$/); assert.ok(spec.script.startsWith(home));
    assert.equal(spec.missingModels, true);
    assert.match((await services.ensure('voice', async () => ({ ok: false }))).error, /补齐模型/);
    config.services.voiceScript = a.paths.status;
    assert.equal(services.serviceSpec('voice').script, a.paths.status);
  } finally {
    if (priorHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = priorHome;
    if (priorRvc === undefined) delete process.env.RVC_HOME; else process.env.RVC_HOME = priorRvc;
    await a.installer.dispose();
  }
});
test('settings panel offers one explicit install action and a separate model step', async () => {
  const source = (await readFile(new URL('../client.js', import.meta.url), 'utf8'))
    .replace('    function SettingsView(', '    window.__voicePanel = VoiceInstallPanel;\n    function SettingsView(');
  const posts = [];
  const status = { supported: true, runtimeReady: false, models: { hubert: false, rmvpe: false, voices: [] }, job: null };
  let registration;
  const window = { __ModuleLoader__: { load(value) { registration = value; } } };
  vm.runInNewContext(source, { window, fetch: async (url, options) => {
    posts.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ ok: true }) };
  } });
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: initial => [initial === null ? status : initial, () => {}], useEffect() {},
    useRef: value => ({ current: value }), useCallback: fn => fn };
  registration.factory(() => react);
  const tree = window.__voicePanel({});
  const nodes = []; const walk = value => { if (!value || typeof value !== 'object') return; nodes.push(value); value.children?.flat(Infinity).forEach(walk); }; walk(tree);
  const install = nodes.find(node => node.type === 'button' && node.children.includes('下载并安装语音增强（CPU）'));
  assert.ok(install); assert.equal(install.props.disabled, false); await install.props.onClick();
  assert.deepEqual(posts[0], { url: '/dsh-companion/voice-install/start', body: { confirmDownload: true } });
  assert.match(JSON.stringify(tree), /模型需自行下载/);
});

test('voice install panel recognizes an external running voice service', async () => {
  const source = (await readFile(new URL('../client.js', import.meta.url), 'utf8'))
    .replace('    function SettingsView(', '    window.__voicePanel = VoiceInstallPanel;\n    function SettingsView(');
  const status = { supported: true, runtimeReady: false, models: { hubert: false, rmvpe: false, voices: [] }, job: null };
  let registration;
  const window = { __ModuleLoader__: { load(value) { registration = value; } } };
  vm.runInNewContext(source, { window, fetch: async () => ({ ok: true, json: async () => ({}) }) });
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: initial => [initial === null ? status : initial, () => {}], useEffect() {},
    useRef: value => ({ current: value }), useCallback: fn => fn };
  registration.factory(() => react);
  const tree = window.__voicePanel({
    voiceData: { serviceOk: true, managed: false },
    snapshot: { services: { voice: { ok: true } } },
  });
  const text = JSON.stringify(tree);
  assert.match(text, /已检测到正在运行的本地语音服务/);
  assert.match(text, /安装独立 CPU 语音环境（可选）/);
});

test('modelFiles scans every installed weight, not only hardcoded voices', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dsc-voice-models-'));
  const models = path.join(base, 'voice', 'models');
  await mkdir(path.join(models, 'weights'), { recursive: true });
  await mkdir(path.join(models, 'hubert_base'), { recursive: true });
  await mkdir(path.join(models, 'rmvpe'), { recursive: true });
  const big = Buffer.alloc(1024 * 1024 + 1, 1);
  await writeFile(path.join(models, 'hubert_base', 'pytorch_model.bin'), big);
  await writeFile(path.join(models, 'rmvpe', 'rmvpe.pt'), big);
  await writeFile(path.join(models, 'weights', 'nahida.pth'), big);
  await writeFile(path.join(models, 'weights', 'custom_voice.pth'), big);
  await writeFile(path.join(models, 'weights', 'tiny.pth'), Buffer.from('small'));
  const files = modelFiles(models);
  assert.deepEqual(files.voices, ['custom_voice.pth', 'nahida.pth']);
  assert.deepEqual(installedVoiceIds(models), ['custom_voice', 'nahida']);
  assert.equal(files.present, true);
});

test('/voices filters one-click runtime by installed weights but keeps external service list', async () => {
  const mounted = [];
  const all = [
    { id: 'march7', name: '三月七 · 崩坏：星穹铁道' },
    { id: 'nahida', name: '纳西妲 · 原神' },
    { id: 'furina', name: '芙宁娜 · 原神' },
  ];
  const makeEngine = (voiceUrl) => ({
    getSettings: () => ({ services: { voiceUrl } }),
    getState: () => ({ config: { services: { voiceUrl } }, services: { voice: { ok: true } } }),
    VOICE: { listVoices: async () => all, health: async () => ({ ok: true }) },
  });
  const installer = { status: async () => ({ runtimeReady: true, models: { hubert: true, rmvpe: true, voices: ['nahida.pth', 'march7.pth'] }, modelDir: 'X:/models' }) };
  for (const [label, voiceUrl] of [['managed', 'http://127.0.0.1:9123'], ['external', 'http://127.0.0.1:9999']]) {
    const { handler } = makeRoutes({ prefix: '/dsh-companion', engine: makeEngine(voiceUrl), log: { warn() {}, error() {} }, voiceInstaller: installer });
    const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/dsh-companion/voices?force=1`);
      const data = await response.json();
      mounted.push({ label, data });
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
  const managed = mounted.find(x => x.label === 'managed').data;
  assert.deepEqual(managed.voices.map(v => v.id), ['march7', 'nahida']);
  assert.equal(managed.managed, true); assert.equal(managed.source, 'managed');
  const external = mounted.find(x => x.label === 'external').data;
  assert.deepEqual(external.voices.map(v => v.id), ['march7', 'nahida', 'furina']);
  assert.equal(external.externalService, true);
});

test('client voice selector always renders a select with refresh/status/unavailable messaging', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /h\('input', \{ className: 'dsc-text', value: draft\.voice\.voiceId/);
  assert.match(source, /刷新声线/);
  assert.match(source, /当前声线暂不可用/);
  assert.match(source, /语音服务未启动/);
  assert.match(source, /未检测到声线模型/);
  assert.match(source, /RVC 声线\/音调设置不生效/);
  assert.match(source, /\?force=1/);
  assert.match(source, /onRefreshVoices/);
  // 服务从“未启动”恢复时自动刷新；打开设置时也主动刷新
  assert.match(source, /previousVoiceServiceOk/);
  assert.match(source, /void onRefreshVoices\?\.\(\{ force: true, retries: 3 \}\)/);
  assert.match(source, /void refreshVoices\(\{ force: true, retries: 3 \}\)/);
});

test('settings view renders with a real config (catches undefined callback vars)', async () => {
  const { DEFAULTS, normalizeConfig } = await import('../src/host/config.mjs');
  const config = normalizeConfig(DEFAULTS);
  const source = (await readFile(new URL('../client.js', import.meta.url), 'utf8'))
    .replace('    function SettingsView(', '    window.__settingsView = SettingsView;' + String.fromCharCode(10) + '    function SettingsView(');
  let registration;
  const window = { __ModuleLoader__: { load(value) { registration = value; } } };
  vm.runInNewContext(source, { window, fetch: async () => ({ ok: true, json: async () => ({}) }),
    document: { visibilityState: 'visible' }, setInterval, clearInterval, setTimeout, clearTimeout });
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
  let hook = 0;
  const react = {
    createElement: h,
    useState(initial) {
      hook += 1;
      if (hook === 1) return [JSON.parse(JSON.stringify(config)), () => {}];
      return [initial, () => {}];
    },
    useEffect() {},
    useRef(value) { return { current: value }; },
    useCallback(fn) { return fn; },
  };
  registration.factory(() => react);
  const tree = window.__settingsView({
    snapshot: { config, services: { voice: { ok: true } } },
    models: { providers: [] }, voices: [],
    voiceState: { loading: false, error: '', data: { serviceOk: true, managed: false, voices: [] } },
    onRefreshVoices: () => {}, onSaved: () => {}, notify: () => {},
  });
  assert.ok(tree); assert.equal(tree.type, 'div');
});

test('settings view renders cast editor and subtitle controls', async () => {
  const { normalizeConfig } = await import('../src/host/config.mjs');
  const config = normalizeConfig({
    cast: { enabled: true, roles: [
      { enabled: true, card: 'gentle', name: '阿岚', voiceId: 'v1', useAgentsMd: true },
      { enabled: true, card: 'tsundere', name: '小满', voiceId: 'v2', useAgentsMd: false },
      { enabled: false, card: 'analyst', name: '军师', voiceId: '', useAgentsMd: false },
    ] },
    subtitle: { enabled: true, color: '#eaf6ff', color2: '#4da3ff', delaySec: 2.5 },
  });
  const source = (await readFile(new URL('../client.js', import.meta.url), 'utf8'))
    .replace('    function SettingsView(', '    window.__settingsView = SettingsView;' + String.fromCharCode(10) + '    function SettingsView(');
  let registration;
  const window = { __ModuleLoader__: { load(value) { registration = value; } } };
  vm.runInNewContext(source, { window, fetch: async () => ({ ok: true, json: async () => ({}) }),
    document: { visibilityState: 'visible' }, setInterval, clearInterval, setTimeout, clearTimeout });
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
  let hook = 0;
  const react = {
    createElement: h,
    useState(initial) {
      hook += 1;
      if (hook === 1) return [JSON.parse(JSON.stringify(config)), () => {}];
      return [initial, () => {}];
    },
    useEffect() {},
    useRef(value) { return { current: value }; },
    useCallback(fn) { return fn; },
  };
  registration.factory(() => react);
  const tree = window.__settingsView({
    snapshot: { config, services: { voice: { ok: true } } },
    models: { providers: [] },
    voices: [{ id: 'v1', name: '声线一' }, { id: 'v2', name: '声线二' }],
    voiceState: { loading: false, error: '', data: { serviceOk: true, managed: false, voices: [] } },
    onRefreshVoices: () => {}, onSaved: () => {}, notify: () => {},
  });
  const serialized = JSON.stringify(tree);
  assert.match(serialized, /一人分饰多角/);
  assert.match(serialized, /字幕延时（秒）/);
  assert.match(serialized, /双色字幕/);
  assert.match(serialized, /角色卡/);
  assert.match(serialized, /这个角色沿用 AGENTS\.md/);
  assert.match(serialized, /系统语音下所有角色会用同一个声音/);
});

test('installation endpoint accepts same-origin JSON and rejects cross-origin forms', async () => {
  let starts = 0;
  const { handler } = makeRoutes({ prefix: '/dsh-companion', engine: {}, log: { warn() {}, error() {} }, voiceInstaller: {
    start: async body => { assert.equal(body.confirmDownload, true); starts++; return { ok: true }; }, status: async () => ({ ok: true }),
  } });
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`, url = origin + '/dsh-companion/voice-install/start';
  try {
    for (const headers of [{ origin: 'https://evil.example', 'content-type': 'application/json' }, { 'content-type': 'text/plain' }]) {
      assert.equal((await fetch(url, { method: 'POST', headers, body: '{"confirmDownload":true}' })).status, 403);
    }
    assert.equal((await fetch(url, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{"confirmDownload":true}' })).status, 202);
    assert.equal(starts, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
