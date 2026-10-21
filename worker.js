/**
 * GitHub 加速下载站 —— Cloudflare Worker（网页版，带签名随机码）
 *
 * 路由：
 *   GET  /                      网页界面
 *   POST /api/sign              签发带签名的一次性链接（需先完成工作量证明）
 *   GET  /p/exp.rnd.sig.len/<目标URL>   校验签名后代理
 *
 * 防滥用设计（三层，全部无状态，不需要 KV / D1）：
 *   1. 随机码由服务端 HMAC 签发，无法自行拼造、无法枚举；
 *   2. 签名覆盖「URL 前缀 + 有效期」，链接到期自动作废；
 *   3. 签发前必须完成一次 PoW 计算，脚本批量刷取成本大幅提高。
 */

import pageHtml from './page.html';

const ALLOWED_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'gist.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'camo.githubusercontent.com',
  'user-images.githubusercontent.com',
  'codeload.github.com',
  'api.github.com',
  'avatars.githubusercontent.com',
  'github.githubassets.com',
]);

const HOP_BY_HOP = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
];

// 这些头由 CF 重新计算，或会干扰浏览器正常处理
const STRIP_RESPONSE = [
  'content-length', 'content-encoding', 'set-cookie',
  'strict-transport-security', 'content-security-policy',
  'content-security-policy-report-only', 'x-frame-options',
  'permissions-policy', 'cross-origin-resource-policy',
];

const DEFAULT_TTL = 2 * 3600;   // 链接默认有效期：2 小时
const DEFAULT_POW = 4;          // PoW 难度：哈希前 4 位十六进制为 0
const MAX_TTL = 7 * 24 * 3600;
const WINDOW = 60;              // 限速窗口：秒

const enc = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cfg = {
      secret: env.PROXY_SECRET || 'change-me-please',
      ttl: clamp(Number(env.LINK_TTL) || DEFAULT_TTL, 60, MAX_TTL),
      pow: clamp(Number(env.POW_DIFF) || DEFAULT_POW, 0, 6),
      rlSign: Number(env.RL_SIGN ?? 20),    // 每 IP 每分钟签发次数
      rlProxy: Number(env.RL_PROXY ?? 300), // 每 IP 每分钟代理请求数
    };

    if (request.method === 'GET' && url.pathname === '/') return page(cfg);
    if (request.method === 'POST' && url.pathname === '/api/sign') return sign(request, cfg, url);
    if (url.pathname.startsWith('/p/')) return proxy(request, cfg, url);

    return text(404, 'Not found');
  },
};

/* ---------- 网页 ---------- */

function page(cfg) {
  const html = pageHtml.replace('var DIFF = 4;', 'var DIFF = ' + cfg.pow + ';');
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}

/* ---------- 签发 ---------- */

async function sign(request, cfg, self) {
  if (!(await rateLimit(clientIp(request), 'sign', cfg.rlSign))) {
    return json(429, { error: '操作过于频繁，请稍后再试' });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: '请求格式错误' });
  }

  const input = String(body.url || '').trim();
  const nonce = String(body.nonce || '').trim();
  if (!input || !nonce) return json(400, { error: '参数不完整' });

  let target;
  try {
    target = new URL(input.replace(/^(https?):\/([^/])/i, '$1://$2'));
  } catch {
    return json(400, { error: '不是合法的 URL' });
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return json(400, { error: '仅支持 http/https' });
  }
  if (!ALLOWED_HOSTS.has(target.hostname)) {
    return json(400, { error: '不支持该域名：' + target.hostname });
  }

  // 工作量证明：证明调用方真的花了 CPU，挡住脚本批量签发
  if (!(await checkPow(target.toString(), nonce, cfg.pow))) {
    return json(400, { error: '本地校验未通过，请刷新页面重试' });
  }

  const prefix = target.toString();
  const exp = Math.floor(Date.now() / 1000) + cfg.ttl;
  const rnd = rand(6);
  const sig = await hmac(cfg.secret, msg(exp, rnd, prefix));

  return json(200, {
    link: self.origin + '/p/' + [exp.toString(36), rnd, sig, prefix.length].join('.') + '/' + prefix,
    exp,
  });
}

/* ---------- 代理 ---------- */

async function proxy(request, cfg, self) {
  if (!(await rateLimit(clientIp(request), 'proxy', cfg.rlProxy))) {
    return text(429, '请求过于频繁，请稍后再试');
  }

  // /p/exp.rnd.sig.len/https://host/path
  const rest = self.pathname.slice(3);
  const cut = rest.indexOf('/');
  if (cut < 0) return text(400, '链接格式不完整');

  const meta = rest.slice(0, cut).split('.');
  if (meta.length !== 4) return text(400, '链接格式不正确');
  const [exp36, rnd, sig, len36] = meta;

  const exp = parseInt(exp36, 36);
  const len = parseInt(len36, 10);
  if (!exp || !len) return text(400, '链接已损坏');

  const target = rest.slice(cut + 1) + self.search;

  if (exp * 1000 < Date.now()) {
    return text(403, '链接已过期，请回到首页重新生成');
  }

  // 签名只覆盖前缀，这样 git clone 追加的 /info/refs 等子路径也能放行
  const prefix = target.slice(0, len);
  if (!(await verify(cfg.secret, msg(exp, rnd, prefix), sig))) {
    return text(403, '签名校验失败');
  }
  if (target !== prefix && !target.startsWith(prefix + '/') && !target.startsWith(prefix + '?')) {
    return text(403, '该链接无权访问此路径');
  }

  let upstreamUrl;
  try {
    upstreamUrl = new URL(target);
  } catch {
    return text(400, '目标地址不合法');
  }
  if (!ALLOWED_HOSTS.has(upstreamUrl.hostname)) {
    return text(403, '不支持该域名：' + upstreamUrl.hostname);
  }

  const headers = new Headers();
  for (const [k, v] of request.headers) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'referer' || lk === 'origin' || lk === 'cookie') continue;
    if (HOP_BY_HOP.includes(lk)) continue;
    headers.set(k, v);
  }
  headers.set('Host', upstreamUrl.hostname);
  headers.set('Referer', 'https://' + upstreamUrl.hostname + '/');
  if (!headers.get('user-agent')) headers.set('User-Agent', 'Mozilla/5.0 (compatible; GitHub-Proxy)');
  if (!headers.get('accept')) headers.set('Accept', '*/*');

  const method = request.method;
  if (!['GET', 'HEAD', 'POST'].includes(method)) {
    return text(405, '不支持的请求方法');
  }

  let upstream;
  try {
    upstream = await fetch(upstreamUrl.toString(), {
      method,
      headers,
      body: method === 'POST' ? request.body : null,
      redirect: 'manual',
    });
  } catch (e) {
    return text(502, '源站连接失败：' + e.message);
  }

  const resHeaders = new Headers();
  for (const [k, v] of upstream.headers) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.includes(lk) || STRIP_RESPONSE.includes(lk)) continue;
    resHeaders.set(k, v);
  }
  resHeaders.set('access-control-allow-origin', '*');
  resHeaders.set('access-control-expose-headers', '*');
  // 授权链接不允许被共享缓存留存
  resHeaders.set('cache-control', 'private, max-age=300');

  // 3xx：把跳转改回本站，否则客户端会脱离代理直连源站
  if (upstream.status >= 300 && upstream.status < 400) {
    const loc = upstream.headers.get('location');
    if (loc) {
      try {
        const abs = new URL(loc, upstreamUrl.toString());
        resHeaders.set('location', ALLOWED_HOSTS.has(abs.hostname)
          ? await signedRedirect(self, exp, rnd, cfg, abs)
          : loc);
      } catch {
        resHeaders.set('location', loc);
      }
    }
    return new Response(null, { status: upstream.status, headers: resHeaders });
  }

  // 流式转发，不在 Worker 里缓冲整个文件
  return new Response(method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: resHeaders,
  });
}

/**
 * 重定向目标也要重新签名。release 下载会 302 到 objects.githubusercontent.com，
 * 原签名不覆盖新地址，这里用同一组 exp/rnd 为跳转目标续签。
 */
async function signedRedirect(self, exp, rnd, cfg, abs) {
  const prefix = abs.toString();
  const sig = await hmac(cfg.secret, msg(exp, rnd, prefix));
  return self.origin + '/p/' + [exp.toString(36), rnd, sig, prefix.length].join('.') + '/' + prefix;
}

/* ---------- 工具 ---------- */

function clientIp(request) {
  return request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0].trim()
    || 'unknown';
}

/**
 * 滑动窗口限速。借用 Cache API 存计数——免费额度内可用，且不需要 KV / D1。
 * 计数被边缘节点驱逐时会自动重置，对限速这种软性约束来说完全够用。
 */
async function rateLimit(ip, bucket, limit) {
  if (!(limit > 0)) return true;
  const window = Math.floor(Date.now() / 1000 / WINDOW);
  const cache = caches.default;
  const key = new Request('https://ratelimit.local/' + bucket + '/' + ip + '/' + window);
  try {
    const hit = await cache.match(key);
    const used = hit ? Number(await hit.text()) || 0 : 0;
    if (used >= limit) return false;
    await cache.put(key, new Response(String(used + 1), {
      headers: { 'cache-control': 'max-age=' + (WINDOW + 10) },
    }));
    return true;
  } catch {
    return true; // 限速组件异常时放行，不阻断正常使用
  }
}

function msg(exp, rnd, prefix) {
  return exp.toString(36) + '.' + rnd + '|' + prefix;
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return b64url(new Uint8Array(sig)).slice(0, 22);
}

async function verify(secret, message, sig) {
  const want = await hmac(secret, message);
  return safeEqual(want, String(sig || ''));
}

async function checkPow(url, nonce, diff) {
  if (diff <= 0) return true;
  if (!/^\d{1,12}$/.test(nonce)) return false;
  const h = await sha256hex(url + '|' + nonce);
  return h.startsWith('0'.repeat(diff));
}

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function rand(n) {
  return Array.from(crypto.getRandomValues(new Uint8Array(n)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function text(status, body) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
