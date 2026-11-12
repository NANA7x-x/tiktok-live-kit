// tiktok-bridge/server.js (v2 + Discord連携)
// TikTok LIVE のギフトイベントを、公開ライブラリ TikTok-Live-Connector で受信し、
// ローカル WebSocket (ws://localhost:21213) でオーバーレイへ中継するブリッジ。
// v2: HTTPでオーバーレイ/リモコンページも配信し、クライアント間の操作命令
//     （control / layout / goal / state）を中継する。TikTok接続は自動リトライ。
// Discord連携: discord_webhook.txt があれば、配信終了時に出席簿まとめを投稿し、
//     TikTok / YouTube の配信開始を自動告知する（ファイルが無ければ全てOFF）。
// ハイライト: オーバーレイからの highlight メッセージを集計し、配信終了時に
//     「切り抜き候補」として告知用チャンネルへ投稿。あわせて
//     highlights_YYYY-MM-DD.txt にも常時記録する（ウェブフック未設定でも記録）。
// 配信レポート: TikTok接続イベント（ギフト/いいね/視聴者数）からブリッジ側だけで
//     集計し、配信終了時に告知用チャンネルへ「📊 今日の配信レポート」を投稿。
//     あわせて stream_reports.txt にも残す（ウェブフック未設定でも記録）。
// VRChat連携: vrc_osc.txt で有効化すると、ギフト/ハイライト/効果当選を
//     VRChat のチャットボックスへ OSC (UDP 9000) で自動送信する（無ければOFF）。
// いいね連携: いいね（画面タップ）の合計数が節目（500ごと）に達するたび、
//     ブリッジが回転数だけをオーバーレイへ指示する（ルーレットは回さない）。
//     節目の支払い管理はブリッジ側が正で、再接続・再読込でも二重加算しない。
// ※非公式手法です。TikTok側の仕様変更で動かなくなることがあります（README参照）。
//
// 使い方:
//   node server.js @ユーザー名
//   表示用:   http://localhost:21213/           （OBSのブラウザソースにこのURL）
//   リモコン: http://localhost:21213/remote.html （Braveで開く）

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const dgram = require('dgram');
const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');

const PORT = 21213;
const username = process.env.TIKTOK_USERNAME || process.argv[2];

if (!username) {
  console.error('エラー: TikTokのユーザー名が未設定です。');
  console.error('  node server.js @ユーザー名');
  process.exit(1);
}

// --- HTTP（オーバーレイとリモコンを配信） ---
// 新しい名前（nana_*.html）を優先し、無ければ従来名を使う（ダウンロード時の (1) 付番対策）
const FILES = {
  '/': ['nana_overlay.html', 'TikTokLIVE_画面オーバーレイ.html'],
  '/overlay.html': ['nana_overlay.html', 'TikTokLIVE_画面オーバーレイ.html'],
  '/TikTokLIVE_画面オーバーレイ.html': ['nana_overlay.html', 'TikTokLIVE_画面オーバーレイ.html'],
  '/transparent.html': ['nana_overlay_toumei.html', 'TikTokLIVE_画面オーバーレイ_透過.html'],
  '/remote.html': ['nana_remote.html', 'TikTokLIVE_リモコン.html'],
};
function kitFileStamp(rel) { try { return Math.floor(fs.statSync(path.join(__dirname, rel)).mtimeMs); } catch (e) { return 0; } }
function servedNameFor(p) {
  const names = FILES[p];
  if (!names) return null;
  return names.find((n) => fs.existsSync(path.join(__dirname, n))) || names[0];
}
function kitVersionFor(p) {
  const n = servedNameFor(p);
  if (!n) return '';
  return kitFileStamp(n) + '.' + kitFileStamp('server.js') + '.' + kitFileStamp('nana_server.js');
}
const httpServer = http.createServer((req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/version') {
    const out = {};
    for (const k of Object.keys(FILES)) out[k] = kitVersionFor(k);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(out));
    return;
  }
  const names = FILES[p];
  if (!names) { res.writeHead(404); res.end('not found'); return; }
  const name = names.find((n) => fs.existsSync(path.join(__dirname, n)));
  if (!name) { res.writeHead(500); res.end('file not found: ' + names.join(' / ')); return; }
  fs.readFile(path.join(__dirname, name), (err, data) => {
    if (err) { res.writeHead(500); res.end('file error'); return; }
    let html = data.toString('utf8');
    const stampScript = '<script>window.__kitVersion="' + kitVersionFor(p) + '";</script>';
    if (html.includes('<head>')) html = html.replace('<head>', '<head>' + stampScript);
    else html = stampScript + html;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
});

// --- ローカルWebSocketサーバー（オーバーレイ/リモコン向け） ---
const wss = new WebSocketServer({ server: httpServer });
wss.on('error', () => { /* ポート使用中などのエラーは httpServer 側のハンドラで処理する（未処理だとプロセスが落ちる） */ });
const clients = new Set();
// --- レイアウトの正本はブリッジが持つ（編集画面と配信画面の見た目を一致させる） ---
//   受け取った layout は layout.json に保存し、再起動後も復元する。
//   接続したクライアントには正本を送る。正本がまだ無い時だけ requestLayout を出し、
//   各クライアントの手持ち（layoutOffer）の中で「一番新しく保存されたもの」を正本に採用する
//   （savedAt の新しい順。同点なら項目数が多い方、それも同点なら先着。
//     旧仕様は項目数→先着だけだったため、古いコピーを持つOBS側が先に接続すると
//     その古い配置が正本になって新しい編集を上書きしてしまう事故があった）
//   空の layout は誤送信で正本を消さないよう無視する（配置リセットは reset:true の時だけ）。
const LAYOUT_FILE = path.join(__dirname, 'layout.json');
let savedLayout = null;
try { const j = JSON.parse(fs.readFileSync(LAYOUT_FILE, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) savedLayout = j; } catch (e) { /* 無ければ未設定 */ }
let layoutCandidate = null, layoutCandidateTimer = null;
function setCanonicalLayout(l) { savedLayout = l; try { fs.writeFileSync(LAYOUT_FILE, JSON.stringify(savedLayout)); } catch (e) { /* 保存失敗でも動作は続ける */ } }
// --- 表示ON/OFF（非表示項目リスト）の正本もブリッジが持つ（layout と同じ方式） ---
const VISIBILITY_FILE = path.join(__dirname, 'visibility.json');
let savedHidden = null;
try { const j = JSON.parse(fs.readFileSync(VISIBILITY_FILE, 'utf8')); if (Array.isArray(j)) savedHidden = j.filter(x => typeof x === 'string'); } catch (e) { /* 無ければ未設定 */ }
function setCanonicalHidden(h) { savedHidden = h; try { fs.writeFileSync(VISIBILITY_FILE, JSON.stringify(savedHidden)); } catch (e) { /* 保存失敗でも動作は続ける */ } }
// --- TikTok接続方式（自動/手動）。手動は「今すぐ接続」ボタンの時だけ接続を試みる ---
const CONNECT_MODE_FILE = path.join(__dirname, 'connect_mode.json');
let ttAuto = true;
try { const j = JSON.parse(fs.readFileSync(CONNECT_MODE_FILE, 'utf8')); if (j && typeof j.auto === 'boolean') ttAuto = j.auto; } catch (e) { /* 無ければ自動 */ }
function setConnectMode(auto) {
  ttAuto = auto;
  try { fs.writeFileSync(CONNECT_MODE_FILE, JSON.stringify({ auto: ttAuto })); } catch (e) { /* 保存失敗でも動作は続ける */ }
  broadcast({ type: 'connectMode', auto: ttAuto });
  console.log(`[bridge] TikTok接続方式: ${ttAuto ? '自動' : '手動（ボタンの時だけ接続）'}`);
  if (ttAuto) { try { connectTikTokNow(); } catch (e) { /* ignore */ } }
}
// --- かんたん表示（ローテーション設定）の正本もブリッジが持つ ---
const SIMPLE_FILE = path.join(__dirname, 'simple.json');
let savedSimple = null;
try { const j = JSON.parse(fs.readFileSync(SIMPLE_FILE, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) savedSimple = j; } catch (e) { /* 無ければ未設定 */ }
function setCanonicalSimple(v) { savedSimple = v; try { fs.writeFileSync(SIMPLE_FILE, JSON.stringify(savedSimple)); } catch (e) { /* 保存失敗でも動作は続ける */ } }
// --- 画面テーマ（通常/バキバキ/ぽわぽわ）の正本もブリッジが持つ ---
const THEME_FILE = path.join(__dirname, 'theme.json');
let savedTheme = null;
try { const j = JSON.parse(fs.readFileSync(THEME_FILE, 'utf8')); if (j && (j.mode === 'baki' || j.mode === 'powa' || j.mode === 'normal')) savedTheme = j.mode; } catch (e) { /* 無ければ未設定 */ }
function setCanonicalTheme(m) { savedTheme = m; try { fs.writeFileSync(THEME_FILE, JSON.stringify({ mode: savedTheme })); } catch (e) { /* 保存失敗でも動作は続ける */ } }

// v17: 特典カスタムの正本（perks.json）。リモコンの「🎁 特典カスタム」から変更でき、
// ルーレット各プールの景品・効果／特大特典の項目と文言／ピアノ特典の名前と渡し方を保持する。
const PERKS_FILE = path.join(__dirname, 'perks.json');
const DEFAULT_PERKS = {
  fx1: ["語尾「にゃん」3分間", "語尾「〜だぜ」3分間", "一人称「ぼく」3分間", "早口言葉チャレンジ（失敗でスクワット10回）", "語尾「〜なのだ」3分", "語尾「〜じゃん」3分", "語尾「〜だもん」3分", "語尾「〜まる」3分", "語尾「〜じゃろ」3分", "「である」調 3分"],
  fx2: ["お嬢様口調＋一人称「わたくし」5分間", "猫耳フィルター 次のマッチまで", "イケボで本気の感謝", "ロリボで本気の感謝", "語尾「にゃん」5分間", "語尾「〜なのじゃ」5分", "語尾「〜ってば」5分", "敬語縛り 5分"],
  fx3: ["確変突入", "次回配信のタイトル決定権", "次回30分 語尾固定（視聴者選択）", "TikTokとXのアイコン罰仕様24時間"],
  tokudaiPerks: ["特別・名前入り手書きメッセージ", "名前入りデジタル色紙", "名前入りスマホ壁紙"],
  tokudaiNote: "✉️ 特大の特典（手書きメッセージ・色紙・壁紙）は、配信のあとに画像で送るよ。色紙と壁紙は後日になることもあるよ。送るだけの一方通行で、返信はしていないよ",
  pianoName: "ピアノ1曲リクエスト権",
  pianoNote: "仕上げて動画にするよ♡"
};
function sanitizePerks(p) {
  const out = JSON.parse(JSON.stringify(DEFAULT_PERKS));
  if (!p || typeof p !== 'object' || Array.isArray(p)) return out;
  const arr = (v) => Array.isArray(v) ? v.map(x => String(x == null ? '' : x).trim()).filter(Boolean).slice(0, 40) : null;
  const a1 = arr(p.fx1), a2 = arr(p.fx2), a3 = arr(p.fx3), at = arr(p.tokudaiPerks);
  if (a1 && a1.length) out.fx1 = a1;
  if (a2 && a2.length) out.fx2 = a2;
  if (a3 && a3.length) out.fx3 = a3;
  if (at && at.length) out.tokudaiPerks = at;
  if (typeof p.tokudaiNote === 'string' && p.tokudaiNote.trim()) out.tokudaiNote = p.tokudaiNote.trim().slice(0, 300);
  if (typeof p.pianoName === 'string' && p.pianoName.trim()) out.pianoName = p.pianoName.trim().slice(0, 60);
  if (typeof p.pianoNote === 'string' && p.pianoNote.trim()) out.pianoNote = p.pianoNote.trim().slice(0, 60);
  return out;
}
let savedPerks = null;
try { const j = JSON.parse(fs.readFileSync(PERKS_FILE, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) savedPerks = sanitizePerks(j); } catch (e) { /* 無ければ未設定（初期値のまま） */ }
function setCanonicalPerks(p) { savedPerks = sanitizePerks(p); try { fs.writeFileSync(PERKS_FILE, JSON.stringify(savedPerks)); } catch (e) { /* 保存失敗でも動作は続ける */ } }
// ============================================================
// 特大特典の受け渡し管理ログ
//   特大ギフトの特典（手書きメッセージ／デジタル色紙／スマホ壁紙）は配信後に
//   ユーザーごとに個別で渡す必要があるため、付与の記録を tokudai_log.json
//   （このフォルダ内）に永続保存し、リモコンで「渡し済み」管理ができるようにする。
//   記録はオーバーレイが「ブリッジ経由の実ギフトで特大特典を付与した」時に送る
//   { type:'tokudaiGrant' } を受けて行う（attend / highlight と同じ作法）。
//   テストモード中・手動ギフトではオーバーレイが送らないので記録されない。
//   このログは外部送信しない（Discord等へは送らない）。ファイルは .gitignore 対象。
// ============================================================
const TOKUDAI_LOG_FILE = path.join(__dirname, 'tokudai_log.json');
const TOKUDAI_PERKS = ['特別・名前入り手書きメッセージ', '名前入りデジタル色紙', '名前入りスマホ壁紙'];
let tokudaiLog = [];
try { const j = JSON.parse(fs.readFileSync(TOKUDAI_LOG_FILE, 'utf8')); if (Array.isArray(j)) tokudaiLog = j.filter((e) => e && typeof e === 'object' && typeof e.id === 'string'); } catch (e) { /* 無ければ空 */ }
function saveTokudaiLog() { try { fs.writeFileSync(TOKUDAI_LOG_FILE, JSON.stringify(tokudaiLog, null, 1)); } catch (e) { /* 保存失敗でも動作は続ける */ } }
function tokudaiLogMsg() { return { type: 'tokudaiLog', list: tokudaiLog }; }
let tokudaiSeq = 0;
function handleTokudaiGrant(msg) {
  const name = String((msg && msg.name) || '').slice(0, 40);
  if (!name) return;
  const giftName = String((msg && msg.giftName) || '').slice(0, 60);
  const cv = toPosNum(msg && msg.coins);
  const coins = cv ? Math.floor(cv) : 0;
  let perks = TOKUDAI_PERKS.slice();
  if (Array.isArray(msg.perks) && msg.perks.length) {
    const p = msg.perks.map((x) => String(x || '').slice(0, 60)).filter(Boolean).slice(0, 6);
    if (p.length) perks = p;
  }
  const d = new Date();
  tokudaiLog.push({
    id: 't' + d.getTime().toString(36) + (tokudaiSeq++).toString(36),
    ts: d.getTime(),
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`,
    name, giftName, coins, perks, done: false
  });
  saveTokudaiLog();
  console.log(`[bridge] 特大特典を記録しました: ${name}さん（${giftName || 'ギフト名不明'} / ${coins}コイン）`);
  broadcast(tokudaiLogMsg());
}
function handleTokudaiDone(msg) {
  const id = String((msg && msg.id) || '');
  if (!id) return;
  const e = tokudaiLog.find((x) => x.id === id);
  if (!e) return;
  e.done = !!(msg && msg.done);
  saveTokudaiLog();
  broadcast(tokudaiLogMsg());
}
function broadcast(obj, except) {
  const data = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws !== except && ws.readyState === 1) ws.send(data);
  }
}
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[bridge] クライアント接続 (${clients.size}件)`);
  try { ws.send(JSON.stringify({ type: 'vrcStatus', enabled: vrcEnabled })); } catch (e) { /* ignore */ }
  try { ws.send(JSON.stringify({ type: 'connectMode', auto: ttAuto })); } catch (e) { /* ignore */ }
  // いいねゲージの現在値を新規接続クライアントへ送る（オーバーレイ再読込時の表示同期用。
  // 回転の支払いは likeReward で別途指示するので、ここでは絶対に払わない）
  try { ws.send(JSON.stringify(likeStateMsg())); } catch (e) { /* ignore */ }
  // レイアウトの正本を新規接続クライアントへ送る（無ければ手持ちを出してもらう）
  try {
    if (savedLayout) ws.send(JSON.stringify({ type: 'layout', layout: savedLayout }));
    else ws.send(JSON.stringify({ type: 'requestLayout' }));
  } catch (e) { /* ignore */ }
  // 表示ON/OFFの正本を新規接続クライアントへ送る
  try { if (savedHidden) ws.send(JSON.stringify({ type: 'visibility', hidden: savedHidden })); } catch (e) { /* ignore */ }
  try { if (savedSimple) ws.send(JSON.stringify({ type: 'simple', simple: savedSimple })); } catch (e) { /* ignore */ }
  try { if (savedTheme) ws.send(JSON.stringify({ type: 'theme', mode: savedTheme })); } catch (e) { /* ignore */ }
  try { if (savedPerks) ws.send(JSON.stringify({ type: 'perks', perks: savedPerks })); } catch (e) { /* ignore */ }
  // 特大特典ログの現在値を新規接続クライアントへ送る（リモコンの一覧表示用）
  try { ws.send(JSON.stringify(tokudaiLogMsg())); } catch (e) { /* ignore */ }
  ws.on('message', (raw) => {
    let msg = null;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || !msg.type) return;
    // VRChat連携のテスト送信はブリッジが処理する（他クライアントへは中継しない）
    if (msg.type === 'vrcTest') {
      handleVrcTest();
      return;
    }
    // リモコンの「今すぐ接続」: バックオフをリセットして即接続を試みる（中継しない）
    if (msg.type === 'connectMode' && typeof msg.auto === 'boolean') {
      setConnectMode(msg.auto);
      return;
    }
    if (msg.type === 'connectNow') {
      console.log('[bridge] リモコンから「今すぐ接続」を受けました');
      try { connectTikTokNow(); } catch (e) { /* ignore */ }
      return;
    }
    // state / config は中継しつつ、VRChat送信用にテストモード・コイン帯・効果一覧を追跡する
    if (msg.type === 'state' && msg.state) {
      try { vrcTapState(msg.state); } catch (e) { /* 追跡失敗で中継を止めない */ }
    }
    if (msg.type === 'config') {
      try { vrcTapConfig(msg.cfg); } catch (e) { /* 追跡失敗で中継を止めない */ }
    }
    // 出席簿の返信はブリッジが受け取る（他クライアントへは中継しない）
    if (msg.type === 'attend' && msg.event === 'board') {
      if (attendBoardWaiter) {
        const w = attendBoardWaiter;
        attendBoardWaiter = null;
        w.resolve(Array.isArray(msg.list) ? msg.list : []);
      }
      return;
    }
    // ハイライトはブリッジが集計・記録する（他クライアントへは中継しない）
    if (msg.type === 'highlight') {
      handleHighlight(msg);
      return;
    }
    // 特大特典の付与通知はブリッジが記録する（他クライアントへは中継しない。更新後のログを全員へ配る）
    if (msg.type === 'tokudaiGrant') {
      handleTokudaiGrant(msg);
      return;
    }
    // 特大特典の「渡し済み」状態の変更もブリッジが保存する（同上）
    if (msg.type === 'tokudaiDone') {
      handleTokudaiDone(msg);
      return;
    }
    // 正本が無い間だけ、手持ちレイアウトの提示（layoutOffer）を集める
    // 採用は「保存時刻（savedAt）が最新」を最優先する。古いコピーが接続順で勝つ事故の防止
    if (msg.type === 'layoutOffer') {
      if (!savedLayout && msg.layout && typeof msg.layout === 'object' && !Array.isArray(msg.layout)) {
        const n = Object.keys(msg.layout).length;
        const at = (typeof msg.savedAt === 'number' && isFinite(msg.savedAt)) ? msg.savedAt : 0;
        if (n > 0 && (!layoutCandidate || at > layoutCandidate.savedAt ||
            (at === layoutCandidate.savedAt && n > Object.keys(layoutCandidate.layout).length))) {
          layoutCandidate = { layout: msg.layout, savedAt: at };
        }
        if (!layoutCandidateTimer) {
          layoutCandidateTimer = setTimeout(() => {
            layoutCandidateTimer = null;
            if (layoutCandidate && !savedLayout) { setCanonicalLayout(layoutCandidate.layout); broadcast({ type: 'layout', layout: savedLayout }); }
            layoutCandidate = null;
          }, 1500);
        }
      }
      return;
    }
    // 表示ON/OFFは正本として保持する（中継は下の共通処理で行う）
    if (msg.type === 'theme' && (msg.mode === 'baki' || msg.mode === 'powa' || msg.mode === 'normal')) {
      setCanonicalTheme(msg.mode);
    }
    if (msg.type === 'perks' && msg.perks && typeof msg.perks === 'object' && !Array.isArray(msg.perks)) {
      setCanonicalPerks(msg.perks);
      msg.perks = savedPerks;
    }
    if (msg.type === 'simple' && msg.simple && typeof msg.simple === 'object' && !Array.isArray(msg.simple)) {
      setCanonicalSimple(msg.simple);
    }
    if (msg.type === 'visibility' && Array.isArray(msg.hidden)) {
      setCanonicalHidden(msg.hidden.filter(x => typeof x === 'string').slice(0, 50));
    }
    // レイアウトの編集は正本として保持する（中継は下の共通処理で行う）
    // 空の layout は、正本を消してしまう誤送信を防ぐため reset:true の時だけ受け付ける
    let skipRelay = false;
    if (msg.type === 'layout' && msg.layout && typeof msg.layout === 'object' && !Array.isArray(msg.layout)) {
      if (Object.keys(msg.layout).length > 0 || msg.reset === true) setCanonicalLayout(msg.layout);
      else skipRelay = true;
    }
    // 操作系メッセージは他クライアントへ中継する
    if (!skipRelay && ['control', 'layout', 'goal', 'state', 'requestState', 'config', 'birthday', 'visibility', 'simple', 'theme', 'perks'].includes(msg.type)) {
      broadcast(msg, ws);
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
    console.log('[bridge] ポート21213は使用中です。先に起動しているサーバー（黒画面）が残っていないか確認してください。');
  } else {
    console.log('[bridge] サーバーエラー: ' + (e && e.message ? e.message : e));
  }
});
httpServer.listen(PORT, () => {
  console.log(`[bridge] 起動: http://localhost:${PORT}/  (リモコン: /remote.html)`);
  console.log(`[bridge] WebSocket待受中: ws://localhost:${PORT}`);
});
// --- 自動再起動: このファイル自体が差し替わったら（GitHub Desktop の Pull 後など）、
//     文法チェックを通った場合に限って後継プロセスを起動して自分は終了する。
//     オーバーレイ側も版の変化を検知して自動リロードするので、OBSのキャッシュ更新も不要になる。
let selfRestarting = false;
try {
  fs.watchFile(__filename, { interval: 2000 }, (cur, prev) => {
    if (selfRestarting || !prev || cur.mtimeMs === prev.mtimeMs) return;
    selfRestarting = true;
    try { require('child_process').execFileSync(process.execPath, ['--check', __filename], { stdio: 'pipe' }); }
    catch (e) { console.log('[bridge] 新しい server.js に文法エラーがあるため再起動を中止しました（今の版で継続します）'); selfRestarting = false; return; }
    console.log('[bridge] server.js の更新を検知しました。自動で再起動します…');
    try {
      const child = require('child_process').spawn(process.execPath, [__filename].concat(process.argv.slice(2)), {
        detached: true, stdio: 'inherit', env: Object.assign({}, process.env, { KIT_RESTARTED: '1' })
      });
      child.unref();
    } catch (e) { selfRestarting = false; return; }
    setTimeout(() => process.exit(0), 500);
  });
} catch (e) { /* 監視できなくても本処理は継続 */ }

// ============================================================
// Discord連携（ウェブフック）
//   discord_webhook.txt（このフォルダ内）:
//     1行目 = 出席簿まとめ用チャンネルのウェブフックURL
//     2行目 = 配信告知用チャンネルのウェブフックURL（省略時は1行目を使う）
//   ファイルが無い／空なら Discord連携は全部OFF。
//   ※URLは秘密情報。ログには絶対に出力しない。
// ============================================================
let discordAttendUrl = null;
let discordAnnounceUrl = null;
try {
  const rawCfg = fs.readFileSync(path.join(__dirname, 'discord_webhook.txt'), 'utf8');
  const cfgLines = rawCfg.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  if (cfgLines.length >= 1) discordAttendUrl = cfgLines[0];
  if (cfgLines.length >= 2) discordAnnounceUrl = cfgLines[1];
  if (!discordAnnounceUrl) discordAnnounceUrl = discordAttendUrl;
} catch (e) { /* ファイルが無ければOFF */ }
if (discordAttendUrl) {
  console.log('[discord] Discord連携: ON（出席簿まとめ＋配信告知）');
} else {
  console.log('[discord] discord_webhook.txt が無いため、Discord連携は OFF です');
}

// ウェブフック投稿は直列キューで順番に送る。失敗しても落とさない（ログだけ出して破棄）。
let discordQueue = Promise.resolve();
function postDiscord(url, content) {
  if (!url || !content) return;
  discordQueue = discordQueue.then(() => sendWebhook(url, content)).catch(() => {});
}
async function sendWebhook(url, content) {
  const body = JSON.stringify({
    content: String(content).slice(0, 1900),
    allowed_mentions: { parse: [] },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (res.ok) return;
      if (res.status === 429 && attempt === 0) {
        // レート制限: 少し待ってもう一度だけ試す
        let waitMs = 1500;
        try {
          const j = await res.json();
          if (j && j.retry_after) waitMs = Math.min(5000, Math.ceil(Number(j.retry_after) * 1000) + 250);
        } catch (e) { /* ignore */ }
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      console.log(`[discord] 投稿失敗 (HTTP ${res.status}) — この投稿は破棄します`);
      return;
    } catch (e) {
      // URLを含みうるエラー詳細は出さない
      console.log('[discord] 投稿失敗 (通信エラー) — この投稿は破棄します');
      return;
    }
  }
}

// --- 出席簿まとめ（配信終了時に1回だけ） ---
// 随時のスタンプ投稿はしない。TikTok切断時にオーバーレイへ出席簿を問い合わせ、
// 返ってきた一覧をまとめて投稿する。
let liveSessionActive = false;
let attendSummaryPosted = false;
let sawConnectFailure = false;
let attendBoardWaiter = null;
function requestAttendBoardAndPost() {
  if (!discordAttendUrl) return;
  if (attendSummaryPosted) return;
  if (clients.size === 0) return;
  let waiterResolve = null;
  const replyPromise = new Promise((resolve) => { waiterResolve = resolve; });
  attendBoardWaiter = { resolve: waiterResolve };
  broadcast({ type: 'requestAttend' });
  const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 2500));
  Promise.race([replyPromise, timeoutPromise]).then((list) => {
    if (attendBoardWaiter && attendBoardWaiter.resolve === waiterResolve) attendBoardWaiter = null;
    if (attendSummaryPosted) return;
    if (!Array.isArray(list) || list.length === 0) return; // 返信なし／空なら静かに何もしない
    attendSummaryPosted = true;
    const lines = list.slice(0, 30).map((it) => {
      const nm = String((it && it.name) || '').slice(0, 40);
      const st = Number(it && it.streak) || 0;
      const tt = Number(it && it.total) || 0;
      return `・${nm}さん 連続${st}日・通算${tt}日` + (it && it.regular ? '（常連）' : '');
    });
    postDiscord(discordAttendUrl, ['📒 今日の出席簿', ...lines].join('\n'));
    console.log('[discord] 出席簿まとめを投稿しました');
  }).catch(() => {});
}

// --- ハイライト集計（切り抜き候補） ---
// オーバーレイが送ってくる highlight メッセージを、配信開始からの経過秒つきで貯める。
// 配信終了時に告知用チャンネルへまとめ投稿し、常時 highlights_YYYY-MM-DD.txt にも残す。
// 金額（コイン数・円額）は投稿にもファイルにも書かない。
const HIGHLIGHT_LABELS = {
  jackpot: '🎰 777大当たり',
  kakuhen: '🔥 確変突入',
  super: '🌟 超大当たり',
  legend: '🌟 伝説ギフター誕生',
  attend: '📒 出席スタンプ',
  milestone: '🎯 マイルストーン到達',
  topgift: '🌟 本日の最大ギフト更新',
  mvp: '🏆 今日のMVP発表',
};
let highlightList = [];       // { elapsed: 秒, text: string }
let highlightConnectAt = 0;   // この配信の接続時刻（ms）
let highlightPosted = false;
function fmtElapsed(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
function pad2(n) { return String(n).padStart(2, '0'); }
function handleHighlight(msg) {
  const kind = String((msg && msg.kind) || '');
  const label = HIGHLIGHT_LABELS[kind];
  if (!label) return;
  const now = Date.now();
  if (!highlightConnectAt || (highlightList.length === 0 && !liveSessionActive)) highlightConnectAt = now;
  const elapsed = Math.max(0, Math.floor((now - highlightConnectAt) / 1000));
  const name = String((msg && msg.name) || '').slice(0, 40);
  const detail = String((msg && msg.detail) || '').slice(0, 60);
  const text = [label, name ? name + 'さん' : '', detail].filter(Boolean).join(' ');
  highlightList.push({ elapsed, text });
  // ファイルには常時記録する（ウェブフック未設定でも残る）
  try {
    const d = new Date();
    const file = path.join(__dirname, `highlights_${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.txt`);
    const line = `[${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}] 経過 ${fmtElapsed(elapsed)} ${text}\n`;
    fs.appendFile(file, line, (err) => { if (err) console.log('[highlight] ファイル記録に失敗しました'); });
  } catch (e) { /* 記録できなくても配信は止めない */ }
  console.log(`[highlight] ${fmtElapsed(elapsed)} ${text}`);
  try { vrcOnHighlight(text); } catch (e) { /* VRC送信でハイライト処理を止めない */ }
}
function postHighlightSummary() {
  if (highlightPosted) return;
  if (!highlightList.length) return;
  highlightPosted = true;
  const items = highlightList;
  highlightList = [];
  if (!discordAnnounceUrl) return; // ウェブフック未設定ならファイル記録のみ
  const lines = items.slice(0, 25).map((h) => `・${fmtElapsed(h.elapsed)} ${h.text}`);
  if (items.length > 25) lines.push(`…ほか ${items.length - 25} 件`);
  postDiscord(discordAnnounceUrl, ['🎬 今日のハイライト（切り抜き候補）', ...lines].join('\n'));
  console.log('[highlight] ハイライトまとめを投稿しました');
}

// ============================================================
// 配信後レポート（ブリッジ側のイベントだけで集計）
//   TikTok接続中に届くギフト/いいね/視聴者数イベントを集計し、配信終了時に
//   告知用チャンネルへ投稿する。あわせて stream_reports.txt にも残す
//   （ウェブフック未設定でもファイルには記録される）。
//   ダイヤ単価の実フィールドは版によって違う（現行 connector では
//   data.gift.diamondCount、旧形式では giftDetails.diamondCount 等）ため、
//   中継ハンドラと同じ候補＋ data.gift 系を総当たりで探す。
//   コンボ（ストリーク）ギフトは途中経過が何度も届くので、確定した
//   イベントだけを最終 repeatCount で数える（二重計上防止）。
// ============================================================
let reportStats = null;
let reportPosted = false;
function newReportStats(startAt) {
  return {
    startedAt: startAt || Date.now(),
    totalDiamonds: 0,
    giftEvents: 0,        // 集計対象になったギフトイベント数
    giftCount: 0,         // ギフトの個数（repeatCount 合計）
    unknownGiftCount: 0,  // ダイヤ単価が取れなかったギフトの個数
    gifters: new Map(),   // 名前 → ダイヤ合計（単価不明のみの人は 0 で登録）
    biggest: null,        // { name, giftName, unit } 単発ギフトの単価最大
    peakViewers: 0,
    viewersSeen: false,
    likesTotal: 0,
    likesSeen: false,
  };
}
function toPosNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  return 0;
}
function reportTrackGift(data) {
  if (!reportStats || !data) return;
  const giftObj = data.gift || data.giftDetails || {};
  // --- コンボ判定: 確定したイベントだけ数える ---
  let giftType = null;
  if (typeof giftObj.giftType === 'number') giftType = giftObj.giftType;
  else if (typeof giftObj.type === 'number') giftType = giftObj.type;
  else if (typeof data.giftType === 'number') giftType = data.giftType;
  const streakEnded = data.repeatEnd === true || data.repeatEnd === 1;
  if (data.repeatEnd === false) return;           // 既存ハンドラと同じ除外（旧形式）
  if (giftType === 1 && !streakEnded) return;     // ストリーク途中経過は数えない
  const rc = parseInt(data.repeatCount, 10);
  const count = Number.isFinite(rc) && rc > 0 ? rc : 1;
  // --- ダイヤ単価（候補を総当たり） ---
  const details = data.giftDetails || {};
  const unitCandidates = [
    data.gift && data.gift.diamondCount,
    details.diamondCount,
    data.diamondCount,
    data.totalDiamondCount,
    data.diamond_count,
    details.diamond_count,
  ];
  let unit = 0;
  for (const c of unitCandidates) { const v = toPosNum(c); if (v > 0) { unit = v; break; } }
  const user = data.user || {};
  const name = user.nickname || user.uniqueId || data.nickname || data.uniqueId || '';
  const giftName = data.giftName || (data.gift && data.gift.name) || details.giftName || details.name || '';
  const st = reportStats;
  st.giftEvents++;
  st.giftCount += count;
  if (unit > 0) {
    st.totalDiamonds += unit * count;
    if (name) st.gifters.set(name, (st.gifters.get(name) || 0) + unit * count);
    if (!st.biggest || unit > st.biggest.unit) st.biggest = { name, giftName, unit };
  } else {
    // 単価が取れないギフトは合計に入れず、個数だけ数えて概算フラグに使う
    st.unknownGiftCount += count;
    if (name && !st.gifters.has(name)) st.gifters.set(name, 0);
  }
}
function reportTrackRoomUser(data) {
  if (!reportStats || !data) return;
  // 同時視聴者数: 版によって viewerCount（数値）か total（文字列）で届く
  const v = toPosNum(data.viewerCount) || toPosNum(data.total);
  if (v > 0) {
    reportStats.viewersSeen = true;
    if (v > reportStats.peakViewers) reportStats.peakViewers = v;
  }
}
function reportTrackLike(data) {
  if (!reportStats || !data) return;
  // 累計があればそれを正とし（最大値で更新）、無ければ増分を足す
  const total = toPosNum(data.totalLikeCount) || toPosNum(data.total);
  const inc = toPosNum(data.likeCount) || toPosNum(data.count);
  if (total > 0) {
    reportStats.likesSeen = true;
    if (total > reportStats.likesTotal) reportStats.likesTotal = total;
  } else if (inc > 0) {
    reportStats.likesSeen = true;
    reportStats.likesTotal += inc;
  }
}
function fmtNum(n) { return Number(n || 0).toLocaleString('en-US'); }
function fmtDuration(ms) {
  const min = Math.max(0, Math.floor((ms || 0) / 60000));
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}時間${m}分` : `${m}分`;
}
function buildReportText(endAt) {
  const st = reportStats;
  if (!st) return null;
  if (!(st.giftEvents > 0 || st.likesSeen || st.viewersSeen)) return null; // 活動なしなら何もしない
  const lines = ['📊 今日の配信レポート'];
  lines.push(`⏱ 配信時間：${fmtDuration((endAt || Date.now()) - st.startedAt)}`);
  const usd = st.totalDiamonds * 0.005;
  const yen = Math.round(usd * 150);
  lines.push(`💎 総ダイヤ：${fmtNum(st.totalDiamonds)}（約 $${usd.toFixed(2)} ／ 目安 約¥${fmtNum(yen)}）`);
  lines.push(`🎁 ギフト：${fmtNum(st.giftCount)}個 ／ ギフトしてくれた人：${fmtNum(st.gifters.size)}人`);
  let topName = '';
  let topVal = 0;
  for (const [nm, v] of st.gifters) { if (v > topVal) { topVal = v; topName = nm; } }
  if (topName && topVal > 0) lines.push(`👑 トップギフター：${topName}さん（${fmtNum(topVal)}ダイヤ）`);
  if (st.biggest) lines.push(`🌟 最大ギフト：${st.biggest.name}さん『${st.biggest.giftName || 'ギフト'}』（${fmtNum(st.biggest.unit)}ダイヤ）`);
  if (st.viewersSeen && st.peakViewers > 0) lines.push(`👀 ピーク視聴者：${fmtNum(st.peakViewers)}人`);
  if (st.likesSeen) lines.push(`❤️ いいね：${fmtNum(st.likesTotal)}`);
  if (st.unknownGiftCount > 0) lines.push('⚠️ 一部のギフトはダイヤ数が取れなかったので概算です');
  return lines.join('\n');
}
function postStreamReport() {
  if (reportPosted) return;
  const text = buildReportText(Date.now());
  if (!text) return;
  reportPosted = true;
  // ファイルには常時残す（ウェブフック未設定でも記録される）
  try {
    const d = new Date();
    const header = `===== ${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())} 配信レポート =====`;
    fs.appendFile(path.join(__dirname, 'stream_reports.txt'), header + '\n' + text + '\n\n', (err) => {
      if (err) console.log('[report] ファイル記録に失敗しました');
    });
  } catch (e) { /* 記録できなくても配信は止めない */ }
  console.log('[report] 配信レポートを stream_reports.txt に記録しました');
  if (discordAnnounceUrl) {
    postDiscord(discordAnnounceUrl, text);
    console.log('[report] 配信レポートをDiscordに投稿しました');
  }
}


// ============================================================
// VRChat連携（OSC送信）
//   vrc_osc.txt（このフォルダ内）:
//     1行目 = on で有効（off / ファイル無し なら全部OFFで従来動作と同一）
//     2行目 = 送信先ポート（省略時 9000）
//     3行目 = 送信先アドレス（省略時 127.0.0.1。別PCのVRChatへ送る時だけ変更）
//   有効時は、ギフト到着・ハイライト（確変/777/超大当たり等）・効果当選を
//   VRChat のチャットボックス (/chatbox/input, UDP) へ流す。
//   チャットボックスは 144文字上限＆連続送信に制限があるため、
//   サーバー側でキュー＋1.5秒間隔の間引き＋同一文の重複抑制を行う。
//   金額（コイン数・円換算）はチャットボックスに出さない。
//   テストモード中（オーバーレイの state.testMode）はイベント送信しない。
//   OSCエンコードは最小限の自前実装で、追加の npm 依存は無し（dgram は Node 標準）。
// ============================================================
let vrcEnabled = false;
let vrcHost = '127.0.0.1';
let vrcPort = 9000;
try {
  const rawVrc = fs.readFileSync(path.join(__dirname, 'vrc_osc.txt'), 'utf8');
  const vrcLines = rawVrc.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  const sw = String(vrcLines[0] || '').toLowerCase();
  vrcEnabled = ['on', '1', 'true', 'yes', 'enable', 'enabled'].includes(sw);
  const pnum = parseInt(vrcLines[1], 10);
  if (Number.isFinite(pnum) && pnum > 0 && pnum < 65536) vrcPort = pnum;
  if (vrcLines[2]) vrcHost = vrcLines[2];
} catch (e) { /* ファイルが無ければOFF */ }
if (vrcEnabled) {
  console.log(`[vrc] VRChat連携: ON（OSC → ${vrcHost}:${vrcPort} /chatbox/input）`);
} else {
  console.log('[vrc] vrc_osc.txt が無いか off のため、VRChat連携は OFF です');
}

let vrcSocket = null;
function vrcGetSocket() {
  if (!vrcSocket) {
    vrcSocket = dgram.createSocket('udp4');
    vrcSocket.on('error', (err) => {
      console.log('[vrc] UDP送信エラー:', err && err.message ? err.message : err);
    });
  }
  return vrcSocket;
}
// OSC文字列: ヌル終端＋4バイト境界パディング
function oscString(str) {
  const b = Buffer.from(String(str), 'utf8');
  const pad = 4 - (b.length % 4);
  return Buffer.concat([b, Buffer.alloc(pad)]);
}
// /chatbox/input (text: string, sendNow: true) の OSC メッセージを組む
function oscChatboxPacket(text) {
  return Buffer.concat([oscString('/chatbox/input'), oscString(',sT'), oscString(text)]);
}
function truncateChatbox(text) {
  const chars = [...String(text)];
  return chars.length > 144 ? chars.slice(0, 144).join('') : String(text);
}

const VRC_COOLDOWN_MS = 1500;
const VRC_QUEUE_MAX = 12;
const VRC_DEDUP_MS = 8000;
const VRC_PRIO = { normal: 0, big: 1, high: 2 };
let vrcQueue = [];            // { text, prio }
let vrcPumpTimer = null;
let vrcLastSentAt = 0;
let vrcRecent = new Map();    // text -> キュー投入時刻（重複抑制用）
function vrcQueuePush(text, prio, opts) {
  if (!vrcEnabled || !text) return false;
  const body = truncateChatbox(text);
  const now = Date.now();
  if (!(opts && opts.bypassDedup)) {
    const last = vrcRecent.get(body);
    if (last && now - last < VRC_DEDUP_MS) return false;
  }
  if (vrcQueue.length >= VRC_QUEUE_MAX) {
    let minP = Infinity;
    for (const q of vrcQueue) if (q.prio < minP) minP = q.prio;
    if (prio <= minP) return false; // 既存キューより優先度が低ければ新規を捨てる
    const idx = vrcQueue.findIndex((q) => q.prio === minP);
    if (idx >= 0) vrcQueue.splice(idx, 1);
  }
  vrcQueue.push({ text: body, prio: prio || 0 });
  vrcRecent.set(body, now);
  if (vrcRecent.size > 100) {
    for (const [k, t] of vrcRecent) if (now - t > 30000) vrcRecent.delete(k);
  }
  vrcPump();
  return true;
}
function vrcPump() {
  if (vrcPumpTimer || !vrcQueue.length) return;
  const wait = Math.max(0, VRC_COOLDOWN_MS - (Date.now() - vrcLastSentAt));
  vrcPumpTimer = setTimeout(() => {
    vrcPumpTimer = null;
    if (!vrcQueue.length) return;
    let bi = 0;
    for (let i = 1; i < vrcQueue.length; i++) if (vrcQueue[i].prio > vrcQueue[bi].prio) bi = i;
    const item = vrcQueue.splice(bi, 1)[0];
    try {
      vrcGetSocket().send(oscChatboxPacket(item.text), vrcPort, vrcHost, (err) => {
        if (err) console.log('[vrc] UDP送信エラー:', err.message || err);
      });
      console.log('[vrc] chatbox送信:', item.text);
    } catch (e) {
      console.log('[vrc] UDP送信エラー:', e && e.message ? e.message : e);
    }
    vrcLastSentAt = Date.now();
    vrcPump();
  }, wait);
}

// --- オーバーレイ状態の追跡（ティア判定・テストモード・効果当選検出） ---
let vrcCoin2 = 100, vrcCoin3 = 1000, vrcCoin4 = 10000; // playCfg の初期値と一致
let vrcTestMode = false;
let vrcSeenFx = null; // null = ベースライン未取得（最初の state は登録だけ）
function vrcTapThresholds(cfg) {
  if (!cfg || typeof cfg !== 'object') return;
  const c2 = Number(cfg.coin2), c3 = Number(cfg.coin3), c4 = Number(cfg.coin4);
  if (Number.isFinite(c2) && c2 > 0) vrcCoin2 = c2;
  if (Number.isFinite(c3) && c3 > 0) vrcCoin3 = c3;
  if (Number.isFinite(c4) && c4 > 0) vrcCoin4 = c4;
}
function vrcTapConfig(cfg) {
  if (cfg === 'RESET') { vrcCoin2 = 100; vrcCoin3 = 1000; vrcCoin4 = 10000; return; }
  vrcTapThresholds(cfg);
}
function vrcTapState(st) {
  vrcTestMode = !!st.testMode;
  if (st.playCfg) vrcTapThresholds(st.playCfg);
  // 効果当選の検出: fx リストに新しい id が増えたら「効果当選」として流す（効果名のみ）
  const fx = Array.isArray(st.fx) ? st.fx : [];
  const ids = new Set();
  for (const f of fx) if (f && f.id != null) ids.add(f.id);
  if (vrcSeenFx === null) { vrcSeenFx = ids; return; } // 初回はベースライン登録のみ
  for (const f of fx) {
    if (!f || f.id == null || vrcSeenFx.has(f.id)) continue;
    vrcSeenFx.add(f.id);
    if (!vrcTestMode) {
      const nm = String(f.name || '').slice(0, 60);
      if (nm) vrcQueuePush(`✨ 効果当選：${nm}`, VRC_PRIO.high);
    }
  }
  if (vrcSeenFx.size > 300) vrcSeenFx = ids;
}
function vrcTierOf(coins) {
  if (coins >= vrcCoin4) return 4;
  if (coins >= vrcCoin3) return 3;
  if (coins >= vrcCoin2) return 2;
  return 1;
}
function vrcOnGift(p) {
  if (!vrcEnabled || vrcTestMode) return;
  const name = String((p && p.name) || '').slice(0, 24) || 'だれか';
  const gift = String((p && p.giftName) || '').slice(0, 30) || 'ギフト';
  const rc = parseInt(p && p.repeatCount, 10);
  const cnt = Number.isFinite(rc) && rc > 1 ? ` ×${rc}` : '';
  const coins = Number(p && p.coins) || 0;
  const tier = coins > 0 ? vrcTierOf(coins) : 1;
  if (tier >= 4) vrcQueuePush(`🌟🎁 ${name}さんから特大ギフト『${gift}』${cnt}‼️`, VRC_PRIO.big);
  else if (tier === 3) vrcQueuePush(`🔥🎁 ${name}さんから大きなギフト『${gift}』${cnt}！`, VRC_PRIO.big);
  else vrcQueuePush(`🎁 ${name}さんから『${gift}』${cnt}`, VRC_PRIO.normal);
}
function vrcOnHighlight(text) {
  if (!vrcEnabled || vrcTestMode) return;
  if (text) vrcQueuePush(String(text), VRC_PRIO.high);
}
function handleVrcTest() {
  if (!vrcEnabled) {
    console.log('[vrc] テスト送信が押されましたが、VRChat連携は OFF です（vrc_osc.txt を確認）');
    return;
  }
  // テスト送信ボタンは連携確認そのものが目的なので、重複抑制の対象外にする
  vrcQueuePush('🎰 VRC連携テスト：チャットボックス連携OKです', VRC_PRIO.high, { bypassDedup: true });
  console.log('[vrc] テスト送信をキューに入れました');
}

// --- TikTok配信開始の告知（再接続時の連投防止: 30分は再告知しない） ---
let lastTikTokAnnounceAt = 0;
function maybeAnnounceTikTok() {
  if (!discordAnnounceUrl) return;
  const now = Date.now();
  if (now - lastTikTokAnnounceAt < 30 * 60 * 1000) return;
  lastTikTokAnnounceAt = now;
  const uname = username.startsWith('@') ? username : '@' + username;
  postDiscord(discordAnnounceUrl, `🔴 TikTok LIVE はじまったよ！\nナナが配信中🎰 https://www.tiktok.com/${uname}/live`);
  console.log('[discord] TikTok LIVE告知を投稿しました');
}

// --- TikTok LIVE 接続（自動リトライ付き） ---
const connection = new TikTokLiveConnection(username, {});
const GIFT_EVENT = (WebcastEvent && WebcastEvent.GIFT) || 'gift';
const DISCONNECTED = (WebcastEvent && WebcastEvent.DISCONNECTED) || 'disconnected';
let connecting = false;
let ttRetryTimer = null, ttFailStreak = 0, ttLastLiveAt = 0;
function ttRetryDelayMs() {
  if (ttLastLiveAt && Date.now() - ttLastLiveAt < 10 * 60 * 1000) return 20000;
  if (ttFailStreak <= 2) return 20000;
  if (ttFailStreak <= 5) return 60000;
  return 180000;
}
function scheduleTtRetry() {
  if (!ttAuto) {
    if (ttFailStreak === 1) console.log('[bridge] 手動モードのため、自動では再試行しません（リモコンの「今すぐ接続」で接続できます）');
    return;
  }
  if (ttRetryTimer) return;
  const delay = ttRetryDelayMs();
  if (ttFailStreak === 3 || ttFailStreak === 6) {
    console.log(`[bridge] TikTokにまだ繋がりません。再試行を ${Math.round(delay / 1000)} 秒に1回へ減らします（リモコンの「今すぐ接続」ですぐ試せます）`);
  } else if (ttFailStreak <= 2) {
    console.log(`[bridge] ${Math.round(delay / 1000)}秒後に自動で再試行します（配信開始後に自動で繋がります）`);
  }
  ttRetryTimer = setTimeout(() => { ttRetryTimer = null; connectTikTok(); }, delay);
}
function connectTikTokNow() {
  ttFailStreak = 0;
  if (ttRetryTimer) { clearTimeout(ttRetryTimer); ttRetryTimer = null; }
  connectTikTok();
}
function connectTikTok() {
  if (connecting) return;
  connecting = true;
  connection.connect()
    .then((state) => {
      connecting = false;
      ttFailStreak = 0;
      ttLastLiveAt = Date.now();
      liveSessionActive = true;
      highlightConnectAt = Date.now();
      if (!reportStats) reportStats = newReportStats(Date.now());
      // いいね連携: 配信ルームが変わっていたら、新しい配信として節目をリセットする
      // （同じ配信への再接続では続きから数えるので、二重払いも取りこぼしもしない）
      try {
        const rid = state && state.roomId ? String(state.roomId) : null;
        if (rid && likeRoomId !== rid) {
          if (likeRoomId && (likeTotal > 0 || likePaidThrough > 0)) {
            likeTotal = 0; likePaidThrough = 0;
            console.log('[like] 新しい配信のため、いいね節目をリセットしました');
          }
          likeRoomId = rid;
          try { followSeen.clear(); shareLast.clear(); } catch (e) { /* ignore */ }
          saveLikeState();
          broadcast(likeStateMsg());
        }
      } catch (e) { /* ignore */ }
      // 配信ルームが一度消えてからの接続成功＝新しい配信とみなし、まとめ投稿を再び許可する。
      // （配信中の瞬断→即再接続では失敗を挟まないので、まとめは二重投稿されない）
      if (sawConnectFailure) {
        attendSummaryPosted = false;
        highlightList = [];
        highlightPosted = false;
        reportStats = newReportStats(Date.now());
        reportPosted = false;
        sawConnectFailure = false;
      }
      console.log(`[bridge] TikTok LIVE接続成功: ${username} (roomId: ${state.roomId})`);
      maybeAnnounceTikTok();
    })
    .catch((err) => {
      connecting = false;
      sawConnectFailure = true;
      ttFailStreak++;
      if (ttFailStreak === 1) console.error('[bridge] TikTok LIVE接続失敗:', err && err.message ? err.message : err);
      scheduleTtRetry();
    });
}
connection.on(DISCONNECTED, () => {
  console.log('[bridge] TikTok LIVEから切断されました。5秒後に再接続します');
  ttLastLiveAt = Date.now();
  if (liveSessionActive) {
    liveSessionActive = false;
    requestAttendBoardAndPost();
    postHighlightSummary();
    postStreamReport();
  }
  if (ttRetryTimer) clearTimeout(ttRetryTimer);
  ttRetryTimer = setTimeout(() => { ttRetryTimer = null; connectTikTok(); }, 5000);
});
if (ttAuto) connectTikTok();
else console.log('[bridge] 手動モードで起動しました。TikTokへはリモコンの「今すぐ接続」ボタンを押した時だけ接続します');

connection.on(GIFT_EVENT, (data) => {
  // 配信レポート用に集計する（中継とは独立に、確定イベントだけ数える）
  try { reportTrackGift(data); } catch (e) { /* 集計失敗で中継を止めない */ }
  // 連投（ストリーク）中は途中経過が何度も届くため、確定したものだけ中継する
  if (data.repeatEnd === false) return;
  const user = data.user || {};
  const name = user.nickname || user.uniqueId || data.nickname || data.uniqueId || '';
  // コイン数（diamondCount）は格納場所が版によって違うため候補を総当たりで探す
  const details = data.giftDetails || {};
  const coinCandidates = [data.diamondCount, details.diamondCount, data.totalDiamondCount, data.diamond_count, details.diamond_count];
  const coins = coinCandidates.find((v) => typeof v === 'number' && v > 0) || 0;
  const payload = {
    type: 'gift',
    name,
    giftName: data.giftName || details.giftName || '',
    coins,
    repeatCount: data.repeatCount || 1,
  };
  console.log('[bridge] gift:', payload);
  if (!coins) {
    // コイン数が取れていない場合は、実際のフィールド名を特定するためにキー一覧を出す
    console.log('[bridge] gift raw keys:', Object.keys(data).join(','));
    console.log('[bridge] giftDetails keys:', Object.keys(details).join(','));
  }
  broadcast(payload);
  try { vrcOnGift(payload); } catch (e) { /* VRC送信で中継を止めない */ }
});

// コメントを中継する（コメントで無料ルーレット等の参加ギミック用）
const CHAT_EVENT = (WebcastEvent && WebcastEvent.CHAT) || 'chat';
try {
  connection.on(CHAT_EVENT, (data) => {
    try {
      const user = (data && data.user) || {};
      const name = user.nickname || user.uniqueId || (data && data.nickname) || '';
      const comment = (data && data.comment) || '';
      if (comment) broadcast({ type: 'chat', name: String(name || ''), comment: String(comment) });
    } catch (e) { /* ignore */ }
  });
} catch (e) { console.log('[bridge] chat relay unavailable:', e && e.message); }

// ============================================================
// いいね連携（節目で回転数を追加する。ルーレットは回さない）
//   TikTokの「いいね」イベントの合計数（totalLikeCount）を監視し、
//   節目を超えるたびにオーバーレイへ { type:'likeReward' } で回転数の
//   追加だけを指示する。あわせて { type:'likeState' } でゲージ表示用の
//   現在値を送る。
//   支払い管理はブリッジ側が正：
//     - likeTotal は確認した合計数の「最大値」を保持する（再接続で
//       同じ区間のイベントが再送されても巻き戻らない）。
//     - likePaidThrough（払い済みの最大の節目）より先の節目だけ払う
//       ので、オーバーレイの再読み込み・再接続でも二重加算しない。
//     - 状態は like_state.json に保存し、サーバー再起動後も続きから
//       数える。配信ルーム（roomId）が変わったら新しい配信として
//       自動リセットする。
//   閾値と報酬は下の LIKE_CFG に集約（将来のリモコン設定移行用）。
// ============================================================
const LIKE_CFG = {
  step: 500,      // いいね何個ごとに節目が来るか
  stepSpins: 10,  // 節目ごとの追加回転数
  bigEvery: 1000, // この倍数の節目ではボーナスが付く
  bigBonus: 20,   // ボーナス回転数（例: 1,000の節目は +10+20 = 合計+30回転）
};
// いいねラッシュ（フィーバー）: 合計いいねが feverEvery の倍数の節目を
// 超えるたびに発動する。発動判定は節目の支払い管理（likePaidThrough）と
// 一体なので、再接続・再起動で通過済みの節目に再発動することはない。
const FEVER_CFG = {
  feverEvery: 1000, // 合計いいね何個ごとにフィーバーが発動するか
  durationSec: 30,  // フィーバーの持続秒数（オーバーレイ側で数え直し可能）
};
const LIKE_STATE_FILE = path.join(__dirname, 'like_state.json');
let likeTotal = 0;       // 確認した合計いいね数の最大値
let likePaidThrough = 0; // 回転を払い済みの最大の節目
let likeRoomId = null;   // 現在の配信ルーム（変わったら新しい配信としてリセット）
function saveLikeState() {
  try {
    fs.writeFileSync(LIKE_STATE_FILE, JSON.stringify({ total: likeTotal, paidThrough: likePaidThrough, roomId: likeRoomId }));
  } catch (e) { /* 保存できなくても配信は止めない */ }
}
try {
  const savedLike = JSON.parse(fs.readFileSync(LIKE_STATE_FILE, 'utf8'));
  if (savedLike && typeof savedLike === 'object') {
    if (Number.isFinite(savedLike.total) && savedLike.total > 0) likeTotal = savedLike.total;
    if (Number.isFinite(savedLike.paidThrough) && savedLike.paidThrough > 0) likePaidThrough = savedLike.paidThrough;
    if (savedLike.roomId) likeRoomId = String(savedLike.roomId);
  }
} catch (e) { /* ファイルが無ければ初期状態から */ }
function likeStateMsg() {
  return {
    type: 'likeState',
    total: likeTotal,
    paidThrough: likePaidThrough,
    nextAt: likePaidThrough + LIKE_CFG.step,
    step: LIKE_CFG.step,
    stepSpins: LIKE_CFG.stepSpins,
    bigEvery: LIKE_CFG.bigEvery,
    bigBonus: LIKE_CFG.bigBonus,
  };
}
function likeTrackMilestone(data) {
  if (!data) return;
  // 累計（totalLikeCount）があれば最大値で更新し、無ければ増分を足す
  // （配信レポート側の reportTrackLike と同じ読み取り方）
  const total = toPosNum(data.totalLikeCount) || toPosNum(data.total);
  const inc = toPosNum(data.likeCount) || toPosNum(data.count);
  if (total > 0) {
    if (total <= likeTotal) return; // 増えていない（再送・巻き戻り）なら何もしない
    likeTotal = total;
  } else if (inc > 0) {
    likeTotal += inc;
  } else {
    return;
  }
  // 未払いの節目をまとめて払う
  let gained = 0;
  const crossed = [];
  while (likePaidThrough + LIKE_CFG.step <= likeTotal) {
    likePaidThrough += LIKE_CFG.step;
    gained += LIKE_CFG.stepSpins + (likePaidThrough % LIKE_CFG.bigEvery === 0 ? LIKE_CFG.bigBonus : 0);
    crossed.push(likePaidThrough);
  }
  saveLikeState();
  broadcast(likeStateMsg());
  if (gained > 0) {
    broadcast({ type: 'likeReward', spins: gained, milestones: crossed, total: likeTotal });
    console.log(`[like] 節目到達: ${crossed.join(', ')} いいね → +${gained}回転（合計いいね ${likeTotal}）`);
  }
  // いいねラッシュ: feverEvery の倍数の節目を超えたらフィーバー開始を指示する。
  // 判定は払い済み節目（crossed）ベースなので、通過済み節目の再発動はない。
  // フィーバー中に次の節目を超えた場合も同じ指示を送り、オーバーレイ側で
  // 30秒をその時点から数え直す（再スタート）。
  if (crossed.some((m) => m % FEVER_CFG.feverEvery === 0)) {
    broadcast({ type: 'likeRush', seconds: FEVER_CFG.durationSec });
    console.log(`[likeRush] 合計いいね ${likeTotal} → ラッシュ発動（${FEVER_CFG.durationSec}秒）`);
  }
}

// 視聴者数は配信レポートの集計専用（中継しない）。
// いいねはレポート集計に加えて、上の節目連携（likeReward / likeState）も行う。
const ROOM_USER_EVENT = (WebcastEvent && WebcastEvent.ROOM_USER) || 'roomUser';
try {
  connection.on(ROOM_USER_EVENT, (data) => {
    try { reportTrackRoomUser(data); } catch (e) { /* ignore */ }
  });
} catch (e) { console.log('[bridge] roomUser tracking unavailable:', e && e.message); }
const LIKE_EVENT = (WebcastEvent && WebcastEvent.LIKE) || 'like';
try {
  connection.on(LIKE_EVENT, (data) => {
    try { reportTrackLike(data); } catch (e) { /* ignore */ }
    try { likeTrackMilestone(data); } catch (e) { /* ignore */ }
  });
} catch (e) { console.log('[bridge] like tracking unavailable:', e && e.message); }

// ============================================================
// 盛り上げ連携: フォロー／シェア（回転+5）＋いいねラッシュ（演出のみ）
//   フォロー: 同一ユーザーは1配信につき1回だけ有効（Setで管理し、
//     配信ルームが変わったらいいね節目リセットと同じ場所でクリアする）。
//     'follow' イベントが第一候補。'social' イベントの displayType に
//     follow を含むものも拾うフォールバックを付け、二重発火は Set で吸収する。
//   シェア: 同一ユーザーは60秒に1回まで有効（最終有効時刻を Map で保持）。
//     'share' イベント＋ 'social' フォールバック（フォローと同じ作法）。
//   いいねラッシュ: 合計いいねが1,000の倍数の節目を超えるたびに
//     { type:'likeRush' } を送る（発動判定は likeTrackMilestone 内。
//     節目の支払い管理と一体なので再発動しない）。
// ============================================================
const FOLLOW_EVENT = (WebcastEvent && WebcastEvent.FOLLOW) || 'follow';
const SHARE_EVENT = (WebcastEvent && WebcastEvent.SHARE) || 'share';
const SOCIAL_EVENT = (WebcastEvent && WebcastEvent.SOCIAL) || 'social';
const followSeen = new Set();   // この配信でフォロー報酬を払い済みのユーザー名
const shareLast = new Map();    // ユーザー名 → 最後にシェア報酬を払った時刻(ms)
const SHARE_COOLDOWN_MS = 60 * 1000;
function eventUserName(data) {
  const user = (data && data.user) || {};
  return user.nickname || user.uniqueId || (data && data.nickname) || (data && data.uniqueId) || '';
}
function handleFollowEvent(data) {
  const name = String(eventUserName(data) || '');
  if (!name) return;
  if (followSeen.has(name)) return; // 1配信1回（follow/social の二重発火もここで吸収）
  followSeen.add(name);
  broadcast({ type: 'follow', name });
  console.log(`[follow] ${name} さん フォロー → オーバーレイへ +5回転を指示`);
}
function handleShareEvent(data) {
  const name = String(eventUserName(data) || '');
  if (!name) return;
  const now = Date.now();
  const last = shareLast.get(name) || 0;
  if (now - last < SHARE_COOLDOWN_MS) return; // 60秒に1回まで
  shareLast.set(name, now);
  broadcast({ type: 'share', name });
  console.log(`[share] ${name} さん シェア → オーバーレイへ +5回転を指示`);
}
try {
  connection.on(FOLLOW_EVENT, (data) => { try { handleFollowEvent(data); } catch (e) { /* ignore */ } });
} catch (e) { console.log('[bridge] follow relay unavailable:', e && e.message); }
try {
  connection.on(SHARE_EVENT, (data) => { try { handleShareEvent(data); } catch (e) { /* ignore */ } });
} catch (e) { console.log('[bridge] share relay unavailable:', e && e.message); }
try {
  connection.on(SOCIAL_EVENT, (data) => {
    try {
      const dt = String((data && (data.displayType || data.display_type)) || '').toLowerCase();
      if (dt.includes('follow')) handleFollowEvent(data);
      else if (dt.includes('share')) handleShareEvent(data);
    } catch (e) { /* ignore */ }
  });
} catch (e) { console.log('[bridge] social relay unavailable:', e && e.message); }

// ============================================================
// YouTube LIVE 検知（ブリッジ起動中のみ・3分おきにチャンネルの /live を確認）
//   ※公式APIではなくページの公開情報を読む方式。YouTube側の仕様変更で
//     検知できなくなることがある（その場合は静かに何もしない）。
// ============================================================
const YT_CHANNEL_ID = 'UC_3-WNmVJoUZoFik38YzGlQ';
const YT_LIVE_URL = process.env.BRIDGE_YT_LIVE_URL || `https://www.youtube.com/channel/${YT_CHANNEL_ID}/live`;
const YT_POLL_MS = Number(process.env.BRIDGE_YT_POLL_MS) > 0 ? Number(process.env.BRIDGE_YT_POLL_MS) : 3 * 60 * 1000;
let lastYtAnnouncedId = null;
let ytFailCount = 0;

function parseYouTubeLive(html) {
  if (!html || typeof html !== 'string') return null;
  if (html.includes('"liveBroadcastContent":"upcoming"')) return null;
  const isLive = html.includes('"liveBroadcastContent":"live"') || html.includes('"isLive":true');
  if (!isLive) return null;
  let videoId = null;
  let m = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/);
  if (m) videoId = m[1];
  if (!videoId) {
    m = html.match(/"videoId":"([\w-]{11})"/);
    if (m) videoId = m[1];
  }
  if (!videoId) return null;
  let title = '';
  m = html.match(/"videoDetails":\{[^}]*?"title":"((?:[^"\\]|\\.)*)"/);
  if (m) {
    try { title = JSON.parse('"' + m[1] + '"'); } catch (e) { title = m[1]; }
  }
  if (!title) {
    m = html.match(/<meta property="og:title" content="([^"]*)"/);
    if (m) title = m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  return { videoId, title: String(title || '') };
}

async function checkYouTubeLive() {
  if (!discordAnnounceUrl) return;
  let html = null;
  try {
    const res = await fetch(YT_LIVE_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language': 'ja-JP,ja;q=0.9',
      },
    });
    if (!res.ok) throw new Error('http error');
    html = await res.text();
  } catch (e) {
    ytFailCount++;
    if (ytFailCount === 1) console.log('[youtube] ライブ確認に失敗しました（次回リトライします）');
    return;
  }
  ytFailCount = 0;
  const info = parseYouTubeLive(html);
  if (!info) return;
  if (info.videoId === lastYtAnnouncedId) return;
  lastYtAnnouncedId = info.videoId;
  const titlePart = info.title ? `『${info.title}』\n` : '';
  postDiscord(discordAnnounceUrl, `🔴 YouTube LIVE はじまったよ！\n${titlePart}https://www.youtube.com/watch?v=${info.videoId}`);
  console.log('[youtube] YouTube LIVE告知を投稿しました');
}
if (discordAnnounceUrl) {
  setTimeout(checkYouTubeLive, Math.min(30000, YT_POLL_MS));
  setInterval(checkYouTubeLive, YT_POLL_MS);
}
