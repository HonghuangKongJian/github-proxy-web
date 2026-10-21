/**
 * 线上冒烟测试：验证已部署的 Worker 是否真的能签发并代理。
 *   node verify-live.mjs https://gh.amw3.eu.org
 *
 * 会真跑一遍 PoW（约 0.5 秒）并实际回源 GitHub。
 */
const ORIGIN = (process.argv[2] || 'https://gh.amw3.eu.org').replace(/\/+$/, '');
const TARGET = process.argv[3] || 'https://raw.githubusercontent.com/facebook/react/main/README.md';
const DIFF = 4;
const TIMEOUT = 30000;

let ok = 0;
let bad = 0;
const check = (name, cond, extra) => {
  if (cond) { ok++; console.log('  ok   ' + name); }
  else { bad++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
};

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

const get = (url, init = {}) =>
  fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) });

console.log('\n目标站点：' + ORIGIN + '\n');

console.log('[1] 网页可访问');
let home;
try {
  home = await get(ORIGIN + '/');
  const html = await home.text();
  check('首页返回 200', home.status === 200, 'HTTP ' + home.status);
  check('页面内容正确', html.includes('GitHub 加速下载'));
  check('PoW 难度已注入页面', html.includes('var DIFF = ' + DIFF + ';'));
} catch (e) {
  check('首页可访问', false, e.message);
  console.log('\n无法连接站点，检查域名 DNS 是否已生效。');
  process.exit(1);
}

console.log('\n[2] 签发链接');
const t0 = Date.now();
const nonce = await mine(TARGET, DIFF);
console.log('      PoW 耗时 ' + (Date.now() - t0) + ' ms');
let link;
try {
  const res = await fetch(ORIGIN + '/api/sign', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: TARGET, nonce }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const data = await res.json();
  check('签发接口返回 200', res.status === 200, JSON.stringify(data));
  check('返回了签名链接', !!data.link);
  link = data.link;
  console.log('      ' + link);
} catch (e) {
  check('签发接口可用', false, e.message);
  process.exit(1);
}

console.log('\n[3] 通过代理回源 GitHub');
try {
  const res = await get(link);
  const body = await res.text();
  check('代理返回 200', res.status === 200, 'HTTP ' + res.status);
  check('拿到了真实文件内容', body.includes('React'), body.slice(0, 80));
  check('响应来自代理而非缓存错误', !body.includes('[object Promise]'));
} catch (e) {
  check('代理链路可用', false, e.message);
}

console.log('\n[4] 防滥用生效');
try {
  const forged = link.replace(/\.([\w-]{22})\./, '.AAAAAAAAAAAAAAAAAAAAAA.');
  const res = await get(forged);
  check('伪造签名被拒绝', res.status === 403, 'HTTP ' + res.status);
} catch (e) {
  check('伪造签名测试', false, e.message);
}

console.log('\n结果：' + ok + ' 通过，' + bad + ' 失败\n');
process.exit(bad ? 1 : 0);
