/**
 * GitHub 反向代理 / 加速器 —— Cloudflare Worker
 *
 * 三种用法：
 *   1. 通用反代   https://gh.example.com/https://github.com/user/repo
 *   2. 仓库简写   https://gh.example.com/gh/user/repo/...
 *   3. 文件简写   https://gh.example.com/raw/user/repo/branch/path/to/file
 *
 * git 用法：
 *   git clone https://gh.example.com/https://github.com/user/repo.git
 *   git clone https://gh.example.com/gh/user/repo.git
 */

// 只允许代理这些域名，避免被当成开放代理滥用
const ALLOWED_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'gist.github.com',
  'objects.githubusercontent.com',
  'codeload.github.com',
  'api.github.com',
  'avatars.githubusercontent.com',
  'github.githubassets.com',
]);

// 这些域名的内容可长期缓存（不可变资源）
const CACHEABLE_HOSTS = new Set([
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'objects.githubusercontent.com',
  'codeload.github.com',
  'github.githubassets.com',
]);

const HOP_BY_HOP = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
];

// 由 CF 重新计算，直接透传会导致长度/编码不匹配
const STRIP_RESPONSE = [
  'content-length', 'content-encoding',
  'set-cookie', 'strict-transport-security',
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'x-content-type-options', 'referrer-policy',
  'permissions-policy', 'cross-origin-resource-policy',
];

// 简写前缀 -> 目标域名
const SHORTCUTS = {
  '/gh/': 'https://github.com/',
  '/raw/': 'https://raw.githubusercontent.com/',
  '/gist/': 'https://gist.githubusercontent.com/',
  '/release/': 'https://github.com/',
};

export default {
  async fetch(request) {
    // 首页给一个简单提示，避免根路径报 404 让人困惑
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '') {
      return text(200, [
        'GitHub proxy is running.',
        '',
        'Usage:',
        '  https://' + url.host + '/https://github.com/user/repo',
        '  https://' + url.host + '/gh/user/repo',
        '  https://' + url.host + '/raw/user/repo/branch/file',
      ].join('\n'));
    }

    let target;
    try {
      target = resolveTarget(url);
    } catch (e) {
      return text(400, 'Bad target URL: ' + e.message);
    }

    if (!ALLOWED_HOSTS.has(target.hostname)) {
      return text(403, 'Host not allowed: ' + target.hostname);
    }

    // 只透传安全的请求头
    const headers = new Headers();
    for (const [k, v] of request.headers) {
      const lk = k.toLowerCase();
      if (lk === 'host' || lk === 'referer' || lk === 'origin' || lk === 'cookie') continue;
      if (HOP_BY_HOP.includes(lk)) continue;
      headers.set(k, v);
    }
    headers.set('Host', target.hostname);
    headers.set('Referer', 'https://' + target.hostname + '/');
    if (!headers.get('user-agent')) {
      headers.set('User-Agent', 'Mozilla/5.0 (compatible; GitHub-Proxy-Worker)');
    }
    if (!headers.get('accept')) {
      headers.set('Accept', '*/*');
    }

    // 需要拿到 302 Location 自己改写（release 下载会跳到 objects.githubusercontent.com）
    const cacheable = request.method === 'GET' && CACHEABLE_HOSTS.has(target.hostname);
    const body = ['GET', 'HEAD'].includes(request.method) ? null : request.body;

    let upstream;
    try {
      upstream = await fetch(target.toString(), {
        method: request.method,
        headers,
        body,
        redirect: 'manual',
        ...(cacheable ? { cf: { cacheEverything: true, cacheTtl: 3600 } } : {}),
      });
    } catch (e) {
      return text(502, 'Upstream error: ' + e.message);
    }

    const resHeaders = new Headers();
    for (const [k, v] of upstream.headers) {
      const lk = k.toLowerCase();
      if (HOP_BY_HOP.includes(lk) || STRIP_RESPONSE.includes(lk)) continue;
      resHeaders.set(k, v);
    }
    resHeaders.set('access-control-allow-origin', '*');
    resHeaders.set('access-control-expose-headers', '*');
    resHeaders.set('x-proxy-by', 'cf-worker-github-proxy');

    // 3xx：把跳转目标改回代理域，否则客户端会去直连源站
    if (upstream.status >= 300 && upstream.status < 400) {
      const loc = upstream.headers.get('location');
      if (loc) {
        try {
          const abs = new URL(loc, target.toString());
          resHeaders.set('location', ALLOWED_HOSTS.has(abs.hostname)
            ? proxyUrl(url, abs)
            : loc);
        } catch {
          resHeaders.set('location', loc);
        }
      }
      return new Response(null, { status: upstream.status, headers: resHeaders });
    }

    // 流式转发，不在 Worker 里缓冲整个文件
    return new Response(['HEAD'].includes(request.method) ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: resHeaders,
    });
  },
};

function resolveTarget(url) {
  for (const [prefix, base] of Object.entries(SHORTCUTS)) {
    if (url.pathname.startsWith(prefix)) {
      return new URL(base + url.pathname.slice(prefix.length) + url.search);
    }
  }
  // 通用形式：/https://host/path 或 /https:/host/path
  let s = (url.pathname + url.search).replace(/^\/+/, '');
  s = s.replace(/^(https?):\/([^/])/i, '$1://$2');
  return new URL(s);
}

function proxyUrl(selfUrl, abs) {
  return selfUrl.origin + '/https://' + abs.hostname + abs.pathname + abs.search;
}

function text(status, body) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
