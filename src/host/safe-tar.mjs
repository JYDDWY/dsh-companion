import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const text = field => field.toString('utf8').replace(/\0.*$/s, '');
function number(field) {
  const value = text(field).trim();
  if (!/^[0-7]*$/.test(value)) throw new Error('压缩包数字格式不受支持');
  return value ? Number.parseInt(value, 8) : 0;
}
export function childPath(root, relative) {
  if (!relative || relative.includes('\\') || relative.includes(':') || relative.includes('\0') || path.posix.isAbsolute(relative)) throw new Error('压缩包包含非法路径');
  const parts = relative.replace(/\/$/, '').split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('压缩包路径越界');
  const target = path.resolve(root, ...parts);
  const rel = path.relative(path.resolve(root), target);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('压缩包路径越界');
  return target;
}
function paxFields(data) {
  const result = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(32, offset);
    const length = Number(data.subarray(offset, space).toString('ascii'));
    if (space < offset || !Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > data.length) throw new Error('PAX 元数据损坏');
    const line = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const equal = line.indexOf('=');
    if (equal > 0) result[line.slice(0, equal)] = line.slice(equal + 1);
    offset += length;
  }
  return result;
}
/** Only regular files/directories are accepted; no symlink or hardlink extraction. */
export async function extractTarGz(compressed, destination, { prefix = 'package/', maxBytes = 384 * 1024 * 1024, maxFiles = 12000 } = {}) {
  const tar = gunzipSync(compressed, { maxOutputLength: maxBytes });
  const files = new Set();
  let offset = 0, pax = {}, longName = null;
  await mkdir(destination, { recursive: true });
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== number(header.subarray(148, 156))) throw new Error('压缩包头校验失败');
    let name = text(header.subarray(0, 100));
    const parent = text(header.subarray(345, 500));
    if (parent) name = parent + '/' + name;
    const size = number(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 48);
    const start = offset + 512;
    if (start + size > tar.length) throw new Error('压缩包内容被截断');
    const data = tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
    if (type === 'x') { pax = paxFields(data); continue; }
    if (type === 'g') { throw new Error('不支持全局 PAX 元数据'); }
    if (type === 'L') { longName = text(data); continue; }
    name = pax.path || longName || name;
    pax = {}; longName = null;
    if (type !== '0' && type !== '5') throw new Error('压缩包包含链接或不支持的文件类型');
    if (name === prefix.replace(/\/$/, '') || name === prefix) continue;
    if (!name.startsWith(prefix)) throw new Error('压缩包根目录不符合预期');
    const relative = name.slice(prefix.length);
    const target = childPath(destination, relative);
    if (type === '5') { await mkdir(target, { recursive: true }); continue; }
    if (files.has(relative) || files.size >= maxFiles) throw new Error('压缩包文件重复或过多');
    files.add(relative);
    await mkdir(path.dirname(target), { recursive: true });
    // Destination is a newly created private installation slot. Refuse overwrites.
    await writeFile(target, data, { flag: 'wx', mode: 0o600 });
  }
  if (files.size === 0) throw new Error('压缩包为空');
  return files.size;
}
