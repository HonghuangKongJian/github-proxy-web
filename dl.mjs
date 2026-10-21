/**
 * 命令行下载工具：通过已部署的代理站下载 GitHub 文件。
 *
 *   node dl.mjs <github-url> [输出文件名]
 *
 * 例：
 *   node dl.mjs https://github.com/cli/cli/releases/download/v2.102.1/gh_2.102.1_windows_amd64.zip
 *   node dl.mjs https://raw.githubusercontent.com/user/repo/main/README.md readme.md
 *
 * 流程与网页一致：本地完成 PoW → 服务端签发签名链接 → 跟随 302 下载。
 * 默认站点可用环境变量 PROXY_ORIGIN 覆盖。
 */
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const ORIGIN = (process.env.PROXY_ORIGIN || 'https://gh.amw3.eu.org').replace(/\/+$/, '');
const DIFF = Number(process.env.POW_DIFF || 4);

const target = process.argv[2];
if (!target) {
  console.error('用法：node dl.mjs <github-url> [输出文件名]');
  process.exit(1);
}
const out = process.argv[3] || basename(new URL(target).pathname) || 'download.bin';

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function mine(url, diff) {
  const need = '0'.repeat(diff);
  for (let i = 0; i < 5000000; i++) {
    if ((await sha256hex(url + '|' + i)).startsWith(need)) return String(i);
  }
  throw new Error('PoW 未在限定次数内完成');
}

console.log('目标：' + target);
process.stdout.write('正在计算工作量证明… ');
const t0 = Date.now();
const nonce = await mine(target, DIFF);
console.log((Date.now() - t0) + ' ms');

const res = await fetch(ORIGIN + '/api/sign', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: target, nonce }),
});
const data = await res.json();
if (!res.ok) {
  console.error('签发失败：' + (data.error || res.status));
  process.exit(1);
}

console.log('下载中…');
const file = await fetch(data.link, { redirect: 'follow' });
if (!file.ok) {
  console.error('下载失败：HTTP ' + file.status);
  process.exit(1);
}
const buf = Buffer.from(await file.arrayBuffer());
writeFileSync(out, buf);
console.log('已保存：' + out + '（' + (buf.length / 1024 / 1024).toFixed(2) + ' MB）');
