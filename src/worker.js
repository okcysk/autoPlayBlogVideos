// Cloudflare Worker 用エントリ。public/ は静的アセットとして配信され、/api/* だけここで処理する
import { handleApi, fetchHtml } from './core.js';

export default {
  async fetch(request, env) {
    const allowedHosts = env.ALLOWED_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean);
    // 取得したページは Cloudflare のキャッシュに 5 分置く
    const get = (url) => fetchHtml(url, { cf: { cacheTtl: 300, cacheEverything: true } });
    const api = await handleApi(new URL(request.url), { fetchHtml: get, allowedHosts });
    if (api) return Response.json(api.body, { status: api.status });
    return env.ASSETS.fetch(request);
  },
};
