// tiktok-live-kit/app/server.js  (v4)
// TikTok LIVE のイベントを受けて、オーバーレイ／リモコンへ配るブリッジサーバー。
//
// v4 の考え方（規約まわり）
//   ・運の要素なし：ギフトの「1個あたりのコイン数」で、起きることが必ず決まる（ギフト表＝bands）
//   ・景品なし：お返しは配信の中で なな が演じるもの（語尾・一人称・手元カメラ・ピアノ等）だけ
//   ・金額・ランキングは画面にもDiscordにもVRChatにも出さない（配信レポートのファイル記録だけは本人用に残す）
//
// サーバーが正本として持つもの（設定/kit_state.json に保存。再起動・OBSの再読込で消えない）
//   settings … 配信内容ラベル・モード（avatar/game）・雰囲気レイヤー・音・CHAIN秒数
//   bands    … コインのギフト表（何コインから何が起きるか）
//   style    … フォント・配色・枠
//   team     … みんなで達成ゲージ
//   slots    … 発動中の変身（声＝voice／手元カメラ＝cam／ボイスエフェクト＝vfx）と順番待ち
//   requests … ピアノのリクエスト待ち
//
// 使い方:
//   ふだんはデスクトップの「NANA LIVE」アイコン（app/start.js）から起動する
//   手で起動する場合: node app/server.js @ユーザー名
//   OBS（上から順に）: /overlay.html … 情報と演出
//                      /front.html   … 雰囲気レイヤー手前（アバターの上）
//                      （アバター）
//                      /back.html    … 雰囲気レイヤー奥（アバターの下）
//   リモコン: http://localhost:21213/remote.html
// ※TikTokとの接続は非公式ライブラリです。TikTok側の仕様変更で動かなくなることがあります。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const dgram = require('dgram');
const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');

const PORT = Number(process.env.KIT_PORT) || 21213;
const username = process.env.TIKTOK_USERNAME || process.argv[2];
if (!username) {
  console.error('エラー: TikTokのユーザー名が未設定です。');
  console.error('  node server.js @ユーザー名');
  process.exit(1);
}

// ============================================================
// 正本（kit_state.json）
// ============================================================
// フォルダ構成: app/（プログラム）・設定/（自分で書く設定と自動保存）・記録/（ハイライト・レポート）
const ROOT = path.join(__dirname, '..');
const CONF_DIR = path.join(ROOT, '設定');
const LOG_DIR = path.join(ROOT, '記録');
try { fs.mkdirSync(CONF_DIR, { recursive: true }); fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { /* ignore */ }
// 設定ファイルは「設定」フォルダを優先し、無ければ前の版の置き場所（キットのフォルダ直下）も見る
function confPath(name) {
  const p = path.join(CONF_DIR, name);
  if (fs.existsSync(p)) return p;
  const old = path.join(ROOT, name);
  if (fs.existsSync(old)) { console.log(`[bridge] ${name} がキットのフォルダ直下にあります。「設定」フォルダへ移すのがおすすめです`); return old; }
  return p;
}
const STATE_FILE = path.join(CONF_DIR, 'kit_state.json');
const TIERS = ['S', 'M', 'L', 'XL'];
const SLOTS = ['voice', 'cam', 'vfx'];
const DEFAULT_BANDS = [
  { from: 1, tier: 'S', ico: '🌹', fx: 'なながお名前を呼ぶ', short: 'お名前コール' },
  { from: 10, tier: 'M', ico: '🐱', fx: '語尾「にゃん」', min: 3, slot: 'voice' },
  { from: 30, tier: 'M', ico: '😤', fx: '一人称「俺」固定', min: 5, slot: 'voice', short: '一人称「俺」' },
  { from: 50, tier: 'M', ico: '🤖', fx: 'ボイスエフェクト（ロボ声）', min: 2, slot: 'vfx', short: 'ロボ声' },
  { from: 100, tier: 'L', ico: '🦵', fx: 'スクワット10回', short: 'スクワット' },
  { from: 199, tier: 'L', ico: '🎥', fx: '手元カメラON', min: 10, slot: 'cam', short: '手元カメラ' },
  { from: 500, tier: 'L', ico: '🎹', fx: 'ピアノ サビだけ1曲', req: 'サビ', short: 'サビだけ' },
  { from: 1000, tier: 'XL', ico: '🎹', fx: 'ピアノ フルで1曲', req: 'フル', short: 'フルで1曲' },
  { from: 5000, tier: 'XL', ico: '🎤', fx: 'ピアノ弾き語り1曲', req: '弾き語り', short: '弾き語り' },
];
const PALETTES = {
  neon: { accent: '#ff1f7a', gold: '#ffcf3a', cyan: '#20e6ff', plate: '#0a0710', frame: '#ff1f7a', ink: '#ffffff' },
};
const DEFAULT_STYLE = {
  preset: 'neon', colors: Object.assign({}, PALETTES.neon),
  titleFont: 'Dela Gothic One', bodyFont: 'M PLUS 1p', numFont: 'orbitron',
  customTitleFont: '', customBodyFont: '',
  frameStyle: 'glow', shape: 'cut', plateAlpha: 1,
};
const DEFAULT_SETTINGS = {
  topic: '※ ピアノ歌枠です', mode: 'avatar',
  atmo: { on: true, strength: 0.85 },
  sound: { on: true, volume: 0.5 },
  chainSec: 10,
  fxLevel: 'normal',  // 演出の強さ: normal（ふつう）/ dopa（ドパドパ）
  look: 'panel',      // パネルの見せ方: panel（しっかり）/ airy（すっきり・アバター重視）
  // ランキング表示（その日の配信ぶん）。showCoins は初期OFF（金額を画面に出さない）
  rank: { on: true, showCoins: false, likes: true, mvp: true },
  teamMax: 1000, teamLabel: '🎹 ピアノ1曲',
  // みんなで達成ゲージの入り方（ギフト1回はgiftCapまで。ギフトだけで一気に埋まらないように）
  teamW: { like: 0.6, comment: 6, follow: 25, share: 20, giftCap: 350 },
};

const clamp = (v, a, b, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : d; };
const str = (v, max, d) => (typeof v === 'string' ? v.slice(0, max) : (d == null ? '' : d));
const isHex = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
const fontName = (v, d) => (typeof v === 'string' ? v.replace(/["\\<>;{}]/g, '').slice(0, 60) : d);

function sanitizeBands(arr) {
  if (!Array.isArray(arr)) return null;
  const out = [];
  const seen = new Set();
  for (const b of arr.slice(0, 20)) {
    if (!b || typeof b !== 'object') continue;
    const from = Math.floor(clamp(b.from, 1, 1000000, 0));
    if (!from || seen.has(from)) continue;
    seen.add(from);
    const o = {
      from,
      tier: TIERS.includes(b.tier) ? b.tier : (from >= 1000 ? 'XL' : from >= 100 ? 'L' : from >= 10 ? 'M' : 'S'),
      ico: str(b.ico, 8, '🎁') || '🎁',
      fx: str(b.fx, 40, '') || 'お名前コール',
      on: b.on !== false,
    };
    const sh = str(b.short, 16, '');
    if (sh) o.short = sh;
    const min = clamp(b.min, 0, 120, 0);
    if (SLOTS.includes(b.slot) && min > 0) { o.slot = b.slot; o.min = min; }
    const req = str(b.req, 12, '');
    if (req && !o.slot) o.req = req;
    out.push(o);
  }
  out.sort((a, b) => a.from - b.from);
  out.forEach((b, i) => { b.id = 'b' + b.from; b.to = out[i + 1] ? out[i + 1].from - 1 : null; });
  return out.length ? out : null;
}
function sanitizeStyle(s) {
  const d = DEFAULT_STYLE;
  if (!s || typeof s !== 'object') return JSON.parse(JSON.stringify(d));
  const c = Object.assign({}, d.colors);
  if (s.colors && typeof s.colors === 'object') for (const k of Object.keys(c)) if (isHex(s.colors[k])) c[k] = s.colors[k];
  return {
    preset: str(s.preset, 20, 'custom') || 'custom', colors: c,
    titleFont: fontName(s.titleFont, d.titleFont) || d.titleFont,
    bodyFont: fontName(s.bodyFont, d.bodyFont) || d.bodyFont,
    numFont: s.numFont === 'title' ? 'title' : 'orbitron',
    customTitleFont: fontName(s.customTitleFont, ''), customBodyFont: fontName(s.customBodyFont, ''),
    frameStyle: ['glow', 'line', 'double', 'none'].includes(s.frameStyle) ? s.frameStyle : 'glow',
    shape: s.shape === 'round' ? 'round' : 'cut',
    plateAlpha: clamp(s.plateAlpha, 0.3, 1, 1),
  };
}
function sanitizeSettings(s, base) {
  const b = base || DEFAULT_SETTINGS;
  const o = JSON.parse(JSON.stringify(b));
  if (!s || typeof s !== 'object') return o;
  if (typeof s.topic === 'string') o.topic = s.topic.slice(0, 40);
  if (s.mode === 'avatar' || s.mode === 'game') o.mode = s.mode;
  if (s.fxLevel === 'normal' || s.fxLevel === 'dopa') o.fxLevel = s.fxLevel;
  if (s.look === 'panel' || s.look === 'airy') o.look = s.look;
  if (s.rank && typeof s.rank === 'object') for (const k of ['on', 'showCoins', 'likes', 'mvp']) if (typeof s.rank[k] === 'boolean') o.rank[k] = s.rank[k];
  if (s.atmo && typeof s.atmo === 'object') {
    if (typeof s.atmo.on === 'boolean') o.atmo.on = s.atmo.on;
    o.atmo.strength = clamp(s.atmo.strength, 0, 1, o.atmo.strength);
  }
  if (s.sound && typeof s.sound === 'object') {
    if (typeof s.sound.on === 'boolean') o.sound.on = s.sound.on;
    o.sound.volume = clamp(s.sound.volume, 0, 1, o.sound.volume);
  }
  o.chainSec = Math.round(clamp(s.chainSec, 3, 60, o.chainSec));
  o.teamMax = Math.round(clamp(s.teamMax, 50, 1000000, o.teamMax));
  if (typeof s.teamLabel === 'string') o.teamLabel = s.teamLabel.slice(0, 24);
  if (s.teamW && typeof s.teamW === 'object') {
    for (const k of Object.keys(o.teamW)) o.teamW[k] = clamp(s.teamW[k], 0, 100000, o.teamW[k]);
  }
  return o;
}

const LAYOUT_IDS = ['topic', 'hud', 'legL', 'legR', 'rank', 'team', 'chain', 'toasts'];
function sanitizeLayoutItem(v) {
  if (!v || typeof v !== 'object') return null;
  return { dx: Math.round(clamp(v.dx, -1500, 1500, 0)), dy: Math.round(clamp(v.dy, -2000, 2000, 0)), s: Math.round(clamp(v.s, 0.3, 3, 1) * 100) / 100 };
}
function sanitizeLayout(o) {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  for (const id of LAYOUT_IDS) { const v = sanitizeLayoutItem(o[id]); if (v) out[id] = v; }
  return out;
}

let K = {
  settings: sanitizeSettings(null),
  bands: sanitizeBands(DEFAULT_BANDS),
  style: sanitizeStyle(null),
  team: { value: 0 },
  slots: { voice: { cur: null, q: [] }, cam: { cur: null, q: [] }, vfx: { cur: null, q: [] } },
  requests: [],
  roomId: null,
  likeTotal: 0,
  // その日の配信のランキング元データ（新しい配信で自動リセット）
  rank: { gift: {}, like: {} },
  // レイアウト編集（プレビューでドラッグ・拡大縮小した分）。モードごと
  layout: { avatar: {}, game: {} },
};
try {
  const j = JSON.parse(fs.readFileSync(fs.existsSync(STATE_FILE) ? STATE_FILE : path.join(ROOT, 'kit_state.json'), 'utf8'));
  if (j && typeof j === 'object') {
    K.settings = sanitizeSettings(j.settings);
    K.bands = sanitizeBands(j.bands) || K.bands;
    K.style = sanitizeStyle(j.style);
    if (j.team && Number.isFinite(j.team.value)) K.team.value = Math.max(0, j.team.value);
    if (j.slots && typeof j.slots === 'object') {
      for (const k of SLOTS) {
        const s = j.slots[k];
        if (s && typeof s === 'object') K.slots[k] = { cur: s.cur || null, q: Array.isArray(s.q) ? s.q.slice(0, 50) : [] };
      }
    }
    if (Array.isArray(j.requests)) K.requests = j.requests.slice(0, 100);
    if (j.roomId) K.roomId = String(j.roomId);
    if (Number.isFinite(j.likeTotal)) K.likeTotal = j.likeTotal;
    if (j.rank && typeof j.rank === 'object') K.rank = { gift: j.rank.gift || {}, like: j.rank.like || {} };
    if (j.layout && typeof j.layout === 'object') for (const m of ['avatar', 'game']) if (j.layout[m]) K.layout[m] = sanitizeLayout(j.layout[m]);
  }
} catch (e) { /* 無ければ初期値から */ }

let saveTimer = null;
function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(K, null, 1)); } catch (e) { /* 保存失敗でも配信は止めない */ }
  }, 400);
}
function stateMsg() {
  return {
    type: 'state', serverNow: Date.now(),
    settings: K.settings, bands: K.bands, style: K.style,
    team: { value: Math.round(K.team.value), max: K.settings.teamMax, label: K.settings.teamLabel },
    slots: K.slots, requests: K.requests,
    conn: { auto: ttAuto, live: liveSessionActive, user: username },
    vrc: { enabled: vrcEnabled },
    layout: K.layout,
    rank: rankView(),
  };
}
let stateTimer = null;
function pushState() {
  saveState();
  if (stateTimer) return;
  stateTimer = setTimeout(() => { stateTimer = null; broadcast(stateMsg()); }, 60);
}

// ============================================================
// ギフト → コイン帯 → 起きること（必ず同じ結果）
// ============================================================
function bandOf(coins) {
  const list = K.bands.filter((b) => b.on !== false);
  let hit = null;
  for (const b of list) if (coins >= b.from) hit = b;
  return hit;
}
let seq = 0;
function slotAdd(slot, item) {
  const S = K.slots[slot];
  const ms = item.min * 60000 * item.count;
  if (S.cur && S.cur.bandId === item.bandId && S.cur.end > Date.now()) { S.cur.end += ms; return true; } // 同じ変身中 → 延長
  const q = S.q.find((x) => x.bandId === item.bandId);
  if (q) { q.ms += ms; return true; }
  S.q.push({ bandId: item.bandId, user: item.user, fx: item.fx, ico: item.ico, short: item.short, ms });
  if (!S.cur || S.cur.end <= Date.now()) slotNext(slot);
  return false;
}
function slotNext(slot) {
  const S = K.slots[slot];
  const x = S.q.shift();
  S.cur = x ? { bandId: x.bandId, user: x.user, fx: x.fx, ico: x.ico, short: x.short, end: Date.now() + x.ms } : null;
}
setInterval(() => {
  let changed = false;
  const now = Date.now();
  for (const k of SLOTS) {
    const S = K.slots[k];
    if (S.cur && S.cur.end <= now) { slotNext(k); changed = true; }
    else if (!S.cur && S.q.length) { slotNext(k); changed = true; }
  }
  if (changed) pushState();
}, 1000);

function teamAdd(v, test) {
  if (!(v > 0)) return;
  K.team.value += v;
  if (K.team.value >= K.settings.teamMax) {
    K.team.value = 0;
    K.requests.push({ id: 'r' + Date.now().toString(36) + (seq++), user: 'みんな', kind: 'TEAM達成', at: Date.now() });
    broadcast({ type: 'ev', kind: 'team', label: K.settings.teamLabel, test: !!test });
    if (!test) recordHighlight(`🎉 みんなで達成（${K.settings.teamLabel}）`);
    console.log('[team] みんなで達成！');
  }
  pushState();
}

// ランキング（その日の配信ぶん）
function rankAddGift(user, coins, count, giftName, ico) {
  const g = K.rank.gift;
  if (!g[user] && Object.keys(g).length >= 1000) return;
  const r = g[user] || (g[user] = { coins: 0, max: null });
  r.coins += coins * count;
  if (!r.max || coins > r.max.coins) r.max = { coins, giftName, ico, at: Date.now() };
}
function rankAddLike(user, n) {
  if (!user || !(n > 0)) return;
  const l = K.rank.like;
  if (l[user] == null && Object.keys(l).length >= 3000) return;
  l[user] = (l[user] || 0) + n;
}
function rankView() {
  const g = Object.entries(K.rank.gift);
  let mvp = null;
  for (const [user, r] of g) if (r.max && (!mvp || r.max.coins > mvp.coins || (r.max.coins === mvp.coins && r.max.at < mvp.at))) mvp = { user, coins: r.max.coins, giftName: r.max.giftName, ico: r.max.ico };
  const gifts = g.filter(([, r]) => r.coins > 0).sort((a, b) => b[1].coins - a[1].coins).slice(0, 10).map(([user, r]) => ({ user, coins: r.coins }));
  const likes = Object.entries(K.rank.like).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([user, count]) => ({ user, count }));
  return { mvp, gifts, likes };
}
function rankReset() { K.rank = { gift: {}, like: {} }; }

// TikTok（またはリモコンのテスト）からのギフトを処理する。count = 連投の個数
function processGift({ user, giftName, coins, count, test }) {
  user = String(user || 'だれか').slice(0, 30);
  giftName = String(giftName || 'ギフト').slice(0, 30);
  count = Math.max(1, Math.min(999, Math.floor(Number(count) || 1)));
  coins = Math.max(0, Number(coins) || 0);
  const b = bandOf(coins || 1);
  rankAddGift(user, coins, count, giftName, giftIcon(giftName, b));
  let ext = false;
  if (b) {
    if (b.slot) ext = slotAdd(b.slot, { bandId: b.id, user, fx: b.fx, ico: b.ico, short: b.short, min: b.min, count });
    if (b.req) for (let i = 0; i < Math.min(count, 10); i++) K.requests.push({ id: 'r' + Date.now().toString(36) + (seq++), user, kind: b.req, at: Date.now() });
  }
  broadcast({
    type: 'ev', kind: 'gift', user, giftName, giftIco: giftIcon(giftName, b), coins, count, test: !!test,
    band: b ? { id: b.id, tier: b.tier, ico: b.ico, fx: b.fx, min: b.min || 0, slot: b.slot || null, req: b.req || null } : null, ext,
  });
  const w = K.settings.teamW;
  teamAdd(Math.min(w.giftCap, 8 + Math.sqrt(coins || 1) * 6) * Math.min(count, 10), test);
  pushState();
  if (!test && b) {
    if (b.tier === 'L' || b.tier === 'XL') recordHighlight(`${b.ico} ${user}さん → ${b.fx}`);
    try { vrcOnGift(user, giftName, count, b, ext); } catch (e) { /* VRC送信で止めない */ }
    if (thanksList && !thanksList.has(user)) thanksList.add(user);
  }
}
const GIFT_ICONS = { 'バラ': '🌹', 'Rose': '🌹', 'TikTok': '🎵', 'Finger Heart': '🫰', '指ハート': '🫰', 'Doughnut': '🍩', 'ドーナツ': '🍩', 'Perfume': '🧴', '香水': '🧴', 'Hand Hearts': '🫶', 'Sunglasses': '🕶️', 'Corgi': '🐶', 'Galaxy': '🌌', 'Lion': '🦁', 'ライオン': '🦁', 'Universe': '🪐' };
function giftIcon(name, b) { return GIFT_ICONS[name] || (b ? b.ico : '🎁'); }

// ============================================================
// HTTP（オーバーレイとリモコンを配信）
// ============================================================
const PAGES = {
  '/': 'overlay.html', '/overlay.html': 'overlay.html', '/front.html': 'overlay.html', '/back.html': 'overlay.html',
  '/transparent.html': 'overlay.html', // 旧URL（OBSの設定をそのまま使えるように）
  '/remote.html': 'remote.html',
};
function kitFileStamp(rel) { try { return Math.floor(fs.statSync(path.join(__dirname, rel)).mtimeMs); } catch (e) { return 0; } }
function kitVersion(file) { return kitFileStamp(file) + '.' + kitFileStamp('server.js'); }
const httpServer = http.createServer((req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/version') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ overlay: kitVersion('overlay.html'), remote: kitVersion('remote.html') }));
    return;
  }
  const name = PAGES[p];
  if (!name) { res.writeHead(404); res.end('not found'); return; }
  fs.readFile(path.join(__dirname, name), (err, data) => {
    if (err) { res.writeHead(500); res.end('file not found: ' + name); return; }
    let html = data.toString('utf8');
    const stampScript = '<script>window.__kitVersion="' + kitVersion(name) + '";</script>';
    html = html.includes('<head>') ? html.replace('<head>', '<head>' + stampScript) : stampScript + html;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  });
});

// ============================================================
// WebSocket（オーバーレイ／リモコン）
// ============================================================
const wss = new WebSocketServer({ server: httpServer });
wss.on('error', () => { /* ポート使用中などは httpServer 側で処理 */ });
const clients = new Set();
function broadcast(obj, except) {
  const data = JSON.stringify(obj);
  for (const ws of clients) if (ws !== except && ws.readyState === 1) ws.send(data);
}
function testName(v) { return str(v, 30, '') || 'テストさん'; }
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[bridge] クライアント接続 (${clients.size}件)`);
  try { ws.send(JSON.stringify(stateMsg())); } catch (e) { /* ignore */ }
  ws.on('message', (raw) => {
    let m = null;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'hello': try { ws.send(JSON.stringify(stateMsg())); } catch (e) { /* ignore */ } break;
      case 'setSettings': K.settings = sanitizeSettings(m.settings, K.settings); pushState(); break;
      case 'setBands': { const b = sanitizeBands(m.bands); if (b) { K.bands = b; pushState(); } break; }
      case 'resetBands': K.bands = sanitizeBands(DEFAULT_BANDS); pushState(); break;
      case 'setStyle': K.style = sanitizeStyle(m.style); pushState(); break;
      case 'testGift': processGift({ user: testName(m.user), giftName: str(m.giftName, 30, '') || 'テストギフト', coins: m.coins, count: m.count, test: true }); break;
      case 'testEvent': {
        const u = testName(m.user);
        if (m.kind === 'like') { broadcast({ type: 'ev', kind: 'like', count: 50, test: true }); rankAddLike(u, 50); teamAdd(50 * K.settings.teamW.like, true); }
        else if (m.kind === 'comment') { broadcast({ type: 'ev', kind: 'comment', user: u, test: true }); teamAdd(K.settings.teamW.comment, true); }
        else if (m.kind === 'follow') { broadcast({ type: 'ev', kind: 'follow', user: u, test: true }); teamAdd(K.settings.teamW.follow, true); }
        else if (m.kind === 'share') { broadcast({ type: 'ev', kind: 'share', user: u, test: true }); teamAdd(K.settings.teamW.share, true); }
        break;
      }
      case 'slotEnd': if (SLOTS.includes(m.slot)) { K.slots[m.slot].cur = null; slotNext(m.slot); pushState(); } break;
      case 'slotClear': if (SLOTS.includes(m.slot)) { K.slots[m.slot] = { cur: null, q: [] }; pushState(); } break;
      case 'reqDone': K.requests = K.requests.filter((r) => r.id !== m.id); pushState(); break;
      case 'reqClear': K.requests = []; pushState(); break;
      case 'setLayout': {
        const mode = m.mode === 'game' ? 'game' : 'avatar';
        if (LAYOUT_IDS.includes(m.id)) { const v = sanitizeLayoutItem(m); if (v) { K.layout[mode][m.id] = v; pushState(); } }
        break;
      }
      case 'resetLayout': { const mode = m.mode === 'game' ? 'game' : 'avatar'; if (LAYOUT_IDS.includes(m.id)) delete K.layout[mode][m.id]; else K.layout[mode] = {}; pushState(); break; }
      case 'rankReset': rankReset(); pushState(); break;
      case 'teamSet': K.team.value = clamp(m.value, 0, K.settings.teamMax - 1, K.team.value); pushState(); break;
      case 'connectMode': if (typeof m.auto === 'boolean') { setConnectMode(m.auto); pushState(); } break;
      case 'connectNow': console.log('[bridge] リモコンから「今すぐ接続」を受けました'); try { connectTikTokNow(); } catch (e) { /* ignore */ } break;
      case 'vrcTest': handleVrcTest(); break;
      default: break;
    }
  });
  ws.on('close', () => { clients.delete(ws); console.log(`[bridge] クライアント切断 (${clients.size}件)`); });
});
let listenTries = 0;
httpServer.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE' && process.env.KIT_RESTARTED === '1' && listenTries < 15) {
    listenTries++;
    setTimeout(() => { try { httpServer.listen(PORT); } catch (err) { /* ignore */ } }, 700);
  } else if (e && e.code === 'EADDRINUSE') {
    console.log(`[bridge] ポート${PORT}は使用中です。先に起動しているサーバー（黒画面）が残っていないか確認してください。`);
  } else {
    console.log('[bridge] サーバーエラー: ' + (e && e.message ? e.message : e));
  }
});
httpServer.listen(PORT, () => {
  console.log(`[bridge] 起動: http://localhost:${PORT}/  (リモコン: /remote.html)`);
});

// --- 自動再起動: server.js が差し替わったら（GitHub Desktop の Pull 後など）、
//     文法チェックを通った場合だけ後継プロセスを起動して自分は終了する。
let selfRestarting = false;
try {
  fs.watchFile(__filename, { interval: 2000 }, (cur, prev) => {
    if (selfRestarting || !prev || cur.mtimeMs === prev.mtimeMs) return;
    selfRestarting = true;
    try { require('child_process').execFileSync(process.execPath, ['--check', __filename], { stdio: 'pipe' }); }
    catch (e) { console.log('[bridge] 新しい server.js に文法エラーがあるため再起動を中止しました（今の版で継続します）'); selfRestarting = false; return; }
    console.log('[bridge] server.js の更新を検知しました。自動で再起動します…');
    try { if (saveTimer) { clearTimeout(saveTimer); fs.writeFileSync(STATE_FILE, JSON.stringify(K, null, 1)); } } catch (e) { /* ignore */ }
    try {
      const child = require('child_process').spawn(process.execPath, [__filename].concat(process.argv.slice(2)), {
        detached: true, stdio: 'inherit', env: Object.assign({}, process.env, { KIT_RESTARTED: '1' }),
      });
      child.unref();
    } catch (e) { selfRestarting = false; return; }
    setTimeout(() => process.exit(0), 500);
  });
} catch (e) { /* 監視できなくても本処理は継続 */ }

// ============================================================
// Discord連携（discord_webhook.txt：1行目=まとめ用、2行目=告知用。無ければOFF）
//   ※URLは秘密情報。ログには絶対に出さない。
// ============================================================
let discordAttendUrl = null;
let discordAnnounceUrl = null;
try {
  const rawCfg = fs.readFileSync(confPath('discord_webhook.txt'), 'utf8');
  const cfgLines = rawCfg.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  if (cfgLines.length >= 1) discordAttendUrl = cfgLines[0];
  if (cfgLines.length >= 2) discordAnnounceUrl = cfgLines[1];
  if (!discordAnnounceUrl) discordAnnounceUrl = discordAttendUrl;
} catch (e) { /* ファイルが無ければOFF */ }
console.log(discordAttendUrl ? '[discord] Discord連携: ON' : '[discord] 設定/discord_webhook.txt が無いため、Discord連携は OFF です');

let discordQueue = Promise.resolve();
function postDiscord(url, content) {
  if (!url || !content) return;
  discordQueue = discordQueue.then(() => sendWebhook(url, content)).catch(() => {});
}
async function sendWebhook(url, content) {
  const body = JSON.stringify({ content: String(content).slice(0, 1900), allowed_mentions: { parse: [] } });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (res.ok) return;
      if (res.status === 429 && attempt === 0) {
        let waitMs = 1500;
        try { const j = await res.json(); if (j && j.retry_after) waitMs = Math.min(5000, Math.ceil(Number(j.retry_after) * 1000) + 250); } catch (e) { /* ignore */ }
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      console.log(`[discord] 投稿失敗 (HTTP ${res.status}) — この投稿は破棄します`);
      return;
    } catch (e) {
      console.log('[discord] 投稿失敗 (通信エラー) — この投稿は破棄します');
      return;
    }
  }
}

// --- 配信終了時のまとめ ---
let liveSessionActive = false;
let sawConnectFailure = false;
// 「今日ギフトをくれた人」（名前だけ。金額は出さない）
let thanksList = new Set();
let thanksPosted = false;
function postThanks() {
  if (thanksPosted || !discordAttendUrl || !thanksList.size) return;
  thanksPosted = true;
  const names = [...thanksList].slice(0, 40).map((n) => `・${String(n).slice(0, 40)}さん`);
  if (thanksList.size > 40) names.push(`…ほか ${thanksList.size - 40} 人`);
  postDiscord(discordAttendUrl, ['💐 今日ギフトをくれたみなさん、ありがとう！', ...names].join('\n'));
  console.log('[discord] ありがとうリストを投稿しました');
}

// --- ハイライト（切り抜き候補）: 経過時間つきで記録。配信終了時にまとめ投稿 ---
let highlightList = [];
let highlightConnectAt = 0;
let highlightPosted = false;
const pad2 = (n) => String(n).padStart(2, '0');
function fmtElapsed(sec) { const s = Math.max(0, Math.floor(sec || 0)); return pad2(Math.floor(s / 60)) + ':' + pad2(s % 60); }
function recordHighlight(text) {
  const now = Date.now();
  if (!highlightConnectAt) highlightConnectAt = now;
  const elapsed = Math.floor((now - highlightConnectAt) / 1000);
  highlightList.push({ elapsed, text });
  try {
    const d = new Date();
    const file = path.join(LOG_DIR, `highlights_${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.txt`);
    fs.appendFile(file, `[${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}] 経過 ${fmtElapsed(elapsed)} ${text}\n`, () => {});
  } catch (e) { /* ignore */ }
  console.log(`[highlight] ${fmtElapsed(elapsed)} ${text}`);
}
function postHighlightSummary() {
  if (highlightPosted || !highlightList.length) return;
  highlightPosted = true;
  const items = highlightList;
  highlightList = [];
  if (!discordAnnounceUrl) return;
  const lines = items.slice(0, 25).map((h) => `・${fmtElapsed(h.elapsed)} ${h.text}`);
  if (items.length > 25) lines.push(`…ほか ${items.length - 25} 件`);
  postDiscord(discordAnnounceUrl, ['🎬 今日のハイライト（切り抜き候補）', ...lines].join('\n'));
}

// --- 配信レポート（本人用。stream_reports.txt に記録。Discordには金額を出さない） ---
let reportStats = null;
let reportPosted = false;
function newReportStats(startAt) {
  return { startedAt: startAt || Date.now(), totalDiamonds: 0, giftCount: 0, gifters: new Set(), peakViewers: 0, likesTotal: 0 };
}
function toPosNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : 0;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; }
  return 0;
}
function fmtNum(n) { return Number(n || 0).toLocaleString('en-US'); }
function fmtDuration(ms) { const min = Math.max(0, Math.floor((ms || 0) / 60000)); const h = Math.floor(min / 60); return h > 0 ? `${h}時間${min % 60}分` : `${min % 60}分`; }
function postStreamReport() {
  if (reportPosted || !reportStats) return;
  const st = reportStats;
  if (!(st.giftCount > 0 || st.likesTotal > 0 || st.peakViewers > 0)) return;
  reportPosted = true;
  const d = new Date();
  const fileText = [
    `===== ${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())} 配信レポート =====`,
    `⏱ 配信時間：${fmtDuration(Date.now() - st.startedAt)}`,
    `💎 総ダイヤ：${fmtNum(st.totalDiamonds)}`,
    `🎁 ギフト：${fmtNum(st.giftCount)}個 ／ ギフトしてくれた人：${fmtNum(st.gifters.size)}人`,
    `👀 ピーク視聴者：${fmtNum(st.peakViewers)}人`,
    `❤️ いいね：${fmtNum(st.likesTotal)}`,
  ].join('\n');
  try { fs.appendFile(path.join(LOG_DIR, 'stream_reports.txt'), fileText + '\n\n', () => {}); } catch (e) { /* ignore */ }
  console.log('[report] 配信レポートを stream_reports.txt に記録しました');
  if (discordAnnounceUrl) {
    postDiscord(discordAnnounceUrl, [
      '📊 今日の配信おつかれさま！',
      `⏱ 配信時間：${fmtDuration(Date.now() - st.startedAt)}`,
      `🎁 ギフトしてくれた人：${fmtNum(st.gifters.size)}人`,
      st.peakViewers ? `👀 ピーク視聴者：${fmtNum(st.peakViewers)}人` : '',
      st.likesTotal ? `❤️ いいね：${fmtNum(st.likesTotal)}` : '',
    ].filter(Boolean).join('\n'));
  }
}

// ============================================================
// VRChat連携（vrc_osc.txt：1行目 on で有効、2行目ポート、3行目アドレス）
//   チャットボックスへ「誰が・何を」だけ流す。金額は流さない。テストは流さない。
// ============================================================
let vrcEnabled = false;
let vrcHost = '127.0.0.1';
let vrcPort = 9000;
try {
  const vrcLines = fs.readFileSync(confPath('vrc_osc.txt'), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  vrcEnabled = ['on', '1', 'true', 'yes', 'enable', 'enabled'].includes(String(vrcLines[0] || '').toLowerCase());
  const pnum = parseInt(vrcLines[1], 10);
  if (Number.isFinite(pnum) && pnum > 0 && pnum < 65536) vrcPort = pnum;
  if (vrcLines[2]) vrcHost = vrcLines[2];
} catch (e) { /* 無ければOFF */ }
console.log(vrcEnabled ? `[vrc] VRChat連携: ON（OSC → ${vrcHost}:${vrcPort}）` : '[vrc] VRChat連携は OFF です（設定/vrc_osc.txt）');
let vrcSocket = null;
function vrcGetSocket() {
  if (!vrcSocket) { vrcSocket = dgram.createSocket('udp4'); vrcSocket.on('error', (err) => console.log('[vrc] UDP送信エラー:', err && err.message)); }
  return vrcSocket;
}
function oscString(s) { const b = Buffer.from(String(s), 'utf8'); return Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]); }
function oscChatboxPacket(text) { return Buffer.concat([oscString('/chatbox/input'), oscString(',sT'), oscString(text)]); }
const VRC_COOLDOWN_MS = 1500, VRC_QUEUE_MAX = 12, VRC_DEDUP_MS = 8000;
const VRC_PRIO = { normal: 0, big: 1, high: 2 };
let vrcQueue = [], vrcPumpTimer = null, vrcLastSentAt = 0, vrcRecent = new Map();
function vrcQueuePush(text, prio, opts) {
  if (!vrcEnabled || !text) return false;
  const chars = [...String(text)];
  const body = chars.length > 144 ? chars.slice(0, 144).join('') : String(text);
  const now = Date.now();
  if (!(opts && opts.bypassDedup)) { const last = vrcRecent.get(body); if (last && now - last < VRC_DEDUP_MS) return false; }
  if (vrcQueue.length >= VRC_QUEUE_MAX) {
    let minP = Infinity;
    for (const q of vrcQueue) if (q.prio < minP) minP = q.prio;
    if (prio <= minP) return false;
    vrcQueue.splice(vrcQueue.findIndex((q) => q.prio === minP), 1);
  }
  vrcQueue.push({ text: body, prio: prio || 0 });
  vrcRecent.set(body, now);
  if (vrcRecent.size > 100) for (const [k, t] of vrcRecent) if (now - t > 30000) vrcRecent.delete(k);
  vrcPump();
  return true;
}
function vrcPump() {
  if (vrcPumpTimer || !vrcQueue.length) return;
  vrcPumpTimer = setTimeout(() => {
    vrcPumpTimer = null;
    if (!vrcQueue.length) return;
    let bi = 0;
    for (let i = 1; i < vrcQueue.length; i++) if (vrcQueue[i].prio > vrcQueue[bi].prio) bi = i;
    const item = vrcQueue.splice(bi, 1)[0];
    try { vrcGetSocket().send(oscChatboxPacket(item.text), vrcPort, vrcHost); } catch (e) { /* ignore */ }
    vrcLastSentAt = Date.now();
    vrcPump();
  }, Math.max(0, VRC_COOLDOWN_MS - (Date.now() - vrcLastSentAt)));
}
function vrcOnGift(user, giftName, count, b, ext) {
  if (!vrcEnabled) return;
  const cnt = count > 1 ? ` ×${count}` : '';
  const head = b && (b.tier === 'XL') ? '🌟🎁' : b && b.tier === 'L' ? '🔥🎁' : '🎁';
  let line = `${head} ${user}さんから『${giftName}』${cnt}`;
  if (b && b.tier !== 'S') line += ` → ${b.fx}${ext ? '（延長）' : ''}`;
  vrcQueuePush(line, b && (b.tier === 'L' || b.tier === 'XL') ? VRC_PRIO.big : VRC_PRIO.normal);
}
function handleVrcTest() {
  if (!vrcEnabled) { console.log('[vrc] テスト送信が押されましたが、VRChat連携は OFF です（設定/vrc_osc.txt を確認）'); return; }
  vrcQueuePush('🎹 VRC連携テスト：チャットボックス連携OKです', VRC_PRIO.high, { bypassDedup: true });
}

// ============================================================
// TikTok LIVE 接続（自動リトライ＋手動モード）
// ============================================================
const CONNECT_MODE_FILE = path.join(CONF_DIR, 'connect_mode.json');
let ttAuto = true;
try { const j = JSON.parse(fs.readFileSync(CONNECT_MODE_FILE, 'utf8')); if (j && typeof j.auto === 'boolean') ttAuto = j.auto; } catch (e) { /* 既定は自動 */ }
function setConnectMode(auto) {
  ttAuto = !!auto;
  try { fs.writeFileSync(CONNECT_MODE_FILE, JSON.stringify({ auto: ttAuto })); } catch (e) { /* ignore */ }
  console.log(`[bridge] TikTok接続方式: ${ttAuto ? '自動' : '手動（ボタンで接続）'}`);
  if (ttAuto) connectTikTokNow();
}
let lastTikTokAnnounceAt = 0;
function maybeAnnounceTikTok() {
  if (!discordAnnounceUrl) return;
  const now = Date.now();
  if (now - lastTikTokAnnounceAt < 30 * 60 * 1000) return;
  lastTikTokAnnounceAt = now;
  const uname = username.startsWith('@') ? username : '@' + username;
  postDiscord(discordAnnounceUrl, `🔴 TikTok LIVE はじまったよ！\n${K.settings.topic ? K.settings.topic + '\n' : ''}https://www.tiktok.com/${uname}/live`);
}
const connection = new TikTokLiveConnection(username, {});
const EV = (k, d) => (WebcastEvent && WebcastEvent[k]) || d;
let connecting = false, ttRetryTimer = null, ttFailStreak = 0, ttLastLiveAt = 0;
function ttRetryDelayMs() {
  if (ttLastLiveAt && Date.now() - ttLastLiveAt < 10 * 60 * 1000) return 20000;
  if (ttFailStreak <= 2) return 20000;
  if (ttFailStreak <= 5) return 60000;
  return 180000;
}
function scheduleTtRetry() {
  if (!ttAuto) { if (ttFailStreak === 1) console.log('[bridge] 手動モードのため、自動では再試行しません（リモコンの「今すぐ接続」で接続できます）'); return; }
  if (ttRetryTimer) return;
  const delay = ttRetryDelayMs();
  if (ttFailStreak === 3 || ttFailStreak === 6) console.log(`[bridge] TikTokにまだ繋がりません。再試行を ${Math.round(delay / 1000)} 秒に1回へ減らします`);
  else if (ttFailStreak <= 2) console.log(`[bridge] ${Math.round(delay / 1000)}秒後に自動で再試行します（配信開始後に自動で繋がります）`);
  ttRetryTimer = setTimeout(() => { ttRetryTimer = null; connectTikTok(); }, delay);
}
function connectTikTokNow() {
  ttFailStreak = 0;
  if (ttRetryTimer) { clearTimeout(ttRetryTimer); ttRetryTimer = null; }
  connectTikTok();
}
function newStream() {
  highlightList = []; highlightPosted = false; highlightConnectAt = Date.now();
  reportStats = newReportStats(Date.now()); reportPosted = false;
  thanksList = new Set(); thanksPosted = false;
  rankReset();
}
function connectTikTok() {
  if (connecting) return;
  connecting = true;
  connection.connect()
    .then((state) => {
      connecting = false; ttFailStreak = 0; ttLastLiveAt = Date.now(); liveSessionActive = true;
      const rid = state && state.roomId ? String(state.roomId) : null;
      // 配信ルームが変わった／一度切れてからの接続 ＝ 新しい配信
      if ((rid && K.roomId !== rid) || sawConnectFailure || !reportStats) {
        if (rid && K.roomId !== rid) { K.roomId = rid; K.likeTotal = 0; followSeen.clear(); shareLast.clear(); }
        newStream();
        sawConnectFailure = false;
      }
      console.log(`[bridge] TikTok LIVE接続成功: ${username} (roomId: ${rid})`);
      maybeAnnounceTikTok();
      pushState();
    })
    .catch((err) => {
      connecting = false; sawConnectFailure = true; ttFailStreak++;
      if (ttFailStreak === 1) console.error('[bridge] TikTok LIVE接続失敗:', err && err.message ? err.message : err);
      scheduleTtRetry();
    });
}
connection.on(EV('DISCONNECTED', 'disconnected'), () => {
  console.log('[bridge] TikTok LIVEから切断されました。5秒後に再接続します');
  ttLastLiveAt = Date.now();
  if (liveSessionActive) {
    liveSessionActive = false;
    postThanks(); postHighlightSummary(); postStreamReport();
    pushState();
  }
  if (ttRetryTimer) clearTimeout(ttRetryTimer);
  ttRetryTimer = setTimeout(() => { ttRetryTimer = null; connectTikTok(); }, 5000);
});
if (ttAuto) connectTikTok();
else console.log('[bridge] 手動モードで起動しました。TikTokへはリモコンの「今すぐ接続」ボタンを押した時だけ接続します');

const nameOf = (data) => { const u = (data && data.user) || {}; return u.nickname || u.uniqueId || (data && (data.nickname || data.uniqueId)) || ''; };

// --- ギフト ---
// コイン数（1個あたり）は版によって入っている場所が違うので候補を総当たりで探す。
// 連投（ストリーク）は途中経過が何度も届くので、確定したものだけを最終個数で数える。
connection.on(EV('GIFT', 'gift'), (data) => {
  if (!data) return;
  const g = data.gift || data.giftDetails || {};
  let giftType = null;
  if (typeof g.giftType === 'number') giftType = g.giftType; else if (typeof g.type === 'number') giftType = g.type; else if (typeof data.giftType === 'number') giftType = data.giftType;
  if (data.repeatEnd === false) return;
  if (giftType === 1 && !(data.repeatEnd === true || data.repeatEnd === 1)) return;
  const details = data.giftDetails || {};
  let unit = 0;
  for (const c of [data.gift && data.gift.diamondCount, details.diamondCount, data.diamondCount, data.totalDiamondCount, data.diamond_count, details.diamond_count]) {
    const v = toPosNum(c); if (v > 0) { unit = v; break; }
  }
  const rc = parseInt(data.repeatCount, 10);
  const count = Number.isFinite(rc) && rc > 0 ? rc : 1;
  const name = nameOf(data);
  const giftName = data.giftName || (data.gift && data.gift.name) || details.giftName || details.name || '';
  if (reportStats) { reportStats.giftCount += count; reportStats.totalDiamonds += unit * count; if (name) reportStats.gifters.add(name); }
  console.log(`[gift] ${name} 『${giftName}』 ${unit}コイン ×${count}`);
  if (!unit) console.log('[gift] コイン数が取れませんでした（1コイン扱い）。keys:', Object.keys(data).join(','));
  processGift({ user: name, giftName, coins: unit, count, test: false });
});

// --- コメント ---
connection.on(EV('CHAT', 'chat'), (data) => {
  const name = nameOf(data);
  broadcast({ type: 'ev', kind: 'comment', user: String(name || '') });
  teamAdd(K.settings.teamW.comment);
});

// --- いいね（合計数の増えた分だけゲージに入れる。再送・再接続でも二重に数えない） ---
let likeEvBuf = 0, likeEvTimer = null;
connection.on(EV('LIKE', 'like'), (data) => {
  if (!data) return;
  const total = toPosNum(data.totalLikeCount) || toPosNum(data.total);
  const inc = toPosNum(data.likeCount) || toPosNum(data.count);
  let delta = 0;
  if (total > 0) { if (total > K.likeTotal) { delta = total - K.likeTotal; K.likeTotal = total; } }
  else if (inc > 0) { delta = inc; K.likeTotal += inc; }
  if (reportStats && K.likeTotal > reportStats.likesTotal) reportStats.likesTotal = K.likeTotal;
  // いいねランキング：そのイベントでその人が押した数（likeCount）を足す
  const liker = String(nameOf(data) || '');
  if (liker && inc > 0) { rankAddLike(liker, Math.min(inc, 500)); pushState(); }
  if (delta <= 0) return;
  teamAdd(delta * K.settings.teamW.like);
  likeEvBuf += delta;
  if (!likeEvTimer) likeEvTimer = setTimeout(() => { likeEvTimer = null; broadcast({ type: 'ev', kind: 'like', count: likeEvBuf }); likeEvBuf = 0; }, 500);
});
connection.on(EV('ROOM_USER', 'roomUser'), (data) => {
  const v = toPosNum(data && data.viewerCount) || toPosNum(data && data.total);
  if (reportStats && v > reportStats.peakViewers) reportStats.peakViewers = v;
});

// --- フォロー（1配信1人1回）／シェア（1人60秒に1回） ---
const followSeen = new Set();
const shareLast = new Map();
function handleFollow(data) {
  const name = String(nameOf(data) || ''); if (!name || followSeen.has(name)) return;
  followSeen.add(name);
  broadcast({ type: 'ev', kind: 'follow', user: name });
  teamAdd(K.settings.teamW.follow);
}
function handleShare(data) {
  const name = String(nameOf(data) || ''); if (!name) return;
  const now = Date.now(); if (now - (shareLast.get(name) || 0) < 60000) return;
  shareLast.set(name, now);
  broadcast({ type: 'ev', kind: 'share', user: name });
  teamAdd(K.settings.teamW.share);
}
connection.on(EV('FOLLOW', 'follow'), (d) => { try { handleFollow(d); } catch (e) { /* ignore */ } });
connection.on(EV('SHARE', 'share'), (d) => { try { handleShare(d); } catch (e) { /* ignore */ } });
connection.on(EV('SOCIAL', 'social'), (d) => {
  try {
    const dt = String((d && (d.displayType || d.display_type)) || '').toLowerCase();
    if (dt.includes('follow')) handleFollow(d); else if (dt.includes('share')) handleShare(d);
  } catch (e) { /* ignore */ }
});

// ============================================================
// YouTube LIVE 検知（告知用ウェブフックがある時だけ・3分おき）
// ============================================================
const YT_CHANNEL_ID = 'UC_3-WNmVJoUZoFik38YzGlQ';
const YT_LIVE_URL = process.env.BRIDGE_YT_LIVE_URL || `https://www.youtube.com/channel/${YT_CHANNEL_ID}/live`;
const YT_POLL_MS = Number(process.env.BRIDGE_YT_POLL_MS) > 0 ? Number(process.env.BRIDGE_YT_POLL_MS) : 3 * 60 * 1000;
let lastYtAnnouncedId = null, ytFailCount = 0;
function parseYouTubeLive(html) {
  if (!html || typeof html !== 'string') return null;
  if (html.includes('"liveBroadcastContent":"upcoming"')) return null;
  if (!(html.includes('"liveBroadcastContent":"live"') || html.includes('"isLive":true'))) return null;
  let m = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/) || html.match(/"videoId":"([\w-]{11})"/);
  if (!m) return null;
  const videoId = m[1];
  let title = '';
  m = html.match(/"videoDetails":\{[^}]*?"title":"((?:[^"\\]|\\.)*)"/);
  if (m) { try { title = JSON.parse('"' + m[1] + '"'); } catch (e) { title = m[1]; } }
  return { videoId, title: String(title || '') };
}
async function checkYouTubeLive() {
  if (!discordAnnounceUrl) return;
  let html = null;
  try {
    const res = await fetch(YT_LIVE_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'Accept-Language': 'ja-JP,ja;q=0.9' } });
    if (!res.ok) throw new Error('http');
    html = await res.text();
  } catch (e) { if (++ytFailCount === 1) console.log('[youtube] ライブ確認に失敗しました（次回リトライします）'); return; }
  ytFailCount = 0;
  const info = parseYouTubeLive(html);
  if (!info || info.videoId === lastYtAnnouncedId) return;
  lastYtAnnouncedId = info.videoId;
  postDiscord(discordAnnounceUrl, `🔴 YouTube LIVE はじまったよ！\n${info.title ? `『${info.title}』\n` : ''}https://www.youtube.com/watch?v=${info.videoId}`);
  console.log('[youtube] YouTube LIVE告知を投稿しました');
}
if (discordAnnounceUrl) { setTimeout(checkYouTubeLive, Math.min(30000, YT_POLL_MS)); setInterval(checkYouTubeLive, YT_POLL_MS); }

// 終了時に正本を確実に保存する
function flushAndExit() { try { fs.writeFileSync(STATE_FILE, JSON.stringify(K, null, 1)); } catch (e) { /* ignore */ } process.exit(0); }
process.on('SIGINT', flushAndExit);
process.on('SIGTERM', flushAndExit);
