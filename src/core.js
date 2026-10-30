// 記事一覧ページ → 各記事の埋め込み動画を抽出する処理（Node サーバーと Cloudflare Worker で共通）

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX_PAGES = 50;

export async function fetchHtml(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&#0?38;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'");
}

function absolutize(href, base) {
  try {
    const u = new URL(decodeEntities(href), base);
    u.hash = '';
    return u.href;
  } catch { return null; }
}

const EXCLUDE = /\/(category|tag|tags|page|feed|author|wp-content|wp-json|wp-admin|wp-login|search|comments|login|privacy|contact|about)(\/|$)|[?&](s|replytocom|share)=|\.(jpe?g|png|gif|webp|svg|css|js|xml|pdf|zip)$/i;

// 一覧ページから記事リンクと次ページURLを取り出す
export function extractList(html, baseUrl, filter) {
  const base = new URL(baseUrl);
  const links = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = absolutize(m[1], baseUrl);
    if (!url || seen.has(url)) continue;
    const u = new URL(url);
    if (u.host !== base.host || !/^https?:$/.test(u.protocol)) continue;
    if (u.pathname === '/' || url.replace(/\/$/, '') === baseUrl.replace(/\/$/, '')) continue;
    if (filter ? !filter.test(url) : EXCLUDE.test(url)) continue;
    seen.add(url);
    const title = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    links.push({ url, title });
  }
  if (!filter) {
    // 記事っぽいURL（日付・数字・articles 等）が多数あれば、それだけに絞る
    const articleLike = links.filter(l => /\/(20\d\d|\d{3,}|articles?|posts?|entry|archives|recipe|blog)[\/-]/i.test(new URL(l.url).pathname + '/'));
    if (articleLike.length >= 5) return { links: articleLike, next: findNext(html, baseUrl) };
  }
  return { links, next: findNext(html, baseUrl) };
}

function findNext(html, baseUrl) {
  const pats = [
    /<link\b[^>]*rel=["']next["'][^>]*href=["']([^"']+)["']/i,
    /<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']next["']/i,
    /<a\b[^>]*rel=["']next["'][^>]*href=["']([^"']+)["']/i,
    /<a\b[^>]*href=["']([^"']+)["'][^>]*rel=["']next["']/i,
    /<a\b[^>]*class=["'][^"']*\bnext\b[^"']*["'][^>]*href=["']([^"']+)["']/i,
    /<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*\bnext\b[^"']*["']/i,
  ];
  for (const p of pats) {
    const m = html.match(p);
    if (m) return absolutize(m[1], baseUrl);
  }
  return null;
}

// 記事HTMLから動画を抽出
export function extractVideos(html, pageUrl) {
  const out = [];
  const seen = new Set();
  const add = (v) => { const k = v.type + ':' + v.id; if (!seen.has(k)) { seen.add(k); out.push(v); } };
  const text = decodeEntities(html);

  for (const m of text.matchAll(/(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?(?:[^"'\s]*&)?v=|shorts\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/g)) {
    if (m[1] !== 'videoseries') add({ type: 'youtube', id: m[1] });
  }
  for (const m of text.matchAll(/(?:player\.vimeo\.com\/video\/|vimeo\.com\/)(\d{6,})/g)) add({ type: 'vimeo', id: m[1] });
  // <video> ごとに1本。src は拡張子なしのURLもあるため type や拡張子に頼らず拾い、複数の <source> があれば mp4 を優先する
  for (const m of text.matchAll(/<video\b([^>]*)>([\s\S]*?)<\/video>/gi)) {
    const cands = [];
    const own = m[1].match(/\b(?:data-)?src=["']([^"']+)["']/i);
    if (own) cands.push({ src: own[1], type: '' });
    for (const s of m[2].matchAll(/<source\b([^>]*)>/gi)) {
      const src = s[1].match(/\b(?:data-)?src=["']([^"']+)["']/i);
      const type = (s[1].match(/\btype=["']([^"']+)["']/i) || [])[1] || '';
      if (src) cands.push({ src: src[1], type });
    }
    const usable = cands.filter((c) => !/^(blob|data):/i.test(c.src));
    const best = usable.find((c) => /mp4/i.test(c.type) || /\.mp4(\?|$)/i.test(c.src)) || usable[0];
    const u = best && absolutize(best.src, pageUrl);
    if (u) add({ type: 'file', id: u });
  }
  const og = text.match(/<meta\b[^>]*property=["']og:video(?::url|:secure_url)?["'][^>]*content=["']([^"']+)["']/i);
  if (og) {
    const u = absolutize(og[1], pageUrl);
    if (u && /\.(mp4|webm|ogv|mov)(\?|$)/i.test(u)) add({ type: 'file', id: u });
  }
  return out;
}

function pageTitle(html) {
  const m = html.match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) || html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? decodeEntities(m[1]).trim() : '';
}

// allowedHosts を渡すと、そのホスト（とサブドメイン）以外の取得を拒否する
function checkUrl(u, allowedHosts) {
  const parsed = new URL(u);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('http/https のURLのみ対応しています');
  if (allowedHosts?.length && !allowedHosts.some((h) => parsed.hostname === h || parsed.hostname.endsWith('.' + h))) {
    throw new Error(`このサーバーでは ${parsed.hostname} は取得できません`);
  }
  return parsed.href;
}

/**
 * /api/* のリクエストを処理する。API 以外のパスなら null を返す。
 * @param {URL} u リクエストURL
 * @param {{ fetchHtml?: (url: string) => Promise<string>, allowedHosts?: string[] }} opts
 * @returns {Promise<{ status: number, body: object } | null>}
 */
export async function handleApi(u, { fetchHtml: get = fetchHtml, allowedHosts } = {}) {
  try {
    if (u.pathname === '/api/list') {
      let url = checkUrl(u.searchParams.get('url'), allowedHosts);
      const pages = Math.min(Math.max(parseInt(u.searchParams.get('pages') || '1', 10), 1), MAX_PAGES);
      const f = u.searchParams.get('filter');
      const filter = f ? new RegExp(f) : null;
      const all = [];
      const seen = new Set();
      let fetched = 0;
      while (url && fetched < pages) {
        const html = await get(url);
        fetched++;
        const { links, next } = extractList(html, url, filter);
        for (const l of links) if (!seen.has(l.url)) { seen.add(l.url); all.push(l); }
        url = next && !seen.has(next) ? checkUrl(next, allowedHosts) : null;
      }
      return { status: 200, body: { links: all, pagesFetched: fetched } };
    }
    if (u.pathname === '/api/videos') {
      const url = checkUrl(u.searchParams.get('url'), allowedHosts);
      const html = await get(url);
      return { status: 200, body: { title: pageTitle(html), videos: extractVideos(html, url) } };
    }
    return null;
  } catch (e) {
    return { status: 500, body: { error: String(e.message || e) } };
  }
}
