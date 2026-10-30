// ローカル実行用サーバー（依存パッケージなし）。抽出処理は src/core.js
// 使い方: node server.js → http://localhost:3000
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi, fetchHtml } from './src/core.js';

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const allowedHosts = process.env.ALLOWED_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean);

// 同じページを何度も取りに行かないようメモリにキャッシュする
const cache = new Map();
async function cachedFetchHtml(url) {
  if (!cache.has(url)) cache.set(url, await fetchHtml(url));
  return cache.get(url);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const api = await handleApi(u, { fetchHtml: cachedFetchHtml, allowedHosts });
  if (api) {
    res.writeHead(api.status, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(api.body));
  }
  // 静的ファイル
  const file = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': (types[path.extname(full)] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`AutoPlayer: http://localhost:${PORT}`));
