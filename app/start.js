// ワンクリック起動用（デスクトップの「NANA LIVE」アイコンから呼ばれる）
//   1) すでにサーバーが動いていれば → リモコンを開いて終わり
//   2) 動いていなければ → （初回だけ npm install）→ サーバーを起動 → リモコンを開く
// 使い方: node app/start.js [@ユーザー名]
//   ユーザー名を省略すると 設定/tiktok_user.txt の1行目、それも無ければ @7x_x7x_x7x_x7
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PORT = Number(process.env.KIT_PORT) || 21213;
const NO_OPEN = process.argv.includes('--no-open'); // 自動起動（サインイン時）はブラウザを開かない
const REMOTE = `http://localhost:${PORT}/remote.html`;
const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

function openRemote() {
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const fail = () => console.log('ブラウザを開けませんでした。手で開いてください: ' + REMOTE);
  try {
    const c = spawn(cmd, [REMOTE], { detached: true, stdio: 'ignore' });
    c.on('error', fail);
    c.unref();
  } catch (e) { fail(); }
}

function serverIsUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/version', timeout: 800 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function pickUser() {
  const a = process.argv[2];
  if (a && !a.startsWith('--')) return a;
  try {
    const line = fs.readFileSync(path.join(ROOT, '設定', 'tiktok_user.txt'), 'utf8').split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('#'));
    if (line) return line;
  } catch (e) { /* 無ければ既定値 */ }
  return '@7x_x7x_x7x_x7';
}

(async () => {
  if (await serverIsUp()) {
    console.log('サーバーはもう動いています。リモコンだけ開きます。');
    if (!NO_OPEN) openRemote();
    setTimeout(() => process.exit(0), 800);
    return;
  }
  // 初回だけ: 必要な部品を入れる
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'ws')) || !fs.existsSync(path.join(ROOT, 'node_modules', 'tiktok-live-connector'))) {
    console.log('はじめての起動なので、必要な部品を入れています（1〜2分）…');
    const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install'], { stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) {
      console.log('npm install に失敗しました。インターネット接続を確認して、もう一度アイコンを押してください。');
      setTimeout(() => process.exit(1), 15000);
      return;
    }
  }
  // サーバーをこの画面の中で起動する（この黒い画面がサーバー。閉じると止まる）
  process.argv = [process.argv[0], path.join(__dirname, 'server.js'), pickUser()];
  console.log('サーバーを起動します。この黒い画面は閉じないでください（最小化はOK）。');
  if (!NO_OPEN) setTimeout(openRemote, 1500);
  require('./server.js');
})();
