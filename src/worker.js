// Cloudflare Worker 用エントリ。/api/* を処理し、それ以外は index.html を返す
import { handleApi, fetchHtml } from './core.js';
// wrangler は .html をテキストとして同梱する
import indexHtml from '../index.html';

const list = (s) => s?.split(',').map((h) => h.trim()).filter(Boolean) ?? [];

export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    const allowedHosts = list(env.ALLOWED_HOSTS);
    // 取得したページは Cloudflare のキャッシュに 5 分置く
    const get = (url) => fetchHtml(url, { cf: { cacheTtl: 300, cacheEverything: true } });
    const api = await handleApi(u, { fetchHtml: get, allowedHosts });
    if (api) {
      // GitHub Pages など別オリジンの画面から呼べるよう、許可したオリジンにだけ CORS ヘッダーを付ける
      const origin = request.headers.get('Origin');
      const headers = origin && list(env.ALLOWED_ORIGINS).includes(origin)
        ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
      return Response.json(api.body, { status: api.status, headers });
    }
    if (u.pathname !== '/' && u.pathname !== '/index.html') return new Response('Not found', { status: 404 });
    return new Response(indexHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  },
};
