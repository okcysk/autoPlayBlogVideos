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

// ページネーション判定用: ?p=2, ?page=2, /page/2/ 等のページ番号を除いたURLキー
const PAGE_PARAM = /^(p|page|pg|paged)$/i;
function pageKey(u) {
  try {
    const x = new URL(u);
    const params = [...x.searchParams.entries()].filter(([k]) => !PAGE_PARAM.test(k)).sort();
    const path = x.pathname.replace(/\/page\/\d+\/?$/i, '/');
    return x.host + path + '?' + params.map(([k, v]) => k + '=' + v).join('&');
  } catch { return null; }
}
function pageNum(u) {
  try {
    const x = new URL(u);
    const m = x.search.match(/[?&](?:p|page|pg|paged)=(\d+)/i) || x.pathname.match(/\/page\/(\d+)/i);
    return m ? +m[1] : 1;
  } catch { return 1; }
}

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
    // ページネーションリンク（?p=2, /page/2/ 等）は記事ではないので除外
    if (pageKey(url) === pageKey(baseUrl)) continue;
    if (filter ? !filter.test(url) : EXCLUDE.test(url)) continue;
    seen.add(url);
    const title = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // リンク内にサムネイル画像があれば拾う（twihub 等、一覧に画像付きで並ぶサイト用）
    const img = m[2].match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i);
    const thumb = img && /^https?:/i.test(absolutize(img[1], baseUrl) || '') ? absolutize(img[1], baseUrl) : null;
    links.push(thumb ? { url, title, thumb } : { url, title });
  }
  // monsnodes.com (Twitter Video Tools) はサーバー描画の一覧。再生対象は
  // redirect.php?v=<id> のリンクだけで、/v<disp_id> の詳細ページや投票リンクが混ざる。
  // redirect リンクと同じ順序で並ぶ /v リンクのタイトル(ユーザー名)を表示名に使う
  if (/^monsnode\.com$/i.test(base.host)) {
    const playable = links.filter(l => /\/redirect\.php\?v=\d+$/.test(l.url));
    if (!playable.length) return { links: [], next: null };
    const users = links.filter(l => /\/v\d+$/.test(new URL(l.url).pathname));
    playable.forEach((l, i) => { if (users[i] && users[i].title) l.title = users[i].title; });
    // 「More」リンクは ?page=N 形式で、/ は page=1 相当（?page=1 が2ページ目）。
    // /page/N/ の通常パターンと違い pageNum 判定では検出できないので直接組み立てる
    const np = new URL(baseUrl);
    const cur = parseInt(np.searchParams.get('page') || '0', 10) || 0;
    np.searchParams.set('page', String(cur + 1));
    return { links: playable, next: np.href };
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
  // rel=next がないサイト向け: ページ番号パラメータ(?p=2, ?page=2 等)や
  // /page/2/ パスが現在ページ+1になっているリンクを探す
  const baseKey = pageKey(baseUrl), baseNum = pageNum(baseUrl);
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
    const url = absolutize(m[1], baseUrl);
    if (url && pageKey(url) === baseKey && pageNum(url) === baseNum + 1) return url;
  }
  return null;
}

// Referer チェックで守られた動画配信元。値は付けるべき Referer
const PROXY_REFERERS = [
  [/^(.+\.)?tokyomotion\.net$/i, 'https://www.tokyomotion.net/'],
  [/^(.+\.)?po-kaki-to\.com$/i, 'https://www.po-kaki-to.com/'],
];
// Referer を付けると 403 になる等、プロキシ経由にしたいが Referer は不要な配信元
const PROXY_PLAIN = /(^|\.)(twimg\.com|twihub\.link)$/i;
function proxyReferer(url) {
  try {
    const host = new URL(url).hostname;
    return PROXY_REFERERS.find(([re]) => re.test(host))?.[1] || null;
  } catch { return null; }
}
function proxyTarget(url) {
  try {
    const host = new URL(url).hostname;
    if (proxyReferer(url) !== null || PROXY_PLAIN.test(host)) return true;
    return false;
  } catch { return false; }
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

// JS の単一引用符文字列リテラルのエスケープを戻す（eval は使わない）
function unescapeJs(s) {
  return s.replace(/\\(.)/gs, (m, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c));
}

// Dean Edwards packer で難読化されたスクリプトを復号する
function unpackPacked(html) {
  const m = html.match(/\}\('((?:[^'\\]|\\.)*)',(\d+),(\d+),'((?:[^'\\]|\\.)*)'\.split\('\|'\)/);
  if (!m) return null;
  const a = +m[2], c = +m[3];
  const p = unescapeJs(m[1]);
  const k = unescapeJs(m[4]).split('|');
  const e = (n) => (n < a ? '' : e(Math.floor(n / a))) + ((n % a) > 35 ? String.fromCharCode((n % a) + 29) : (n % a).toString(36));
  let out = p;
  for (let i = c - 1; i >= 0; i--) if (k[i]) out = out.replace(new RegExp('\\b' + e(i) + '\\b', 'g'), k[i]);
  return out;
}

// go.php の `var a="...";var b="..."` + atob(atob(b)+atob(a)) 難読化リダイレクトを復号する
function decodeAtobRedirect(html) {
  const a = html.match(/var a="([A-Za-z0-9+/=]+)"/)?.[1];
  const b = html.match(/var b="([A-Za-z0-9+/=]+)"/)?.[1];
  if (!a || !b) return null;
  try {
    const url = atob(atob(b) + atob(a));
    return /^https?:\/\//.test(url) ? url : null;
  } catch { return null; }
}

// monsnodes.com の redirect.php は `var u = atob('...')` で mp4 URL を難読化している
function decodeSingleAtob(html) {
  const m = html.match(/var u = atob\('([A-Za-z0-9+/=]+)'\)/);
  if (!m) return null;
  try {
    const url = atob(m[1]);
    return /^https?:\/\//.test(url) ? url : null;
  } catch { return null; }
}

// javynow のプレイヤーページから HLS(m3u8) の URL を取り出す。
// URL は署名付き（key=/end=）で期限があるため、再生直前に毎回取り直す必要がある
function javynowHlsUrl(html) {
  const re = /https:\/\/media\d+\.javynow\.com\/[^"'\s]+/;
  const direct = html.match(re);
  if (direct) return direct[0];
  const dec = unpackPacked(html);
  const m = dec && dec.match(re);
  return m ? m[0] : null;
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

// og:image / twitter:image から記事のサムネイルを取る
function pageThumb(html, pageUrl) {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)['"]/i.test(tag)) continue;
    const c = tag.match(/\bcontent=["']([^"']+)["']/i);
    if (!c) continue;
    const u = absolutize(c[1], pageUrl);
    if (u && /^https?:/i.test(u)) return u;
  }
  return null;
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
      // monsnodes.com (monsnodes Beta) は API 駆動のサイト。/api/list.php の JSON を記事リンクに変換する
      // ※ monsnodes.com (Twitter Video Tools) は別サイトで、上の extractList 側で処理する
      {
        const lu = new URL(url);
        if (/^monsnodes\.com$/i.test(lu.hostname)) {
          const isApi = lu.pathname.startsWith('/api/list.php');
          const apiBase = `https://${lu.host}/api/list.php`;
          // サイト側の sort=m/n/p は token=b64(sort文字) に対応（既定 m = 'bQ'）
          const SORT_TOKENS = { m: 'bQ', n: 'bg', p: 'cA' };
          let token = isApi ? (lu.searchParams.get('t') || 'bQ') : 'bQ';
          if (!isApi) {
            const s = lu.searchParams.get('sort');
            if (s && SORT_TOKENS[s]) token = SORT_TOKENS[s];
          }
          let page = isApi ? Math.max(1, parseInt(lu.searchParams.get('page') || '1', 10)) : 1;
          const all = [], seen = new Set();
          let fetched = 0, totalPages = page;
          while (fetched < pages) {
            const res = await fetch(`${apiBase}?t=${encodeURIComponent(token)}&page=${page}`, {
              headers: { 'User-Agent': UA, 'X-Requested-With': 'fetch' },
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${apiBase}`);
            const data = await res.json();
            fetched++;
            for (const it of data.items || []) {
              const link = `https://${lu.host}/api/go.php?d=${it.disp_id}&s=${it.sig}&t=video`;
              if (!seen.has(link)) {
                seen.add(link);
                all.push({ url: link, title: it.ex_user || '', thumb: it.thumb_url || null });
              }
            }
            totalPages = data.total_pages || page;
            page++;
            if (page > totalPages) break;
          }
          const next = page <= totalPages ? `${apiBase}?t=${encodeURIComponent(token)}&page=${page}` : null;
          return { status: 200, body: { links: all, pagesFetched: fetched, next } };
        }
      }
      const all = [];
      const seen = new Set();
      const pageSeen = new Set([url]);
      let fetched = 0;
      while (url && fetched < pages) {
        const html = await get(url);
        fetched++;
        const { links, next } = extractList(html, url, filter);
        for (const l of links) if (!seen.has(l.url)) { seen.add(l.url); all.push(l); }
        url = next && !pageSeen.has(next) ? checkUrl(next, allowedHosts) : null;
        if (url) pageSeen.add(url);
      }
      // ループを pages 上限で抜けた場合、url には未取得の次ページURLが残る
      return { status: 200, body: { links: all, pagesFetched: fetched, next: url } };
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
      // monsnodes の /api/go.php は atob 難読化ページで、復号すると video.twimg.com の mp4 直リンクになる。
      // monsnodes.com の /redirect.php も同様に `var u = atob(...)` で mp4 URL を隠している
      if (!videos.length && /monsnodes?\.com$/i.test(new URL(url).hostname)) {
        const m = decodeAtobRedirect(html) || decodeSingleAtob(html);
        if (m) videos.push({ type: 'file', id: m });
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
        // Javynow は操作 API のない iframe しかなかったが、プレイヤーが参照する
        // 署名付き HLS URL を取り出せば hls.js で全操作可能になる
        if (v.type === 'javynow') {
          try {
            const r = await fetch(`https://javynow.com/player/${v.id}/`, {
              headers: { 'User-Agent': UA, Referer: 'https://www.nukistream.com/' },
            });
            if (r.ok) {
              const hls = javynowHlsUrl(await r.text());
              if (hls) Object.assign(v, { type: 'hls', id: hls });
            }
          } catch { /* 取れなければ iframe のまま */ }
        }
      }));
      // twihub の /r/v/<id> は mp4 へ 302 する。ブラウザの <video> にリダイレクトを
      // 追わせると Referer 次第で video.twimg.com に 403 られることがあるため、
      // ここで最終 URL を解決して直接返す
      await Promise.all(videos.map(async (v) => {
        if (v.type === 'file' && /(^|\.|\/)twihub\.link\/r\/v\/\d+/.test(v.id)) {
          try {
            const r = await fetch(v.id, { redirect: 'manual', headers: { 'User-Agent': UA } });
            const loc = r.headers.get('location');
            await r.body?.cancel?.();
            if (r.status >= 300 && r.status < 400 && loc) v.id = new URL(loc, v.id).href;
          } catch { /* 解決失敗時は /r/v のまま */ }
        }
      }));
      // Referer 必須の mp4 はプロキシ経由にする（ブラウザからは正しい Referer を送れないため）
      for (const v of videos) {
        if (v.type === 'file' && proxyTarget(v.id)) {
          v.id = `${u.origin}/api/proxy?u=${encodeURIComponent(v.id)}`;
        }
      }
      const thumb = pageThumb(html, url);
      if (thumb) for (const v of videos) v.thumb = v.thumb || thumb;
      return { status: 200, body: { title: pageTitle(html), videos } };
    }
    if (u.pathname === '/api/proxy') {
      // Referer 必須サイトの動画を中継する。リダイレクトがあれば最終 URL を取ってから Range 付きで取り直す
      const target = u.searchParams.get('u') || '';
      const referer = proxyReferer(target);
      if (!referer && !PROXY_PLAIN.test(new URL(target).hostname)) throw new Error('bad proxy url');
      const fwd = { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) };
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
