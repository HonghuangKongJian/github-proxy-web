/**
 * 端到端自测：直接驱动真实代码路径。
 *   node build.js && node test.mjs
 *
 * 加载的是 dist/worker.js —— 原生 Node 不认识 `import './page.html'`，
 * 那是 wrangler 的 module rule，build 之后才是标准 ESM。
 * 用 mock 顶掉 caches 与 fetch，其余逻辑（签名、PoW、限速、重定向续签）都是真跑。
 */

globalThis.caches = {
  default: {
    store: new Map(),
    async match(req) {
      const v = this.store.get(req.url);
      return v === undefined ? undefined : new Response(v);
    },
    async put(req, res) {
      this.store.set(req.url, await res.text());
    },
  },
};

let captured = null;
let mockResponse = () => new Response('UPSTREAM-BODY', { status: 200, headers: { 'content-type': 'text/plain' } });
globalThis.fetch = async (url, init) => {
  captured = { url: String(url), init };
  return mockResponse();
};

const { default: worker } = await import('./dist/worker.js');

const SECRET = 'test-secret-abcdefghijklmnop';
const ORIGIN = 'https://gh.example.com';
const env = {
  PROXY_SECRET: SECRET,
  LINK_TTL: '3600',
  POW_DIFF: '2',
  RL_SIGN: '20',
  RL_PROXY: '300',
};

const call = (path, init = {}) =>
  worker.fetch(new Request(ORIGIN + path, {
    headers: { 'cf-connecting-ip': '1.2.3.4', ...(init.headers || {}) },
    ...init,
  }), env, {});

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function mine(url, diff) {
  const need = '0'.repeat(diff);
  for (let i = 0; i < 2000000; i++) {
    const h = await sha256hex(url + '|' + i);
    if (h.startsWith(need)) return String(i);
  }
  throw new Error('mine failed');
}

async function issue(url, diff = 2) {
  const nonce = await mine(url, diff);
  const res = await call('/api/sign', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, nonce }),
  });
  return { status: res.status, data: await res.json() };
}

console.log('\n[1] 网页与签发');
{
  const res = await call('/');
  const pageText = await res.text();
  check('GET / 返回网页', res.status === 200 && pageText.includes('GitHub 加速下载'));
  check('GET / 包含返回门户导航链接', pageText.includes('id="portalLink"') && pageText.includes('https://amw3.eu.org/'));
  check('GET / 包含页脚返回门户链接', pageText.includes('id="portalLinkFooter"'));

  const customRes = await worker.fetch(new Request(ORIGIN + '/'), { ...env, PORTAL_URL: 'https://custom.portal.com/' }, {});
  const customPageText = await customRes.text();
  check('自定义 PORTAL_URL 环境变量注入生效', customPageText.includes('var PORTAL_URL = "https://custom.portal.com/";'));

  const { status, data } = await issue('https://github.com/facebook/react/archive/refs/heads/main.zip');
  check('签发成功', status === 200 && !!data.link, JSON.stringify(data));
  check('链接带签名随机码', /\/p\/[0-9a-z]+\.[0-9a-f]{12}\.[\w-]{22}\.\d+\//.test(data.link || ''), data.link);
  check('返回过期时间戳', typeof data.exp === 'number');
  globalThis.__link = data.link;
}

console.log('\n[2] 正常代理');
{
  const path = new URL(globalThis.__link).pathname + new URL(globalThis.__link).search;
  mockResponse = () => new Response('ZIPDATA', { status: 200 });
  const res = await call(path);
  check('代理转发并返回内容', res.status === 200 && (await res.text()) === 'ZIPDATA');
  check('回源地址正确', captured.url === 'https://github.com/facebook/react/archive/refs/heads/main.zip', captured.url);
}

console.log('\n[3] git 子路径放行');
{
  const { data } = await issue('https://github.com/facebook/react.git');
  const base = new URL(data.link);
  const subPath = base.pathname.replace('react.git', 'react.git/info/refs') + '?service=git-upload-pack';
  mockResponse = () => new Response('GITDATA', { status: 200 });
  const res = await call(subPath);
  check('clone 的 /info/refs 子路径放行', res.status === 200 && (await res.text()) === 'GITDATA');
  check('回源保留了查询参数', captured.url === 'https://github.com/facebook/react.git/info/refs?service=git-upload-pack', captured.url);
}

console.log('\n[4] 越权与伪造拦截');
{
  const { data } = await issue('https://github.com/facebook/react.git');
  const base = new URL(data.link);

  const other = base.pathname.replace('facebook/react.git', 'someone/else.git');
  check('同域其他仓库被拒', (await call(other)).status === 403);

  const evil = base.pathname.replace('react.git', 'react.git.evil');
  check('前缀拼接绕过被拒', (await call(evil)).status === 403);

  const badSig = base.pathname.replace(/\.([\w-]{22})\./, '.AAAAAAAAAAAAAAAAAAAAAA.');
  check('篡改签名被拒', (await call(badSig)).status === 403);

  const badUrl = await issue('https://evil.com/a/b');
  check('非白名单域名拒绝签发', badUrl.status === 400, JSON.stringify(badUrl.data));
}

console.log('\n[5] 过期链接');
{
  const oldExp = Math.floor(Date.now() / 1000) - 60;
  const { data } = await issue('https://github.com/facebook/react');
  const fresh = new URL(data.link).pathname;
  const expired = fresh.replace(/^\/p\/[0-9a-z]+\./, '/p/' + oldExp.toString(36) + '.');
  check('过期链接被拒', (await call(expired)).status === 403);
}

console.log('\n[6] 302 跳转续签');
{
  const { data } = await issue('https://github.com/facebook/react/releases/download/v1.0/app.zip');
  const path = new URL(data.link).pathname;
  mockResponse = () => new Response(null, {
    status: 302,
    headers: { location: 'https://objects.githubusercontent.com/github-production/abc?X-Amz-Signature=zzz' },
  });
  const res = await call(path);
  check('重定向被改回本站', (res.headers.get('location') || '').startsWith(ORIGIN + '/p/'), res.headers.get('location'));

  const next = new URL(res.headers.get('location')).pathname + new URL(res.headers.get('location')).search;
  mockResponse = () => new Response('BINARY', { status: 200 });
  const res2 = await call(next);
  check('续签后的链接可正常代理', res2.status === 200 && (await res2.text()) === 'BINARY');
  check('跳转目标回源正确', captured.url === 'https://objects.githubusercontent.com/github-production/abc?X-Amz-Signature=zzz', captured.url);
}

console.log('\n[7] 限速');
{
  const nonce = await mine('https://github.com/a/b', 2);
  let blocked = 0;
  for (let i = 0; i < 25; i++) {
    const res = await call('/api/sign', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '9.9.9.9' },
      body: JSON.stringify({ url: 'https://github.com/a/b', nonce }),
    });
    if (res.status === 429) blocked++;
  }
  check('同一 IP 超出配额后被限流', blocked > 0, '被拦截 ' + blocked + ' 次');
}

console.log('\n[8] 默认 PoW 难度耗时（DIFF=4）');
{
  const t = Date.now();
  await mine('https://github.com/facebook/react', 4);
  const ms = Date.now() - t;
  check('DIFF=4 挖矿耗时可接受', ms < 8000, ms + ' ms');
  console.log('      实测耗时：' + ms + ' ms');
}

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败\n');
process.exit(fail ? 1 : 0);
