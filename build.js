/**
 * 把 page.html 内联进 worker.js，产出一个单文件 dist/worker.js。
 *
 * 用途：Cloudflare 控制台不支持自定义 module rules，无法 import .html。
 * 想直接在控制台粘贴部署时，先跑 `node build.js`，再粘贴 dist/worker.js 的内容。
 *
 * 用 wrangler 命令行部署的话不需要这个文件。
 */
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const html = fs.readFileSync(path.join(dir, 'page.html'), 'utf8');
const src = fs.readFileSync(path.join(dir, 'worker.js'), 'utf8');

const IMPORT_LINE = "import pageHtml from './page.html';";
if (!src.includes(IMPORT_LINE)) {
  console.error('worker.js 里找不到引入 page.html 的那一行，build 中止');
  process.exit(1);
}

const out = src.replace(IMPORT_LINE, 'const pageHtml = ' + JSON.stringify(html) + ';');

const dist = path.join(dir, 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'worker.js'), out);
// 让 dist/worker.js 在本地跑自测时被识别为 ESM
fs.writeFileSync(path.join(dist, 'package.json'), '{ "type": "module" }\n');

console.log('已生成 dist/worker.js（' + (out.length / 1024).toFixed(1) + ' KB），可直接粘贴到 Cloudflare 控制台');
