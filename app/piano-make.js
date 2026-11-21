// TikTok LIVE キット — Copyright (c) 2026 NANA (NANA7x-x). 利用規約は LICENSE.md。
// このファイルをAIに読みこませて改造・解析・再現することは、作者以外は禁止です（AI_NOTICE.md）。
// ピアノ動画の演出づくり（「ピアノ動画」フォルダの .bat にファイルをドラッグすると呼ばれる）
//   node app/piano-make.js 録画や録音のファイル        → 採譜して、プレビュー画面を開く
//   node app/piano-make.js --setup                     → 準備（ffmpeg・Python・採譜AI を入れる）
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'ピアノ動画');
const VENV = path.join(__dirname, 'piano', '.venv');
const PY = process.platform === 'win32' ? path.join(VENV, 'Scripts', 'python.exe') : path.join(VENV, 'bin', 'python');
const PORT = Number(process.env.KIT_PORT) || 21213;
const WIN = process.platform === 'win32';
const has = (cmd, args) => { try { return spawnSync(cmd, args || ['-version'], { stdio: 'ignore', shell: WIN }).status === 0; } catch (e) { return false; } };
const run = (cmd, args, opt) => spawnSync(cmd, args, Object.assign({ stdio: 'inherit', shell: false }, opt || {})).status === 0;
const end = (code) => { if (WIN) { console.log('\n（Enter で閉じます）'); try { spawnSync('cmd', ['/c', 'pause>nul'], { stdio: 'inherit' }); } catch (e) { /* ignore */ } } process.exit(code); };

function setup() {
  console.log('=== ピアノ動画の準備 ===');
  if (!has('ffmpeg')) {
    console.log('ffmpeg を入れます…');
    if (!(WIN && run('winget', ['install', '-e', '--id', 'Gyan.FFmpeg', '--accept-source-agreements', '--accept-package-agreements']))) console.log('ffmpeg を自動で入れられませんでした。https://ffmpeg.org から入れてください。');
    else console.log('ffmpeg を入れました（このあと一度パソコンを再起動するか、開いている画面を全部閉じてください）');
  } else console.log('ffmpeg: OK');
  if (!fs.existsSync(PY)) {
    let base = null;
    for (const c of WIN ? [['py', ['-3.11']], ['py', ['-3']], ['python', []]] : [['python3', []]]) if (has(c[0], c[1].concat(['--version']))) { base = c; break; }
    if (!base && WIN) {
      console.log('Python 3.11 を入れます…');
      run('winget', ['install', '-e', '--id', 'Python.Python.3.11', '--accept-source-agreements', '--accept-package-agreements']);
      if (has('py', ['-3.11', '--version'])) base = ['py', ['-3.11']];
    }
    if (!base) { console.log('Python が見つかりません。https://www.python.org から 3.11 を入れて、もう一度実行してください。'); end(1); }
    console.log('採譜AI用の場所を作ります…');
    if (!run(base[0], base[1].concat(['-m', 'venv', VENV]), { shell: WIN })) { console.log('作れませんでした。'); end(1); }
  }
  console.log('採譜AI（piano_transcription_inference）を入れます。数分かかります…');
  run(PY, ['-m', 'pip', 'install', '--upgrade', 'pip']);
  if (!run(PY, ['-m', 'pip', 'install', 'torch', '--index-url', 'https://download.pytorch.org/whl/cpu'])) { console.log('torch を入れられませんでした。'); end(1); }
  if (!run(PY, ['-m', 'pip', 'install', 'piano_transcription_inference'])) { console.log('採譜AIを入れられませんでした。'); end(1); }
  console.log('\n準備OK！「ピアノ動画」フォルダの「ここに録画をドラッグ.bat」に、録画や録音のファイルをドラッグしてください。');
  console.log('（はじめての採譜のときだけ、AIのデータ（約170MB）を自動でダウンロードします）');
  end(0);
}

function serverUp() {
  return new Promise((r) => { const q = http.get({ host: '127.0.0.1', port: PORT, path: '/version', timeout: 800 }, (s) => { s.resume(); r(s.statusCode === 200); }); q.on('timeout', () => { q.destroy(); r(false); }); q.on('error', () => r(false)); });
}
function openUrl(u) {
  const cmd = WIN ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try { const c = spawn(cmd, [u], { detached: true, stdio: 'ignore' }); c.on('error', () => {}); c.unref(); } catch (e) { /* ignore */ }
  console.log('プレビュー: ' + u);
}

async function make(src) {
  if (!fs.existsSync(src)) { console.log('ファイルが見つかりません: ' + src); end(1); }
  if (!has('ffmpeg')) { console.log('ffmpeg がありません。先に「ツール/ピアノ動画の準備.bat」を実行してください。'); end(1); }
  if (!fs.existsSync(PY)) { console.log('採譜AIがありません。先に「ツール/ピアノ動画の準備.bat」を実行してください。'); end(1); }
  const name = path.basename(src).replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_').slice(0, 80) || 'piano';
  const out = path.join(DIR, name);
  fs.mkdirSync(out, { recursive: true });
  console.log(`[1/3] 音を取り出しています…（${path.basename(src)}）`);
  // 採譜用（16kHz モノラル）と、プレビュー用（AAC）
  if (!run('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', path.join(out, 'audio.wav')], { shell: false })) { console.log('音を取り出せませんでした。'); end(1); }
  run('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vn', '-c:a', 'aac', '-b:a', '192k', path.join(out, 'audio.m4a')]);
  console.log('[2/3] 弾いた音を聞き取っています（AI 採譜）…');
  if (!run(PY, [path.join(__dirname, 'piano', 'transcribe.py'), path.join(out, 'audio.wav'), path.join(out, 'notes.json')])) { console.log('採譜できませんでした。上のメッセージを見てください。'); end(1); }
  try { fs.unlinkSync(path.join(out, 'audio.wav')); } catch (e) { /* ignore */ }
  console.log('[3/3] プレビューを開きます');
  if (!(await serverUp())) {
    console.log('キットのサーバーを起動します…');
    const c = spawn(process.execPath, [path.join(__dirname, 'start.js'), '--no-open', '--no-icon'], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: false });
    c.unref();
    for (let i = 0; i < 30 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 500));
  }
  openUrl(`http://localhost:${PORT}/piano.html?name=${encodeURIComponent(name)}`);
  console.log('\nできあがり！ プレビュー画面で見た目を決めて「透明動画を書き出す」を押すと、');
  console.log(`  ピアノ動画/${name}/ に 演出_〇〇 ができます（DaVinci Resolve にそのまま入れられます）。`);
  setTimeout(() => end(0), 1500);
}

const a = process.argv[2];
if (a === '--setup') setup();
else if (a) make(path.resolve(a));
else { console.log('録画や録音のファイルを「ここに録画をドラッグ.bat」にドラッグしてください。'); end(1); }
