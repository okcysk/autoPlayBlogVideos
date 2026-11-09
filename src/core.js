// 記事一覧ページ → 各記事の埋め込み動画を抽出する処理（Node サーバーと Cloudflare Worker で共通）

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX_PAGES = 50;

export async function fetchHtml(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8', ...(init.headers || {}) }, redirect: 'follow' });
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

// missav 系ミラー（missav.ws 等は Cloudflare チャレンジで直接取れない）。
// thisav.my は現行ミラーへリダイレクトする公式窓口だが、Worker の IP では 500 になる
// ことがあるため、現行ミラー直と元URLもフォールバック候補にする
// missav 系は Cloudflare Workers の IP ではブロックされるため、実際の取得は
// index.html がブラウザから直接行う（CORS がオリジンを反射するため可能）。
// ここでは一覧・動画の抽出ルールだけを担う
const MISSAV_HOST = /(^|\.)(missav\d*|thisav)\.[a-z.]+$/i;

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
    // missav は取得時に thisav.my へ書き換えるため、リンク先ホスト（現行ミラー）とずれる。ミラー同士は同一サイト扱い
    const sameSite = u.host === base.host || (MISSAV_HOST.test(base.host) && MISSAV_HOST.test(u.host));
    if (!sameSite || !/^https?:$/.test(u.protocol)) continue;
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
  // missav 系: 動画ページは /<lang>/<コード>-<数字> 形式。ナビやジャンル・メーカーリンクが混ざるので絞る。
  // 同じURLにサムネイル用リンクとタイトル用リンクがあるため、タイトルが取れる方を優先して統合する。
  // ページネーションは ?page=N で、取得元ホストとリンク先ホスト(ミラー)がずれるため直接探す
  if (MISSAV_HOST.test(base.host)) {
    const byUrl = new Map();
    for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = absolutize(m[1], baseUrl);
      if (!url) continue;
      try {
        const u = new URL(url);
        if (!MISSAV_HOST.test(u.hostname)) continue;
        // コードは「英数字-数字」（fway-107, fc2-ppv-5005658 等）。fc2 や naughty4610 の様な
        // ハイフン無し・末尾数字だけのメーカー/女優スラッグを弾くため -数字 を必須にする
        if (!/^\/(?:dm\d+\/)?[a-z]{2}\/[a-z0-9][a-z0-9-]*-\d+\/?$/i.test(u.pathname)) continue;
      } catch { continue; }
      const title = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      // missav の一覧画像は遅延読み込みで data-src に入っている（src は base64 プレースホルダ）
      const imgTag = m[2].match(/<img\b[^>]*>/i);
      const imgSrc = imgTag && (imgTag[0].match(/\bdata-src=["']([^"']+)["']/i) || imgTag[0].match(/\bsrc=["']([^"']+)["']/i));
      const thumb = imgSrc && /^https?:/i.test(absolutize(imgSrc[1], baseUrl) || '') ? absolutize(imgSrc[1], baseUrl) : null;
      // サムネイル用・再生時間・タイトルのリンクが同じURLで重複するので統合する。
      // 再生時間（1:23:45 形式）より正式なタイトルを優先する
      const prev = byUrl.get(url);
      const isDur = (t) => /^\d{1,2}:\d{2}/.test(t);
      const bestTitle = (prev?.title && !isDur(prev.title)) ? prev.title
        : (title && !isDur(title)) ? title : (prev?.title || title);
      byUrl.set(url, { url, title: bestTitle, ...(prev?.thumb || thumb ? { thumb: prev?.thumb || thumb } : {}) });
    }
    const vids = [...byUrl.values()];
    if (vids.length) {
      let next = null;
      const want = pageNum(baseUrl) + 1;
      for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
        const url = absolutize(m[1], baseUrl);
        if (!url || pageNum(url) !== want) continue;
        try {
          const u = new URL(url);
          if (MISSAV_HOST.test(u.hostname) && u.pathname === base.pathname) { next = url; break; }
        } catch { /* ignore */ }
      }
      return { links: vids, next };
    }
  }
  // YouTube はアンカーがJS描画で取れないため ytInitialData から一覧を復元する。
  // チャンネルの /videos 等が対象。続きは continuation API が必要なので next は無し
  if (/(^|\.)(youtube\.com|youtu\.be|music\.youtube\.com)$/i.test(base.host)) {
    const yt = extractYouTubeList(html);
    if (yt) {
      const links = filter ? yt.filter((l) => filter.test(l.url)) : yt;
      return { links, next: null };
    }
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
  // xvideos.com はサーバー描画。一覧は /video.<id>/<slug> リンクで、
  // サムネイルは親要素の data-video JSON に入っている。
  // ページネーションは /lang/japanese/N のようなパス末尾の番号
  if (/(^|\.)xvideos\.com$/i.test(base.host)) {
    const thumbs = new Map();
    for (const m of html.matchAll(/data-video='(\{[^']+\})'/g)) {
      try {
        const d = JSON.parse(m[1]);
        const t = d.sfwThumbUrl || d.mozaiqueListing;
        if (d.id && t) thumbs.set(d.id, t);
      } catch { /* ignore */ }
    }
    const byUrl = new Map();
    for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']*\/video\.[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = absolutize(m[1], baseUrl);
      if (!url) continue;
      const idm = url.match(/\/video\.([a-z0-9]+)\//i);
      const title = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const prev = byUrl.get(url);
      const better = title && !/^(video|watch)$/i.test(title) && (!prev?.title || title.length > prev.title.length);
      const thumb = (idm && thumbs.get(idm[1])) || prev?.thumb || null;
      byUrl.set(url, { url, title: better ? title : (prev?.title || ''), ...(thumb ? { thumb } : {}) });
    }
    let vids = [...byUrl.values()].filter((v) => v.title);
    if (filter) vids = vids.filter((l) => filter.test(l.url));
    // 末尾の数字を +1 したページへのリンクが実在する場合だけ next にする
    let next = null;
    try {
      const pm = base.pathname.match(/^(.*?)(?:\/(\d+))?\/?$/);
      const stem = pm[1] || '/';
      const cur = pm[2] ? +pm[2] : 1;
      const want = `${stem === '/' ? '' : stem}/${cur + 1}`;
      const has = [...html.matchAll(/href=["']([^"']+)["']/gi)].some((m2) => {
        const u2 = absolutize(m2[1], baseUrl);
        try { return u2 && new URL(u2).pathname === want; } catch { return false; }
      });
      if (has) next = new URL(want, base.origin).href;
    } catch { /* ignore */ }
    return { links: vids, next };
  }
  // xvideo-jp.com はサーバー描画のまとめブログ。記事は /sad/<id> と /archives/<id>。
  // 同じURLに画像リンク(.atd-img)とタイトルリンク(.mv-tlink)があるので統合する。
  // ページネーションは /page/N で findNext がそのまま検出できる
  if (/^xvideo-jp\.com$/i.test(base.host)) {
    const byUrl = new Map();
    for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = absolutize(m[1], baseUrl);
      if (!url) continue;
      try {
        if (new URL(url).hostname !== base.host) continue;
        if (!/^\/(?:sad|archives)\/\d+\/?$/.test(new URL(url).pathname)) continue;
      } catch { continue; }
      const title = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const imgTag = m[2].match(/<img\b[^>]*>/i);
      const imgSrc = imgTag && (imgTag[0].match(/\bdata-src=["']([^"']+)["']/i) || imgTag[0].match(/\bsrc=["']([^"']+)["']/i));
      const thumb = imgSrc && /^https?:/i.test(absolutize(imgSrc[1], baseUrl) || '') ? absolutize(imgSrc[1], baseUrl) : null;
      const prev = byUrl.get(url);
      const better = title && (!prev?.title || title.length > prev.title.length);
      byUrl.set(url, { url, title: better ? title : (prev?.title || ''), ...(prev?.thumb || thumb ? { thumb: prev?.thumb || thumb } : {}) });
    }
    let vids = [...byUrl.values()].filter((v) => v.title);
    if (filter) vids = vids.filter((l) => filter.test(l.url));
    return { links: vids, next: findNext(html, baseUrl) };
  }
  // openload.mov はサーバー描画。動画は /<cat>/op-<数字>/ 形式。
  // タイトルは <span>、サムネイルは <img> が同じ <a> 内にある。ページネーションなし
  if (/^openload\.mov$/i.test(base.host)) {
    const vids = [];
    const seen2 = new Set();
    for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = absolutize(m[1], baseUrl);
      if (!url || seen2.has(url)) continue;
      try {
        const u = new URL(url);
        if (u.host !== base.host) continue;
        const seg = u.pathname.split('/').filter(Boolean);
        if (seg.length !== 2 || !/\d/.test(seg[1])) continue;
      } catch { continue; }
      seen2.add(url);
      const title = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\d{1,2}:\d{2}(:\d{2})?\s*/, '');
      const img = m[2].match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i);
      const thumb = img && /^https?:/i.test(absolutize(img[1], baseUrl) || '') ? absolutize(img[1], baseUrl) : null;
      if (title) vids.push({ url, title, ...(thumb ? { thumb } : {}) });
    }
    const filtered = filter ? vids.filter((l) => filter.test(l.url)) : vids;
    return { links: filtered, next: findNext(html, baseUrl) };
  }
  if (!filter) {
    // 記事っぽいURL（日付・数字・articles 等）が多数あれば、それだけに絞る
    const articleLike = links.filter(l => /\/(20\d\d|\d{3,}|articles?|posts?|entry|archives|recipe|blog)[\/-]/i.test(new URL(l.url).pathname + '/'));
    if (articleLike.length >= 5) return { links: articleLike, next: findNext(html, baseUrl) };
  }
  return { links, next: findNext(html, baseUrl) };
}

// YouTube の動画URLから videoId を取り出す。watch ページは取得時に
// レート制限(429)されやすいため、動画URLならページを取らずに済ませる
function youtubeVideoId(u) {
  try {
    const url = new URL(u);
    const h = url.hostname.replace(/^(www|m|music)\./, '');
    if (!/(^|\.)youtube\.com$|^youtu\.be$/.test(h)) return null;
    const v = url.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    const m = url.pathname.match(/^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})/)
      || (h === 'youtu.be' && url.pathname.match(/^\/([A-Za-z0-9_-]{11})/));
    return m ? m[1] : null;
  } catch { return null; }
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
const PROXY_PLAIN = /(^|\.)(twimg\.com|twihub\.link|tapecontent\.net)$/i;
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

// 新しい packer 形式: eval(function(p,a,c,k,e,d){...}('...',radix,count,'dict'.split('|'),0,{}))
// トークンは count-1 〜 0 の 36 進表記で、辞書は出現順
function unpackPackedEval(html) {
  const m = html.match(/\}\('((?:[^'\\]|\\.)*)',(\d+),(\d+),'((?:[^'\\]|\\.)*)'\.split\('\|'\),\d+,\{[^}]*\}\)\)/);
  if (!m) return null;
  const k = unescapeJs(m[4]).split('|');
  let out = unescapeJs(m[1]);
  for (let i = +m[3] - 1; i >= 0; i--) {
    if (k[i]) out = out.replace(new RegExp('\\b' + i.toString(36) + '\\b', 'g'), k[i]);
  }
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

// openload.mov の動画ページは eval packer で難読化され、
// ストリームホスト（minochinos/streamtape/vsembed 等）の iframe URL を生成する。
// radix が 36 を超えるため e() をその場で再現する（unpackPackedEval は 36 進 index 前提で使えない）
function openloadEmbeds(html) {
  const m = html.match(/\}\('((?:[^'\\]|\\.)*)',(\d+),(\d+),'((?:[^'\\]|\\.)*)'\.split\('\|'\),\d+,\{[^}]*\}\)\)/);
  if (!m) return [];
  const a = +m[2], c = +m[3];
  const p = unescapeJs(m[1]);
  const k = unescapeJs(m[4]).split('|');
  const e = (n) => (n < a ? '' : e(Math.floor(n / a))) + ((n % a) > 35 ? String.fromCharCode((n % a) + 29) : (n % a).toString(36));
  let out = p;
  for (let i = c - 1; i >= 0; i--) if (k[i]) out = out.replace(new RegExp('\\b' + e(i) + '\\b', 'g'), k[i]);
  const urls = [...out.matchAll(/src="?(https?:\/\/[^"'\s>]+)/g)].map((x) => x[1]);
  // streamtape は get_video を解決して mp4 にできるので先頭に
  return [...urls.filter((u) => /streamtape\.com/.test(u)), ...urls.filter((u) => !/streamtape\.com/.test(u))];
}

// streamtape の /e/ ページは get_video のURLを
// `"/streamtape.com/get_" + ('XXXX...get_video?id=...').substring(n)...` のような
// 文字列連結+substring で難読化する（毎回パターンが変わる）。
// 文字列リテラル・+・括弧・.substring(n) だけの式に限定して評価する
function streamtapeVideoPaths(html) {
  const SAFE = /^(?:\s|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\(|\)|\+|\.substring\(\d+\))*$/;
  const out = new Set();
  for (const m of html.matchAll(/innerHTML\s*=\s*([^;]+);/g)) {
    const ex = m[1].trim();
    if (!ex.includes('video') || !SAFE.test(ex)) continue;
    try {
      const v = eval(ex);
      if (typeof v === 'string') {
        for (const u of v.matchAll(/(?:\/\/|https?:\/\/)?(?:[\w.-]*\.)?streamtape\.com\/(get_video\?[^\s"'<>]+)/g)) {
          out.add(u[1]);
        }
      }
    } catch { /* 式でなければ無視 */ }
  }
  return [...out];
}

// missav の動画ページは packer 難読化 JS に m3u8 URL（surrit.com）を埋め込む。
// surrit.com 自体は Cloudflare で塞がれているが、同じパスが複数の CDN ドメイン
// （サイトの /jmpres/ リダイレクト先）で配信されるため、/api/hls 側で CDN ホストに
// 付け替えて取得する
function missavHlsUrl(html) {
  const pick = (text) => {
    const urls = [...text.matchAll(/https:\/\/[^'"\s]+?\.m3u8[^'"\s]*/g)].map((m) => m[0]);
    return urls.find((u) => /playlist\.m3u8/.test(u)) || urls[0] || null;
  };
  const direct = pick(html);
  if (direct) return direct;
  for (const m of html.matchAll(/\}\('((?:[^'\\]|\\.)*)',(\d+),(\d+),'((?:[^'\\]|\\.)*)'\.split\('\|'\)/g)) {
    const dec = unpackPacked(m[0]);
    const u = dec && pick(dec);
    if (u) return u;
  }
  // 新しい eval ラップ形式の packer（辞書トークンがそのまま 36 進 index）
  for (const m of html.matchAll(/\}\('((?:[^'\\]|\\.)*)',\d+,\d+,'((?:[^'\\]|\\.)*)'\.split\('\|'\),\d+,\{[^}]*\}\)\)/g)) {
    const dec = unpackPackedEval(m[0]);
    const u = dec && pick(dec);
    if (u) return u;
  }
  return null;
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

// YouTube の ytInitialData（ページ内JSON）から動画一覧を拾う。
// チャンネルの /videos 等は初期HTMLに動画が埋め込まれているが、
// リンクはJS描画なのでアンカーでは取れない。videoRenderer / lockupViewModel 両形式に対応
function extractYouTubeList(html) {
  const i = html.indexOf('ytInitialData');
  if (i < 0) return null;
  const start = html.indexOf('{', html.indexOf('=', i));
  if (start < 0) return null;
  // 文字列リテラルを考慮して対応する閉じ括弧まで切り出す
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { end = j + 1; break; }
  }
  if (end < 0) return null;
  let data;
  try { data = JSON.parse(html.slice(start, end)); } catch { return null; }
  const out = [], seen = new Set();
  const ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const push = (id, title, thumb, url) => {
    if (!ID_RE.test(id || '') || seen.has(id)) return;
    seen.add(id);
    out.push({ url: url || `https://www.youtube.com/watch?v=${id}`, title: title || '', ...(thumb ? { thumb } : {}) });
  };
  const titleText = (t) => (t?.runs?.map((r) => r.text).join('') || t?.content || '');
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) walk(x); return; }
    if (typeof node.videoId === 'string') {
      const thumbs = node.thumbnail?.thumbnails;
      push(node.videoId, titleText(node.title), thumbs?.length ? thumbs[thumbs.length - 1].url : null);
    }
    const lv = node.lockupViewModel;
    if (lv && lv.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
      const meta = lv.metadata?.lockupMetadataViewModel;
      const img = lv.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image
        || lv.contentImage?.thumbnailViewModel?.image;
      const srcs = img?.sources;
      push(lv.contentId, meta?.title?.content || '', srcs?.length ? srcs[srcs.length - 1].url : null);
    }
    // Shorts タブは shortsLockupViewModel 形式（reelWatchEndpoint にIDとサムネイル）
    const sl = node.shortsLockupViewModel;
    if (sl) {
      const ep = sl.onTap?.innertubeCommand?.reelWatchEndpoint;
      const srcs = sl.thumbnailViewModel?.thumbnailViewModel?.image?.sources
        || sl.thumbnailViewModel?.image?.sources;
      push(ep?.videoId, sl.overlayMetadata?.primaryText?.content || '',
        srcs?.length ? srcs[srcs.length - 1].url : null,
        ep?.videoId ? `https://www.youtube.com/shorts/${ep.videoId}` : null);
    }
    for (const k of Object.keys(node)) walk(node[k]);
  };
  walk(data);
  return out.length ? out : null;
}

// 記事HTMLから動画を抽出
export function extractVideos(html, pageUrl) {
  const out = [];
  const seen = new Set();
  const add = (v) => { const k = v.type + ':' + v.id; if (!seen.has(k)) { seen.add(k); out.push(v); } };
  const text = decodeEntities(html);

  // xvideos の動画ページは html5player.setVideoUrlHigh/Low に mp4 直リンクがある。
  // 署名付きで期限があるためキュー投入時に毎回取り直す（ここで毎回抽出される）
  try {
    if (/(^|\.)xvideos\.com$/i.test(new URL(pageUrl).hostname)) {
      const hi = text.match(/html5player\.setVideoUrlHigh\('([^']+)'\)/);
      const lo = text.match(/html5player\.setVideoUrlLow\('([^']+)'\)/);
      const u = hi?.[1] || lo?.[1];
      if (u) return [{ type: 'file', id: u }];
    }
  } catch { /* ignore */ }

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
    // m3u8 はブラウザで直接再生できないため除外（mp4 等があればそちらが選ばれる）。
    // Vue の data-src="item.x ? cdnUrl(`...`)" のようなテンプレート式は空白・バッククォートを含むので弾く
    const usable = cands.filter((c) => !/^(blob|data):/i.test(c.src) && !/\.m3u8(\?|$)/i.test(c.src) && !/[\s`$]/.test(c.src));
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
  // missav 系は packer 難読化の m3u8 のみ。/jmpres/ プロキシ URL にして hls.js で再生する
  if (!out.length) {
    try {
      if (MISSAV_HOST.test(new URL(pageUrl).hostname)) {
        const hls = missavHlsUrl(text);
        if (hls) add({ type: 'hls', id: hls });
      }
    } catch { /* ignore */ }
  }
  return out;
}

export function pageTitle(html) {
  const m = html.match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) || html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? decodeEntities(m[1]).trim() : '';
}

// og:image / twitter:image から記事のサムネイルを取る
export function pageThumb(html, pageUrl) {
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
export async function handleApi(u, { fetchHtml: get = fetchHtml, allowedHosts, allowedOrigins, headers } = {}) {
  try {
    if (u.pathname === '/api/list') {
      let url = checkUrl(u.searchParams.get('url'), allowedHosts);
      // YouTube の動画URLを一覧に入れた場合はその1本だけを返す
      const ytSingle = youtubeVideoId(url);
      if (ytSingle) {
        return { status: 200, body: { links: [{ url, title: '', thumb: null }], pagesFetched: 0, next: null } };
      }
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
      // YouTube の動画URLはIDがURLに含まれるのでページ取得なしで返す
      const ytId = youtubeVideoId(url);
      if (ytId) return { status: 200, body: { title: '', videos: [{ type: 'youtube', id: ytId }] } };
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
      // openload.mov は packer 難読化JSに外部ホストの埋め込みURLがある。
      // streamtape は /e/ ページの get_video を解決すれば mp4 直リンクになるので優先する。
      // 解決できなければ埋め込みURLを iframe で開く（openload タイプ）
      if (!videos.length && /^openload\.mov$/i.test(new URL(url).hostname)) {
        const embeds = openloadEmbeds(html);
        const st = embeds.find((e) => /streamtape\.com\/e\//.test(e));
        if (st) {
          try {
            const eid = st.match(/\/e\/([A-Za-z0-9]+)/)?.[1];
            const ep = await get(`https://streamtape.com/e/${eid}`);
            // div内の平文 get_video はダミー（500を返す）。JSの結合式から復元したものを使う
            const candidates = streamtapeVideoPaths(ep);
            for (const gv of candidates) {
              try {
                const r = await fetch(`https://streamtape.com/${gv}`, {
                  redirect: 'follow',
                  headers: { 'User-Agent': UA, Referer: `https://streamtape.com/e/${eid}` },
                });
                const final = r.url;
                await r.body?.cancel?.();
                if (r.ok && /tapecontent\.net/.test(final)) { videos.push({ type: 'file', id: final }); break; }
              } catch { /* 次の候補 */ }
            }
          } catch { /* iframe フォールバックへ */ }
        }
        if (!videos.length && embeds[0]) videos.push({ type: 'openload', id: embeds[0] });
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
    if (u.pathname === '/api/hls') {
      // missav 系の HLS CDN は Origin ヘッダー付きのリクエストを弾いて tip 画像を返すため、
      // ブラウザの hls.js からは直接取れない。ここで Referer を付けて中継する。
      // プレイリスト内の URI はこのエンドポイント経由の URL に書き換える
      const target = u.searchParams.get('u') || '';
      const t = new URL(target);
      if (t.protocol !== 'https:') throw new Error('bad hls url');
      // CDN のドメインは頻繁に変わるためホスト制限はかけられない。
      // allowedOrigins が渡された場合は Origin ヘッダーを必須にして悪用を抑える
      const origin = headers?.get?.('origin') || headers?.origin || headers?.Origin || '';
      if (allowedOrigins?.length) {
        if (!origin || !allowedOrigins.includes(origin)) throw new Error('bad origin');
      }
      const range = headers?.get?.('range') || headers?.range;
      const fwd = { 'User-Agent': UA, Referer: 'https://www.missav06.net/', ...(range ? { Range: range } : {}) };
      // surrit.com は Cloudflare で塞がれているが、同じパスが複数 CDN ドメインで配信される
      // （サイトの /jmpres/ が 302 で振り分けている先）。その場合は CDN ホストに付け替えて試す
      let candidates = [target];
      if (/^(.+\.)?surrit\.com$/i.test(t.hostname)) {
        candidates = [];
        for (const d of ['vcsheaye.cc', 'vcmathe.com', 'vcjuligi.com', 'vckeepw.top']) {
          for (const s of ['vsd998', 'vsd999']) candidates.push(`https://${s}.${d}${t.pathname}${t.search}`);
        }
      }
      const playlistOut = (text, base) => {
        const proxyUrl = (uri) => `${u.origin}/api/hls?u=${encodeURIComponent(new URL(uri, base).href)}`;
        const rewritten = text.split('\n').map((line) => {
          const s = line.trim();
          if (!s) return line;
          if (s.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (m, uri) => `URI="${proxyUrl(uri)}"`);
          return proxyUrl(s);
        }).join('\n');
        const body = new ReadableStream({
          start(c) { c.enqueue(new TextEncoder().encode(rewritten)); c.close(); },
        });
        return { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8' }, body, stream: true };
      };
      for (const c of candidates) {
        try {
          const up = await fetch(c, { redirect: 'follow', headers: fwd });
          if (!up.ok) { await up.body?.cancel?.(); continue; }
          const ctype = up.headers.get('content-type') || '';
          const looksPlaylist = /\.m3u8($|\?)/i.test(new URL(c).pathname) || /mpegurl|m3u8/i.test(ctype);
          if (looksPlaylist) {
            const text = await up.text();
            if (text.includes('#EXTM3U')) return playlistOut(text, up.url || c);
            continue; // エラーページ等なら次のミラーを試す
          }
          const outHeaders = {};
          for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
            const val = up.headers.get(k);
            if (val) outHeaders[k] = val;
          }
          return { status: up.status, headers: outHeaders, body: up.body, stream: true };
        } catch { /* 次のミラーを試す */ }
      }
      throw new Error('hls source not found');
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
