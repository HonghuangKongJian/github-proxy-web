# GitHub 加速下载站

带网页界面的 GitHub 代理，生成的每条链接都含服务端签名的随机码，防止被人当公共代理批量刷。

> **线上站点**：[https://gh.amw3.eu.org](https://gh.amw3.eu.org) | **洪荒空间门户**：[https://amw3.eu.org](https://amw3.eu.org) | **仓库**：[https://github.com/HonghuangKongJian/github-proxy-web](https://github.com/HonghuangKongJian/github-proxy-web)
>
> Worker 名 `github-proxy-web`，签名密钥已通过 `wrangler secret` 注入（不入库）。
> 换域名只需改 `wrangler.toml` 里的 `routes`，再跑 `npm run deploy`。

两个版本，按需取用：

| 目录 | 适用场景 |
|---|---|
| 仓库根目录 | **网页版**，带签名随机码，可公开给别人用 |
| `legacy/` | 初版，无签名，仅供自己使用（clone 下来 `wrangler deploy` 即可） |

```
用户粘贴链接 → 浏览器算 PoW → 服务端签发带随机码的链接 → 凭签名代理 GitHub
```

## 防滥用的三层设计

| 层 | 机制 | 挡住什么 |
|---|---|---|
| 1 | **HMAC 签名随机码** | 链接无法自行拼造、无法枚举。随机码 132 bit，暴力猜不到 |
| 2 | **签名绑定 URL 前缀 + 有效期** | 一条链接只能访问它当初签发的那个地址（含其子路径），到期自动作废 |
| 3 | **PoW + IP 限速** | 脚本批量签发要先烧 CPU，再撞每分钟配额 |

三层都是**无状态**的，不需要 KV / D1 / Durable Objects，免费 plan 直接跑。

### 细节说明

**签名覆盖「前缀」而不是完整 URL**，是为了兼容 `git clone`。Git 会在仓库地址后面追加
`/info/refs`、`/git-upload-pack`，这些路径签发时并不存在。所以签名绑定前缀，并要求
请求路径必须等于前缀或以 `前缀/` 开头，避免越权访问同域其他资源。

**302 跳转会重新签名**。下载 Release 附件时 GitHub 会跳到 `objects.githubusercontent.com`，
这个地址不在原签名的覆盖范围内，Worker 会用同一组参数给它续签后再返回，
否则客户端会脱离代理去裸连源站。

**限速用 Cache API 计数**，不消耗 KV 配额。计数条目被边缘节点驱逐时会自动重置——
对限速这种软约束可以接受，如果你需要严格计数，换成 KV 或 Durable Objects。

## 部署

### 方式 A：wrangler 命令行（推荐）

```bash
npm install
npx wrangler login

# 设置签名密钥（务必换成自己的随机串）
openssl rand -hex 32 | npx wrangler secret put PROXY_SECRET

# 改 wrangler.toml 里的 gh.example.com
npm run deploy
```

域名需已把 NS 托管到 Cloudflare。`*.workers.dev` 在国内不可达，**必须绑自定义域**。

### 方式 B：控制台粘贴

控制台不支持 `import './page.html'`，先打包成单文件：

```bash
node build.js
```

然后把 `dist/worker.js` 的内容整段粘进控制台编辑器，
再到「设置 → 变量和机密」里添加 `PROXY_SECRET`。

## 配置项

在 `wrangler.toml` 的 `[vars]` 里改，改完重新 deploy：

| 变量 | 默认 | 说明 |
|---|---|---|
| `LINK_TTL` | `7200` | 链接有效期（秒）。公开站点建议 1~2 小时 |
| `POW_DIFF` | `4` | PoW 难度，即哈希前几位须为 0。每 +1，生成耗时约翻 16 倍 |
| `RL_SIGN` | `20` | 单 IP 每分钟最多签发多少条链接 |
| `RL_PROXY` | `300` | 单 IP 每分钟最多多少次代理请求 |
| `PORTAL_URL` | `https://amw3.eu.org/` | 门户地址；设为 `-` 可隐藏「返回门户」按钮 |
| `PROXY_SECRET` | — | HMAC 密钥，走 secret 设置，**不要写进配置文件** |

`POW_DIFF` 调到 5 时，中低端手机生成链接要等 5 秒以上，一般保持 4 即可。

## 公开给别人用之前，务必先看这段

1. **改掉默认密钥。** 不设 `PROXY_SECRET` 会用内置默认值，等于签名形同虚设。
2. **Cloudflare 免费 plan 有 10 万请求/天的额度**，Worker 请求超限会直接 503。
   公开站点建议上 Workers Paid（$5/月），或在 Cloudflare 控制台给这个 Worker 配告警。
3. **大文件走 Worker 会消耗出口流量**。如果预期有人下载 GB 级内容，考虑只对
   Release 走代理、其余引导到 jsDelivr。
4. **你对该域名下的访问行为负责**。页面底部保留「仅用于加速公开代码资源」的声明，
   建议在 Cloudflare 里开启访问日志，发现异常直接把域名指向撤掉。
5. 想进一步收紧，可以把 `LINK_TTL` 降到 1800（半小时），`RL_SIGN` 降到 5。

## 自测

改完代码跑一遍，21 项用例覆盖签发、代理、越权拦截、过期、跳转续签、限速：

```bash
npm test
```

`test.mjs` 驱动的是 `dist/worker.js` 的真实代码，只 mock 了 `caches` 和 `fetch`，
所以签名、PoW、限速这些逻辑都是真跑。改动过签发或校验逻辑的话，建议必跑。

## 文件说明

| 文件 | 作用 |
|---|---|
| `worker.js` | 全部逻辑：网页路由、签发接口、签名校验、代理转发、PoW 验证、限速 |
| `page.html` | 网页界面，含前端 PoW 计算 |
| `wrangler.toml` | 部署配置与可调参数 |
| `build.js` | 把 HTML 内联成单文件，供控制台粘贴部署 |
| `test.mjs` | 端到端自测，21 项用例 |
| `dist/worker.js` | build 产物（控制台部署用） |

## 日常用法

网页上粘贴链接即可。命令行下，把生成的链接直接用于 clone：

```bash
git clone https://你的域名/p/xxxxx.xxxxxxxx.xxxxxxxxxxxxxx/https://github.com/user/repo.git
```

想让所有 GitHub 地址自动走这条通道：

```bash
git config --global url."https://你的域名/p/xxxxx.xxxxxxxx.xxxxxxxxxxxxxx/https://github.com/".insteadOf "https://github.com/"
```

链接过期后重新生成一条，改一下配置即可。

## 本地调试

```bash
cp .dev.vars.example .dev.vars   # 填入 PROXY_SECRET
npm run dev
```

打开 `http://localhost:8787` 即可看到页面。
