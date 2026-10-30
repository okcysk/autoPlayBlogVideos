// Cloudflare Worker 用エントリ。/api/* を処理し、それ以外は index.html を返す
import { handleApi, fetchHtml } from './core.js';
// wrangler は .html をテキストとして同梱する
import indexHtml from '../index.html';

export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    const allowedHosts = env.ALLOWED_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean);
    // 取得したページは Cloudflare のキャッシュに 5 分置く
    const get = (url) => fetchHtml(url, { cf: { cacheTtl: 300, cacheEverything: true } });
    const api = await handleApi(u, { fetchHtml: get, allowedHosts });
    if (api) return Response.json(api.body, { status: api.status });
    if (u.pathname !== '/' && u.pathname !== '/index.html') return new Response('Not found', { status: 404 });
    return new Response(indexHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  },
};
