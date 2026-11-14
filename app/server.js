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
const SLOTS = ['voice', 'cam', 'vfx', 'scene'];
// 種類の多いもの（語尾・しゃべり方・マイクエフェクト・セリフ・早口言葉）は「決まった順番で次へ進む」。
// 次に何が来るかは画面のギフト表に「つぎ：〇〇」と出るので、運の要素にはならない。
// fx の {x} に、順番リストの今の項目が入る。use:'line' はセリフ集、use:'challenge' は早口言葉リストを使う。
const DEFAULT_BANDS = [
  { from: 1, tier: 'S', ico: '🌹', fx: 'なながお名前を呼ぶ', short: 'お名前コール' },
  { from: 5, tier: 'M', ico: '💬', fx: 'セリフ「{x}」', use: 'line', short: 'セリフ' },
  { from: 10, tier: 'M', ico: '🐱', fx: '語尾「{x}」', min: 3, slot: 'voice', short: '語尾チェンジ', list: ['にゃん', 'ぴょん', 'でござる', 'っす', 'だぞ', 'ですわ', 'なのだ'] },
  { from: 20, tier: 'M', ico: '✏️', fx: 'お名前であいうえお作文', short: 'あいうえお作文' },
  { from: 30, tier: 'M', ico: '🎭', fx: '{x}でしゃべる', min: 5, slot: 'voice', short: 'しゃべり方', list: ['関西弁', 'お嬢様口調', '執事口調', 'ツンデレ', '一人称「俺」', '実況アナウンサー風', '博多弁'] },
  { from: 50, tier: 'M', ico: '🎙️', fx: 'マイク：{x}', min: 2, slot: 'vfx', short: 'マイクエフェクト', list: ['ロボ声', 'ヘリウム声', '低音ボイス', 'エコー', 'ラジオ風', 'メガホン'] },
  { from: 100, tier: 'L', ico: '🌌', fx: '画面エフェクト：{x}', min: 2, slot: 'scene', short: '画面エフェクト', list: ['ラメ', 'オーロラ', 'ステンドグラス', '星空', '夕暮れ', '雨の窓', '桜吹雪', '雪', 'ホタル', 'ネオン'] },
  { from: 150, tier: 'L', ico: '👅', fx: '早口言葉チャレンジ', use: 'challenge', short: '早口言葉' },
  { from: 199, tier: 'L', ico: '🎥', fx: '手元カメラON', min: 10, slot: 'cam', short: '手元カメラ' },
  { from: 299, tier: 'L', ico: '🦵', fx: 'スクワット10回', short: 'スクワット', link: 'vts:jump' },
  { from: 500, tier: 'L', ico: '🎹', fx: 'ピアノ サビだけ1曲', req: 'サビ', short: 'サビだけ' },
  { from: 1000, tier: 'XL', ico: '🎹', fx: 'ピアノ フルで1曲', req: 'フル', short: 'フルで1曲', link: 'vts:rainbow vts:spin' },
  { from: 5000, tier: 'XL', ico: '🎤', fx: 'ピアノ弾き語り1曲', req: '弾き語り', short: '弾き語り', link: 'vts:rainbow vts:grow' },
];
// セリフ集・早口言葉・罰ゲーム（リモコンで編集できる）
const DEFAULT_LINES = ['おかえり、待ってたよ', '今日もがんばったね、えらい！', 'べ、別にうれしくなんかないんだからね！', 'いっしょにがんばろ！', 'まかせて！', 'ずっと応援してくれてありがとう', 'ちょっとだけ、こっち見て？', 'ふふ、いい名前だね', '今日来てくれて、ほんとにうれしい', 'おやすみ、いい夢見てね'];
const DEFAULT_TWISTERS = ['生麦生米生卵', '隣の客はよく柿食う客だ', '東京特許許可局', '赤巻紙青巻紙黄巻紙', 'バスガス爆発', '坊主が屏風に上手に坊主の絵を描いた', '新春シャンソンショー', '除雪車除雪作業中', '骨粗鬆症訴訟勝訴', '貨客船の旅客'];
// みんなで達成したときに なな が読む長めのセリフ（順番に使う）
const DEFAULT_TEAM_LINES = ["みんな、本当にありがとう！ひとりじゃ絶対ここまで来られなかったよ。今日いっしょにいてくれて、すっごくうれしい！", "ゲージ満タン、達成〜！いいねもコメントもギフトも、ぜんぶ届いてたよ。みんなのおかげで、今日がもっと好きな日になりました。", "やったー！みんなで達成！画面の向こうでポチポチしてくれた指、ぜんぶにありがとうを言いたい気分です。", "達成できたのは、ここにいるみんなが少しずつ力を貸してくれたから。ちいさな一歩の積み重ねって、ほんとにすごいね。", "ねえ聞いて、みんなで達成したよ！こういう瞬間のために配信してるんだなって、今あらためて思ってる。ありがとう！", "はじめましての人も、いつも来てくれる人も、みんなまとめて大好きです！今日の達成は、みんなの名前で記念日にしちゃおう。", "いっぱい応援してくれてありがとう。正直ちょっと泣きそう…。この気持ち、ピアノの音にのせて返すから聴いててね。", "みんなで達成〜！今日のゲージ、いつもよりあったかい色に見えるのは気のせいじゃないと思う。ほんとにありがとう！", "コメントひとつ、いいねひとつが、ちゃんと力になってるんだよ。今日はそれを全部まとめて受け取りました。ありがとう！", "達成おめでとう、わたしたち！こうやって一緒に何かをやりとげられるの、本当に幸せなことだなって思います。", "ありがとう、ありがとう、ありがとう！何回言っても足りないけど、とりあえず三回言っとくね。みんな最高！", "今日ここに集まってくれたみんなは、もう立派なチームです。これからも一緒に、いろんな景色を見に行こうね。", "ゲージがいっぱいになるのを見てたら、心までいっぱいになっちゃった。来てくれて、残ってくれて、ありがとう。", "みんなの「がんばれ」が、ちゃんと届いてました。今度はわたしが、みんなの毎日をちょっとだけ明るくする番だね。", "達成しました〜！いつも見守ってくれている人、今日たまたま来てくれた人、どっちも大切な仲間です。ありがとう！", "ひとりで弾くピアノもいいけど、みんなに聴いてもらえるピアノはもっと好き。その気持ちを、今から一曲にこめるね。", "すごいすごい、みんなで達成だよ！こんなに応援してもらえる配信者でいられること、ちゃんと誇りに思ってます。", "ここまで連れてきてくれてありがとう。次の目標も、みんなと一緒ならきっと大丈夫って思えるよ。", "達成の瞬間、画面の前でガッツポーズしちゃった。見えてないと思うけど、ほんとにしたからね！みんなありがとう！", "いいねを押してくれた回数だけ、わたしの元気がチャージされてます。今日はもう満タンどころかあふれてるよ！", "みんなで達成できたから、今日はちょっとだけ自分のことも褒めてあげようかな。…いや、やっぱりみんなを褒めたい！", "この配信が、誰かの「今日いいことあった」になってたらうれしいな。わたしにとっては、みんなが今日のいいことです。", "ねえ、今日のこと忘れないでね。わたしは絶対に忘れないから。みんなで達成した、この瞬間のこと。", "疲れてる日も、なんとなく来てくれた日も、ここにいてくれてありがとう。みんなの居場所になれてたら、すごくうれしい。", "達成〜！みんなの応援は、わたしの一番のエネルギーです。ここからもう一段ギア上げていくので、ついてきてね！", "今日のチームワーク、百点満点です！コメント欄のあったかさに、ずっと助けられてました。本当にありがとう。", "みんなの力が集まると、こんなに大きなことができるんだね。ちいさな「好き」がたくさん集まった、すてきなゲージでした。", "約束どおり、ここからはお礼の時間！みんなが集めてくれた気持ちに負けないくらい、心をこめて弾きます。", "またひとつ、みんなとの思い出が増えました。これからもたくさん一緒に作っていこうね。ありがとう、大好き！", "最後まで一緒に走ってくれてありがとう！今日のこの景色は、ここにいるみんなにしか見られない特別なものだよ。"];
const DEFAULT_PENALTIES = ['ぶりっ子で「ごめんにゃさい♡」', '全力の「ありがとう！」を3回', '自分のいいところを3つ言う', '1分間 語尾「にゃん」', 'アバターで変顔10秒', 'イケボで「次は負けない」'];
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
  // 効果音：theme＝標準の音の雰囲気（arcade ゲーセン／sparkle キラキラ／soft やさしい）、map＝自分の音声ファイルに差し替え（効果音フォルダ）
  sound: { on: true, volume: 0.5, theme: 'arcade', map: {} },
  chainSec: 10,
  vts: { on: false, port: 8001 },  // VTube Studio 連携
  fxLevel: 'normal',  // 演出の強さ: normal（ふつう）/ dopa（ドパドパ）
  look: 'panel',      // パネルの見せ方: panel（しっかり）/ airy（すっきり・アバター重視）
  // ランキング表示（その日の配信ぶん）。showCoins は初期OFF（金額を画面に出さない）
  rank: { on: true, showCoins: false, likes: true, mvp: true },
  likeHearts: true,   // いいねで画面にハートがわく
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
    const lk = str(b.link, 120, '').trim();
    if (lk) o.link = lk;
    const sh = str(b.short, 16, '');
    if (sh) o.short = sh;
    const min = clamp(b.min, 0, 120, 0);
    if (SLOTS.includes(b.slot) && min > 0) { o.slot = b.slot; o.min = min; }
    const req = str(b.req, 12, '');
    if (req && !o.slot) o.req = req;
    if ((b.use === 'line' || b.use === 'challenge') && !o.slot && !o.req) o.use = b.use;
    if (Array.isArray(b.list)) { const l = b.list.map((x) => str(x, 30, '').trim()).filter(Boolean).slice(0, 30); if (l.length) o.list = l; }
    out.push(o);
  }
  out.sort((a, b) => a.from - b.from);
  out.forEach((b, i) => { b.id = 'b' + b.from; b.to = out[i + 1] ? out[i + 1].from - 1 : null; });
  return out.length ? out : null;
}
function sanitizeList(arr, max, d, len) {
  if (!Array.isArray(arr)) return d.slice();
  const l = arr.map((x) => str(x, len || 60, '').trim()).filter(Boolean).slice(0, max);
  return l.length ? l : d.slice();
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
// 効果音の差し替え（キットの「効果音」フォルダに入れた mp3 / wav / ogg / m4a）
const SFX_KEYS = ['S', 'M', 'L', 'XL', 'team', 'chain', 'mile', 'lv', 'feverIn', 'pop', 'likeBig', 'jackpot', 'ok', 'buzz', 'scene'];
const SFX_DIR = path.join(__dirname, '..', '効果音');
function safeSfxName(n) { return typeof n === 'string' && n.length < 120 && /\.(mp3|wav|ogg|m4a)$/i.test(n) && !/[\\/]|\.\./.test(n); }
let sfxFiles = [];
function scanSfx() { try { fs.mkdirSync(SFX_DIR, { recursive: true }); sfxFiles = fs.readdirSync(SFX_DIR).filter(safeSfxName).slice(0, 300); } catch (e) { sfxFiles = []; } }
scanSfx();
function sanitizeSettings(s, base) {
  const b = base || DEFAULT_SETTINGS;
  const o = JSON.parse(JSON.stringify(b));
  if (!s || typeof s !== 'object') return o;
  if (typeof s.topic === 'string') o.topic = s.topic.slice(0, 40);
  if (s.mode === 'avatar' || s.mode === 'game') o.mode = s.mode;
  if (s.fxLevel === 'normal' || s.fxLevel === 'dopa') o.fxLevel = s.fxLevel;
  if (s.look === 'panel' || s.look === 'airy') o.look = s.look;
  if (typeof s.likeHearts === 'boolean') o.likeHearts = s.likeHearts;
  if (s.vts && typeof s.vts === 'object') { if (typeof s.vts.on === 'boolean') o.vts.on = s.vts.on; o.vts.port = Math.round(clamp(s.vts.port, 1, 65535, o.vts.port)); }
  if (s.rank && typeof s.rank === 'object') for (const k of ['on', 'showCoins', 'likes', 'mvp']) if (typeof s.rank[k] === 'boolean') o.rank[k] = s.rank[k];
  if (s.atmo && typeof s.atmo === 'object') {
    if (typeof s.atmo.on === 'boolean') o.atmo.on = s.atmo.on;
    o.atmo.strength = clamp(s.atmo.strength, 0, 1, o.atmo.strength);
  }
  if (s.sound && typeof s.sound === 'object') {
    if (typeof s.sound.on === 'boolean') o.sound.on = s.sound.on;
    o.sound.volume = clamp(s.sound.volume, 0, 1, o.sound.volume);
    if (['arcade', 'sparkle', 'soft'].includes(s.sound.theme)) o.sound.theme = s.sound.theme;
    if (s.sound.map && typeof s.sound.map === 'object') {
      const mp = {};
      for (const k of SFX_KEYS) { const v = s.sound.map[k]; if (typeof v === 'string' && v && safeSfxName(v)) mp[k] = v; }
      o.sound.map = mp;
    }
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
  slots: { voice: { cur: null, q: [] }, cam: { cur: null, q: [] }, vfx: { cur: null, q: [] }, scene: { cur: null, q: [] } },
  requests: [],
  lines: DEFAULT_LINES.slice(), teamLines: DEFAULT_TEAM_LINES.slice(), twisters: DEFAULT_TWISTERS.slice(), penalties: DEFAULT_PENALTIES.slice(),
  idx: {},           // 順番リストの進み具合（段ごと）
  challenge: { cur: null, q: [] }, // 早口言葉チャレンジ
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
    K.lines = sanitizeList(j.lines, 100, DEFAULT_LINES); K.twisters = sanitizeList(j.twisters, 100, DEFAULT_TWISTERS); K.penalties = sanitizeList(j.penalties, 100, DEFAULT_PENALTIES);
    K.teamLines = sanitizeList(j.teamLines, 100, DEFAULT_TEAM_LINES, 160);
    if (j.idx && typeof j.idx === 'object') K.idx = j.idx;
    if (j.challenge && typeof j.challenge === 'object') K.challenge = { cur: j.challenge.cur || null, q: Array.isArray(j.challenge.q) ? j.challenge.q.slice(0, 30) : [] };
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
    settings: K.settings, bands: K.bands.map((b) => Object.assign({}, b, { next: nextOf(b) })), style: K.style,
    team: { value: Math.round(K.team.value), max: K.settings.teamMax, label: K.settings.teamLabel },
    slots: K.slots, requests: K.requests,
    challenge: K.challenge, lists: { lines: K.lines, teamLines: K.teamLines, twisters: K.twisters, penalties: K.penalties },
    conn: { auto: ttAuto, live: liveSessionActive, user: username },
    vts: { status: VTS.status, hotkeys: VTS.hotkeys },
    sfxFiles,
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
// 順番リストの「今の項目」を取り出して次へ進める
function poolOf(b) { return b.use === 'line' ? K.lines : b.use === 'challenge' ? K.twisters : (b.list || null); }
function nextOf(b) { const p = poolOf(b); return p && p.length ? p[(K.idx[b.id] || 0) % p.length] : null; }
function takeItem(b) {
  const p = poolOf(b);
  if (!p || !p.length) return { fx: b.fx.replace('{x}', ''), item: null };
  const i = (K.idx[b.id] || 0) % p.length;
  K.idx[b.id] = i + 1;
  const item = p[i];
  return { fx: b.fx.includes('{x}') ? b.fx.replace('{x}', item) : b.fx, item };
}

// 早口言葉チャレンジ：3回続けて言えたら成功。途中で噛んだら罰ゲーム（罰ゲームも順番）。判定はリモコンで なな がする
function chStartNext() {
  const C = K.challenge;
  const x = C.q.shift();
  C.cur = x ? Object.assign(x, { reps: [], state: 'active', startedAt: Date.now() }) : null;
  if (C.cur) broadcast({ type: 'ev', kind: 'challenge', phase: 'start', ch: C.cur });
}
function chMark(ok) {
  const C = K.challenge, c = C.cur;
  if (!c || c.state !== 'active') return;
  c.reps.push(!!ok);
  if (!ok) {
    const pl = K.penalties;
    const i = (K.idx.__penalty || 0) % pl.length;
    K.idx.__penalty = i + 1;
    c.state = 'ng'; c.penalty = pl[i]; c.until = Date.now() + 9000;
    linkOn('vts:shake', 0);
    broadcast({ type: 'ev', kind: 'challenge', phase: 'ng', ch: c });
    if (!c.test) recordHighlight(`👅 早口言葉『${c.phrase}』失敗 → 罰ゲーム「${c.penalty}」（${c.user}さん）`);
  } else if (c.reps.length >= 3) {
    c.state = 'ok'; c.until = Date.now() + 6000;
    linkOn('vts:spin', 0);
    broadcast({ type: 'ev', kind: 'challenge', phase: 'ok', ch: c });
    if (!c.test) recordHighlight(`👅 早口言葉『${c.phrase}』成功！（${c.user}さん）`);
  } else broadcast({ type: 'ev', kind: 'challenge', phase: 'mark', ch: c });
  pushState();
}
setInterval(() => {
  const c = K.challenge.cur;
  if (c && c.until && c.until <= Date.now()) { chStartNext(); pushState(); }
  else if (!c && K.challenge.q.length) { chStartNext(); pushState(); }
}, 500);

function slotAdd(slot, item) {
  const S = K.slots[slot];
  const ms = item.min * 60000 * item.count;
  if (S.cur && S.cur.bandId === item.bandId && S.cur.end > Date.now()) { S.cur.end += ms; return true; } // 同じ変身中 → 延長（bandId は段＋項目）
  const q = S.q.find((x) => x.bandId === item.bandId);
  if (q) { q.ms += ms; return true; }
  S.q.push({ bandId: item.bandId, user: item.user, fx: item.fx, ico: item.ico, short: item.short, link: item.link || '', ms });
  if (!S.cur || S.cur.end <= Date.now()) slotNext(slot);
  return false;
}
function slotNext(slot) {
  const S = K.slots[slot];
  if (S.cur && S.cur.link) linkOff(S.cur.link);   // 終わった変身の連携を元に戻す
  const x = S.q.shift();
  S.cur = x ? { bandId: x.bandId, user: x.user, fx: x.fx, ico: x.ico, short: x.short, link: x.link || '', end: Date.now() + x.ms } : null;
  if (S.cur && S.cur.link) linkOn(S.cur.link, null); // 始まった変身の連携をON（終わるまで）
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
    const tl = K.teamLines.length ? K.teamLines[(K.idx.__team || 0) % K.teamLines.length] : '';
    K.idx.__team = (K.idx.__team || 0) + 1;
    K.requests.push({ id: 'r' + Date.now().toString(36) + (seq++), user: 'みんな', kind: 'TEAM達成', line: tl, at: Date.now() });
    broadcast({ type: 'ev', kind: 'team', label: K.settings.teamLabel, line: tl, test: !!test });
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
  let fx = b ? b.fx : '', item = null;
  if (b) {
    ({ fx, item } = takeItem(b));
    if (b.slot) {
      // 同じ段・同じ項目が発動中なら延長。同じ段の別の項目なら切り替え＋時間を足す
      const key = b.id + (item ? ':' + item : '');
      const S = K.slots[b.slot];
      if (b.list && S.cur && S.cur.bandId && S.cur.bandId.startsWith(b.id + ':') && S.cur.bandId !== key && S.cur.end > Date.now()) {
        // 同じ段の別の項目が発動中 → その場で次の項目に切り替えて、時間を足す（「つぎ：〇〇」の表示どおりに進む）
        Object.assign(S.cur, { bandId: key, user, fx, end: S.cur.end + b.min * 60000 * count });
      } else ext = slotAdd(b.slot, { bandId: key, user, fx, ico: b.ico, short: b.short, link: b.link || '', min: b.min, count });
    }
    if (b.req) for (let i = 0; i < Math.min(count, 10); i++) K.requests.push({ id: 'r' + Date.now().toString(36) + (seq++), user, kind: b.req, at: Date.now() });
    if (b.link && !b.slot) linkOn(b.link, 9000);
    if (b.use === 'challenge') { K.challenge.q.push({ id: 'c' + Date.now().toString(36) + (seq++), user, phrase: item || '生麦生米生卵', test: !!test }); if (!K.challenge.cur) chStartNext(); }
  }
  broadcast({
    type: 'ev', kind: 'gift', user, giftName, giftIco: giftIcon(giftName, b), coins, count, test: !!test,
    band: b ? { id: b.id, tier: b.tier, ico: b.ico, fx, item, use: b.use || null, min: b.min || 0, slot: b.slot || null, req: b.req || null } : null, ext,
  });
  const w = K.settings.teamW;
  teamAdd(Math.min(w.giftCap, 8 + Math.sqrt(coins || 1) * 6) * Math.min(count, 10), test);
  pushState();
  if (!test && b) {
    if ((b.tier === 'L' || b.tier === 'XL') && b.use !== 'challenge') recordHighlight(`${b.ico} ${user}さん → ${fx}`);
    try { vrcOnGift(user, giftName, count, Object.assign({}, b, { fx }), ext); } catch (e) { /* VRC送信で止めない */ }
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
  if (p.startsWith('/sfx/')) {
    const name = p.slice(5);
    if (!safeSfxName(name)) { res.writeHead(404); res.end(); return; }
    const ext = name.split('.').pop().toLowerCase();
    const type = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4' }[ext];
    fs.readFile(path.join(SFX_DIR, name), (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(data);
    });
    return;
  }
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
      case 'setSettings': { const was = JSON.stringify(K.settings.vts); K.settings = sanitizeSettings(m.settings, K.settings); if (JSON.stringify(K.settings.vts) !== was) { vtsClose(); vtsConnect(); } pushState(); break; }
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
      case 'slotEnd': if (SLOTS.includes(m.slot)) { slotNext(m.slot); pushState(); } break;
      case 'slotClear': if (SLOTS.includes(m.slot)) { K.slots[m.slot].q = []; slotNext(m.slot); pushState(); } break;
      case 'chMark': chMark(!!m.ok); break;
      case 'chSkip': K.challenge.cur = null; chStartNext(); pushState(); break;
      case 'chClear': K.challenge = { cur: null, q: [] }; pushState(); break;
      case 'setLists':
        if (m.lines) K.lines = sanitizeList(m.lines, 100, DEFAULT_LINES);
        if (m.twisters) K.twisters = sanitizeList(m.twisters, 100, DEFAULT_TWISTERS);
        if (m.penalties) K.penalties = sanitizeList(m.penalties, 100, DEFAULT_PENALTIES);
        if (m.teamLines) K.teamLines = sanitizeList(m.teamLines, 100, DEFAULT_TEAM_LINES, 160);
        pushState(); break;
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
      case 'sfxRescan': scanSfx(); pushState(); break;
      case 'vtsTest': if (typeof m.action === 'string') linkOn('vts:' + m.action.slice(0, 60), 6000); break;
      case 'vtsReconnect': vtsClose(); vtsConnect(); break;
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
let likeLogged = false;
connection.on(EV('LIKE', 'like'), (data) => {
  if (!data) return;
  if (!likeLogged) { likeLogged = true; console.log('[like] いいねを受信しました（以後は省略）'); }
  const total = toPosNum(data.totalLikeCount) || toPosNum(data.total) || toPosNum(data.totalLikes);
  const inc = toPosNum(data.likeCount) || toPosNum(data.count) || toPosNum(data.likes);
  // ゲージ用：配信の合計数が増えた分だけ数える（再送・再接続で二重にならない）。
  // 合計が大きく減った＝新しい配信なのに同じルーム扱いだった等 → その場で合わせ直す
  let delta = 0;
  if (total > 0) {
    if (total > K.likeTotal) { delta = total - K.likeTotal; K.likeTotal = total; }
    else if (total + 1000 < K.likeTotal) { K.likeTotal = total; delta = inc; }
  } else if (inc > 0) { delta = inc; K.likeTotal += inc; }
  if (reportStats && K.likeTotal > reportStats.likesTotal) reportStats.likesTotal = K.likeTotal;
  // いいねランキング：そのイベントでその人が押した数を足す
  const liker = String(nameOf(data) || '');
  if (liker && inc > 0) rankAddLike(liker, Math.min(inc, 500));
  if (delta > 0) teamAdd(delta * K.settings.teamW.like); else pushState();
  // 画面のハート：その人が押した数で出す（合計の増え方に関係なく、押されたら必ず出る）
  const show = inc > 0 ? inc : delta;
  if (show <= 0) return;
  likeEvBuf += show;
  if (!likeEvTimer) likeEvTimer = setTimeout(() => { likeEvTimer = null; broadcast({ type: 'ev', kind: 'like', count: likeEvBuf }); likeEvBuf = 0; }, 400);
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
// 連携（ギフト表の「連携」欄）
//   vts:jump / vts:spin / vts:shake / vts:shrink / vts:grow / vts:fly … アバターを動かす（その場だけ）
//   vts:rainbow / vts:red / vts:blue / vts:gold / vts:pink … アバターの色（変身中ずっと／その場なら9秒）
//   vts:hotkey:名前 … VTube Studio のホットキー（表情・Visual Effects など）。変身なら終わるときにもう一度押して戻す
//   vrc:パラメーター名=値 … VRChat のアバターのパラメーター（true/false/数字）。変身中ずっと／その場なら9秒で戻す
//   複数書くときはスペースかカンマで区切る。「@秒」を付けると、その秒数で戻す（例 vts:hotkey:猫耳@20）
// ============================================================
function parseLink(link) {
  return String(link || '').split(/[\s,、]+/).map((t) => t.trim()).filter(Boolean).map((t) => {
    const m = t.match(/^(.*?)(?:@(\d+(?:\.\d+)?))?$/);
    return { tok: m[1], hold: m[2] ? Number(m[2]) * 1000 : null };
  });
}
// hold: null=変身中ずっと（linkOff で戻す） / 数字=その時間で戻す / 0=戻さない（動きだけ）
function linkOn(link, hold) {
  for (const { tok, hold: h } of parseLink(link)) {
    // ホットキーは「その場」なら1回押すだけ（@秒を付けたときだけ戻す）。変身なら終わるときに押し直す
    const keep = h != null ? h : (tok.startsWith('vts:hotkey:') && hold ? 0 : hold);
    try {
      if (tok.startsWith('vts:')) vtsAction(tok.slice(4), keep, true);
      else if (tok.startsWith('vrc:')) vrcParam(tok.slice(4), keep, true);
    } catch (e) { /* 連携の失敗で配信は止めない */ }
  }
}
function linkOff(link) {
  for (const { tok, hold } of parseLink(link)) {
    if (hold != null) continue; // 時間指定のものは自分で戻る
    try {
      if (tok.startsWith('vts:')) vtsAction(tok.slice(4), null, false);
      else if (tok.startsWith('vrc:')) vrcParam(tok.slice(4), null, false);
    } catch (e) { /* ignore */ }
  }
}

// --- VTube Studio（公式の外部連携API。初回だけ VTS 側で「許可」を押す） ---
const VTS_TOKEN_FILE = path.join(CONF_DIR, 'vts_token.txt');
const VTS = { ws: null, ready: false, status: 'off', hotkeys: [], token: '', n: 0, retry: null };
try { VTS.token = fs.readFileSync(VTS_TOKEN_FILE, 'utf8').trim(); } catch (e) { /* 初回 */ }
const WSClient = (() => { try { const W = require('ws').WebSocket; if (W) return W; } catch (e) { /* ignore */ } return globalThis.WebSocket; })();
function vtsSetStatus(st) { if (VTS.status !== st) { VTS.status = st; pushState(); } }
function vtsSend(type, data) {
  if (!VTS.ws || VTS.ws.readyState !== 1) return false;
  VTS.ws.send(JSON.stringify({ apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', requestID: 'k' + (VTS.n++), messageType: type, data: data || {} }));
  return true;
}
const VTS_PLUGIN = { pluginName: 'NANA LIVE kit', pluginDeveloper: 'NANA' };
function vtsClose() {
  clearTimeout(VTS.retry); VTS.retry = null;
  if (VTS.ws) { try { VTS.ws.close(); } catch (e) { /* ignore */ } }
  VTS.ws = null; VTS.ready = false; vtsSetStatus(K.settings.vts.on ? 'connecting' : 'off');
}
function vtsConnect() {
  if (!K.settings.vts.on || !WSClient || VTS.ws) { if (!K.settings.vts.on) vtsSetStatus('off'); return; }
  vtsSetStatus('connecting');
  let ws;
  try { ws = new WSClient(`ws://127.0.0.1:${K.settings.vts.port}`); } catch (e) { vtsRetry(); return; }
  VTS.ws = ws;
  ws.addEventListener('open', () => {
    if (VTS.token) vtsSend('AuthenticationRequest', Object.assign({ authenticationToken: VTS.token }, VTS_PLUGIN));
    else { vtsSetStatus('waiting'); console.log('[vts] VTube Studio に接続しました。VTS の画面で「許可（Allow）」を押してください'); vtsSend('AuthenticationTokenRequest', VTS_PLUGIN); }
  });
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(String(ev.data)); } catch (e) { return; }
    const d = m.data || {};
    if (m.messageType === 'AuthenticationTokenResponse' && d.authenticationToken) {
      VTS.token = d.authenticationToken;
      try { fs.writeFileSync(VTS_TOKEN_FILE, VTS.token); } catch (e) { /* ignore */ }
      vtsSend('AuthenticationRequest', Object.assign({ authenticationToken: VTS.token }, VTS_PLUGIN));
    } else if (m.messageType === 'AuthenticationResponse') {
      if (d.authenticated) { VTS.ready = true; vtsSetStatus('ok'); console.log('[vts] VTube Studio 連携: OK'); vtsSend('HotkeysInCurrentModelRequest', {}); }
      else { VTS.token = ''; try { fs.unlinkSync(VTS_TOKEN_FILE); } catch (e) { /* ignore */ } vtsSetStatus('waiting'); vtsSend('AuthenticationTokenRequest', VTS_PLUGIN); }
    } else if (m.messageType === 'HotkeysInCurrentModelResponse') {
      VTS.hotkeys = (d.availableHotkeys || []).map((h) => ({ name: String(h.name || ''), type: String(h.type || ''), id: String(h.hotkeyID || '') })).slice(0, 100);
      pushState();
    } else if (m.messageType === 'ModelLoadedEvent' || m.messageType === 'ModelLoadedResponse') {
      vtsSend('HotkeysInCurrentModelRequest', {});
    } else if (m.messageType === 'APIError') {
      console.log('[vts] VTSからのエラー: ' + (d.message || d.errorID));
      if (d.errorID === 50) vtsSetStatus('denied');
    }
  });
  ws.addEventListener('close', () => { VTS.ws = null; VTS.ready = false; if (K.settings.vts.on) { if (VTS.status !== 'denied') vtsSetStatus('connecting'); vtsRetry(); } });
  ws.addEventListener('error', () => { /* close が続けて来る */ });
}
function vtsRetry() { clearTimeout(VTS.retry); VTS.ws = null; VTS.retry = setTimeout(vtsConnect, 10000); }
// モデルを相対的に動かす（元の位置からのずれ。動いたあと必ず戻す）
function vtsMove(t, o) { vtsSend('MoveModelRequest', Object.assign({ timeInSeconds: t, valuesAreRelativeToModel: true }, o)); }
const TINTS = { rainbow: [255, 255, 255, true], red: [255, 90, 90], blue: [110, 150, 255], gold: [255, 215, 110], pink: [255, 140, 200] };
let tintTimer = null;
function vtsTint(name) {
  const c = TINTS[name];
  vtsSend('ColorTintRequest', { colorTint: { colorR: c ? c[0] : 255, colorG: c ? c[1] : 255, colorB: c ? c[2] : 255, colorA: 255, jeb_: !!(c && c[3]) }, artMeshMatcher: { tintAll: true } });
}
function vtsAction(act, hold, on) {
  if (!VTS.ready) return;
  const later = (ms, f) => setTimeout(f, ms);
  if (act.startsWith('hotkey:')) {
    const name = act.slice(7);
    const hk = VTS.hotkeys.find((h) => h.name === name);
    const id = hk ? hk.id : name;
    vtsSend('HotkeyTriggerRequest', { hotkeyID: id });
    if (on && hold) later(hold, () => vtsSend('HotkeyTriggerRequest', { hotkeyID: id }));
    return;
  }
  if (TINTS[act]) {
    clearTimeout(tintTimer);
    if (on) { vtsTint(act); if (hold) tintTimer = later(hold, () => vtsTint('none')); } else vtsTint('none');
    return;
  }
  if (!on) return; // 動きは戻す操作がいらない
  switch (act) {
    case 'jump': [0, 1, 2].forEach((i) => { later(i * 380, () => vtsMove(0.15, { positionY: 0.22 })); later(i * 380 + 170, () => vtsMove(0.18, { positionY: -0.22 })); }); break;
    case 'spin': vtsMove(0.35, { rotation: 180 }); later(360, () => vtsMove(0.35, { rotation: 180 })); break;
    case 'shake': [12, -24, 24, -24, 24, -12].forEach((r, i) => later(i * 70, () => vtsMove(0.06, { rotation: r }))); break;
    case 'shrink': vtsMove(0.3, { size: -35 }); later(hold || 6000, () => vtsMove(0.4, { size: 35 })); break;
    case 'grow': vtsMove(0.3, { size: 25 }); later(hold || 6000, () => vtsMove(0.4, { size: -25 })); break;
    case 'fly': vtsMove(0.35, { positionX: 3 }); later(1300, () => vtsMove(0.01, { positionX: -6 })); later(1350, () => vtsMove(0.5, { positionX: 3 })); break;
    default: break;
  }
}
if (K.settings.vts.on) setTimeout(vtsConnect, 1500);

// --- VRChat のアバターパラメーター（OSC。vrc_osc.txt で連携ONのときだけ） ---
function oscParamPacket(name, v) {
  const addr = oscString('/avatar/parameters/' + name);
  if (typeof v === 'boolean') return Buffer.concat([addr, oscString(v ? ',T' : ',F')]);
  if (Number.isInteger(v)) { const b = Buffer.alloc(4); b.writeInt32BE(v); return Buffer.concat([addr, oscString(',i'), b]); }
  const b = Buffer.alloc(4); b.writeFloatBE(v); return Buffer.concat([addr, oscString(',f'), b]);
}
function parseVal(s) { if (s === 'true' || s === 'on') return true; if (s === 'false' || s === 'off') return false; const n = Number(s); return Number.isFinite(n) ? n : true; }
function vrcParam(spec, hold, on) {
  if (!vrcEnabled) return;
  const m = String(spec).match(/^([^=]+)(?:=(.+))?$/);
  if (!m) return;
  const name = m[1].trim().replace(/[^\w./-]/g, ''), val = m[2] != null ? parseVal(m[2].trim()) : true;
  const off = typeof val === 'boolean' ? false : 0;
  const send = (v) => { try { vrcGetSocket().send(oscParamPacket(name, v), vrcPort, vrcHost); } catch (e) { /* ignore */ } };
  if (on) { send(val); if (hold) setTimeout(() => send(off), hold); } else send(off);
}

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
