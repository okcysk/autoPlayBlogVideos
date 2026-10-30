// ローカル実行用サーバー（依存パッケージなし）。抽出処理は src/core.js、画面は index.html
// 使い方: node server.js → http://localhost:3000
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi, fetchHtml } from './src/core.js';

const PORT = process.env.PORT || 3000;
const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');
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
  // 画面は index.html だけを返す（server.js などほかのファイルは配信しない）
  if (u.pathname !== '/' && u.pathname !== '/index.html') { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(INDEX, (err, data) => {
    if (err) { res.writeHead(500); return res.end('index.html not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`AutoPlayer: http://localhost:${PORT}`));
