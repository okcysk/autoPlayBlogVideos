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

// Referer チェックで守られた動画配信元。値は付けるべき Referer
const PROXY_REFERERS = [
  [/^(.+\.)?tokyomotion\.net$/i, 'https://www.tokyomotion.net/'],
  [/^(.+\.)?po-kaki-to\.com$/i, 'https://www.po-kaki-to.com/'],
];
function proxyReferer(url) {
  try {
    const host = new URL(url).hostname;
    return PROXY_REFERERS.find(([re]) => re.test(host))?.[1] || null;
  } catch { return null; }
}

// 記事から外部動画サイトへのリンクを拾う（埋め込みを持たずリンクだけ貼るまとめブログ用）
const VIDEO_LINK_HOSTS = [
  /(^|\.)tokyomotion\.net$/i, /(^|\.)pornhub\.com$/i, /(^|\.)pornhubpremium\.com$/i,
  /(^|\.)youtube\.com$/i, /(^|\.)youtu\.be$/i, /(^|\.)dailymotion\.com$/i, /(^|\.)dai\.ly$/i,
  /(^|\.)vimeo\.com$/i, /(^|\.)nicovideo\.jp$/i, /(^|\.)nico\.ms$/i,
  /(^|\.)xvideos\.com$/i, /(^|\.)xhamster\.com$/i, /(^|\.)fc2\.com$/i, /(^|\.)youjizz\.com$/i,
];
function extractVideoLinks(html, pageUrl) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
    const u = absolutize(m[1], pageUrl);
    if (!u || seen.has(u)) continue;
    try {
      if (VIDEO_LINK_HOSTS.some((re) => re.test(new URL(u).hostname))) { seen.add(u); out.push(u); }
    } catch { /* ignore */ }
  }
  return out;
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
  for (const m of text.matchAll(/(?:dailymotion\.com\/(?:embed\/)?video\/|geo\.dailymotion\.com\/player[^"'\s]*[?&]video=|dai\.ly\/)([a-zA-Z0-9]{5,})/g)) add({ type: 'dailymotion', id: m[1] });
  for (const m of text.matchAll(/(?:nicovideo\.jp\/watch\/|nico\.ms\/)((?:sm|nm|so)\d+)/g)) add({ type: 'niconico', id: m[1] });
  for (const m of text.matchAll(/tokyomotion\.net\/embed\/([0-9a-f]{16,40})/gi)) add({ type: 'tokyomotion', id: m[1].toLowerCase() });
  for (const m of text.matchAll(/pornhub(?:premium)?\.com\/(?:embed\/|view_video\.php\?[^"'\s]*viewkey=)([a-z0-9]{10,16})/gi)) add({ type: 'pornhub', id: m[1].toLowerCase() });
  for (const m of text.matchAll(/javynow\.com\/player\/(\d+)/gi)) add({ type: 'javynow', id: m[1] });
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
    // m3u8 はブラウザで直接再生できないため除外（mp4 等があればそちらが選ばれる）
    const usable = cands.filter((c) => !/^(blob|data):/i.test(c.src) && !/\.m3u8(\?|$)/i.test(c.src));
    const best = usable.find((c) => /mp4/i.test(c.type) || /\.mp4(\?|$)/i.test(c.src)) || usable[0];
    const u = best && absolutize(best.src, pageUrl);
    if (u) add({ type: 'file', id: u });
  }
  // Twitter(X) の動画MP4（twi-dl 等の保存サイトに直リンクで載る）
  for (const m of text.matchAll(/https:\/\/video\.twimg\.com\/amplify_video\/[^"'\s]+?\.mp4/g)) add({ type: 'file', id: m[0] });
  // twihub は /r/v/<tweet_id> が mp4 へリダイレクトする（投稿ページ内のダウンロードリンク）
  try {
    if (/(^|\.)twihub\.link$/i.test(new URL(pageUrl).hostname)) {
      for (const m of text.matchAll(/href="\/r\/v\/(\d+)"/g)) add({ type: 'file', id: `https://twihub.link/r/v/${m[1]}` });
    }
  } catch { /* ignore */ }
  // Youjizz は JSON 内に //host/videos/...h264.mp4 の直リンク（\/ エスケープ済み・複数画質）がある。最高画質を拾う
  const yjUrls = [...text.replace(/\\\//g, '/').matchAll(/\/\/[a-z0-9.-]*youjizz\.com\/videos\/[^"'\s]+?h264\.mp4[^"'\s]*/g)].map((m) => 'https:' + m[0]);
  if (yjUrls.length) add({ type: 'file', id: yjUrls[yjUrls.length - 1] });
  const og = text.match(/<meta\b[^>]*property=["']og:video(?::url|:secure_url)?["'][^>]*content=["']([^"']+)["']/i);
  if (og) {
    const u = absolutize(og[1], pageUrl);
    if (u && /\.(mp4|webm|ogv|mov)(\?|$)/i.test(u)) add({ type: 'file', id: u });
  }
  // TokyoMotion は記事内の <video> が /vsrc/.../<embedと同じハッシュ> の mp4 を指す。
  // 取れていればシーク・終了検知が効く file を優先し、操作不能な埋め込み側は捨てる
  const fileIds = out.filter((v) => v.type === 'file').map((v) => v.id);
  if (fileIds.length) {
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].type === 'tokyomotion' && fileIds.some((u) => u.includes('/' + out[i].id))) out.splice(i, 1);
    }
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
 * @param {{ fetchHtml?: (url: string) => Promise<string>, allowedHosts?: string[], headers?: { get?: (k: string) => string | null, range?: string } }} opts
 * @returns {Promise<{ status: number, body: object, headers?: object, stream?: boolean } | null>}
 */
export async function handleApi(u, { fetchHtml: get = fetchHtml, allowedHosts, headers } = {}) {
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
      let videos = extractVideos(html, url);
      // 記事内に埋め込みがなく外部動画サイトへのリンクだけの場合、リンク先ページから抽出する
      if (!videos.length) {
        const keys = new Set();
        for (const l of extractVideoLinks(html, url).slice(0, 3)) {
          try {
            for (const v of extractVideos(await get(l), l)) {
              const k = v.type + ':' + v.id;
              if (!keys.has(k)) { keys.add(k); videos.push(v); }
            }
          } catch { /* リンク先が取れなくても他を試す */ }
        }
      }
      // TokyoMotion の埋め込みは外部から操作できないが、embed ページに mp4 直リンクが書かれている。
      // 取れたら file に置き換えてシーク・速度・終了検知を効かせる
      await Promise.all(videos.map(async (v) => {
        if (v.type === 'tokyomotion') {
          try {
            const embedUrl = `https://www.tokyomotion.net/embed/${v.id}`;
            const f = extractVideos(await get(embedUrl), embedUrl).find((x) => x.type === 'file');
            if (f) Object.assign(v, f);
          } catch { /* 取れなければ埋め込みのまま */ }
        }
      }));
      // Referer 必須の mp4 はプロキシ経由にする（ブラウザからは正しい Referer を送れないため）
      for (const v of videos) {
        if (v.type === 'file' && proxyReferer(v.id)) {
          v.id = `${u.origin}/api/proxy?u=${encodeURIComponent(v.id)}`;
        }
      }
      return { status: 200, body: { title: pageTitle(html), videos } };
    }
    if (u.pathname === '/api/proxy') {
      // Referer 必須サイトの動画を中継する。リダイレクトがあれば最終 URL を取ってから Range 付きで取り直す
      const target = u.searchParams.get('u') || '';
      const referer = proxyReferer(target);
      if (!referer) throw new Error('bad proxy url');
      const fwd = { 'User-Agent': UA, Referer: referer };
      // /vsrc/ は 301 で署名付き mp4 URL に飛ばす。最終 URL を取ってから Range 付きで取り直す
      const first = await fetch(target, { redirect: 'manual', headers: fwd });
      const loc = first.headers.get('location');
      const finalUrl = first.status >= 300 && first.status < 400 && loc ? new URL(loc, target).href : target;
      await first.body?.cancel?.();
      const range = headers?.get?.('range') || headers?.range;
      const up = await fetch(finalUrl, { redirect: 'follow', headers: { ...fwd, ...(range ? { Range: range } : {}) } });
      const outHeaders = {};
      for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const val = up.headers.get(k);
        if (val) outHeaders[k] = val;
      }
      return { status: up.status, headers: outHeaders, body: up.body, stream: true };
    }
    return null;
  } catch (e) {
    return { status: 500, body: { error: String(e.message || e) } };
  }
}
