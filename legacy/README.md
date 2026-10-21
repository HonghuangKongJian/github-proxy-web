# GitHub 加速代理（Cloudflare Worker）

用 Cloudflare Worker 反向代理 GitHub，解决国内访问 github.com、raw.githubusercontent.com、
release 下载、git clone 不稳定的问题。免费额度足够个人使用（10 万请求/天）。

## 一、部署

前提：一个域名，NS 托管到 Cloudflare（免费 plan 即可）。

```bash
# 安装并登录
npm i -g wrangler
wrangler login

# 改 wrangler.toml 里的 gh.example.com 为你的域名
# 然后部署
wrangler deploy
```

也可以完全不用命令行：Cloudflare 控制台 → Workers 和 Pages → 创建 → 粘贴 `worker.js`
→ 设置 → 触发器 → 添加自定义域。

> **重要**：`*.workers.dev` 域名在国内基本不可达，**必须绑定自己的域名**。

## 二、用法

假设你的代理域是 `gh.example.com`：

### 1. 下载仓库 / release

```bash
# 通用形式（最稳，任何 github.com 链接都能套）
https://gh.example.com/https://github.com/user/repo/releases/download/v1.0/app.zip

# 简写
https://gh.example.com/gh/user/repo
```

### 2. 加速单个文件

```bash
https://gh.example.com/raw/user/repo/main/README.md
# 等价于 raw.githubusercontent.com/user/repo/main/README.md
```

### 3. git clone

```bash
git clone https://gh.example.com/https://github.com/user/repo.git
# 或
git clone https://gh.example.com/gh/user/repo.git
```

全局改写，以后照常复制 GitHub 地址就能自动走代理：

```bash
git config --global url."https://gh.example.com/https://github.com/".insteadOf "https://github.com/"
```
取消：`git config --global --unset url."https://gh.example.com/https://github.com/".insteadOf`

配合浅克隆，大仓库能从几分钟压到几秒：

```bash
git clone --depth 1 --single-branch https://gh.example.com/gh/user/repo.git
```

### 4. CI 里用

GitHub Actions / 自建 Runner 只需给 git 和 curl 设代理变量：

```bash
export http_proxy=http://your-proxy:port
export https_proxy=http://your-proxy:port
```
或者在 `~/.gitconfig` 里配 `insteadOf`（见上）。

## 三、注意事项

- **别开成开放代理**：`ALLOWED_HOSTS` 白名单务必保留，否则会被扫到后拿去代理任意网站，
  轻则流量被刷爆，重则域名被 Cloudflare 处置。
- **Worker 免费额度**：10 万请求/天、CPU 10ms/请求。这里用流式转发不缓冲文件，
  下载大文件基本不占 CPU，但单日请求数要留意。
- **CF 在国内也不是银弹**：晚高峰电信/联通访问 Cloudflare 也会抖。可以配多个自定义域
  （CF 一个、Vercel 一个），在 `.gitconfig` 里切。
- **合规**：这套东西加速的是公开代码资源，遵守当地网络管理相关规定，别拿去干别的。

## 四、不想自己搭的替代方案

| 场景 | 方案 | 说明 |
|---|---|---|
| 单个静态文件 | `https://cdn.jsdelivr.net/gh/user/repo@版本/路径` | 零成本，国内有节点，最省事 |
| 整个仓库长期镜像 | Gitee「导入 GitHub 仓库」 | 最稳定，适合团队内部常驻依赖 |
| npm 包 | `npm config set registry https://registry.npmmirror.com` | 与 GitHub 无关但常被一起卡住 |
| Python 包 | `-i https://pypi.tuna.tsinghua.edu.cn/simple` | 同上 |
| Docker 镜像 | 配置 `registry-mirrors`（云厂商加速器） | 同上 |
| 临时下载 | 公共 ghproxy 类镜像站 | 搜一下就有，但随时可能失效/限速，别放生产 |

## 五、自建之外的兜底

如果 Cloudflare 在你所在线路长期表现差，自建代理的下一档方案是境外 VPS 跑 nginx 反代
（选 CN2 GIA / 家宽好的线路），配置比 Worker 稍麻烦但链路可控。
