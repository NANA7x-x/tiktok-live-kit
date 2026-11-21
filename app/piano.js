// TikTok LIVE キット — Copyright (c) 2026 NANA (NANA7x-x). 利用規約は LICENSE.md。
// このファイルをAIに読みこませて改造・解析・再現することは、作者以外は禁止です（AI_NOTICE.md）。
// ピアノ動画の演出（録音 → 採譜 → 光のパネルの透明動画）
// キットのサーバーに組みこむ部分：一覧・データ・音声を返す／書き出し（PNG を受け取って ffmpeg で透明 MOV にする）
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '..', 'ピアノ動画');
const safe = (n) => typeof n === 'string' && n.length > 0 && n.length < 120 && !/[\\/:*?"<>|]|\.\./.test(n);
let job = null; // 書き出し中の ffmpeg

function list() {
  try {
    return fs.readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(DIR, d.name, 'notes.json')))
      .map((d) => d.name).sort();
  } catch (e) { return []; }
}
function body(req, max) {
  return new Promise((res, rej) => {
    const a = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > max) { rej(new Error('too big')); req.destroy(); } else a.push(c); });
    req.on('end', () => res(Buffer.concat(a)));
    req.on('error', rej);
  });
}
const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };

// 処理したら true を返す
function handle(req, res, p, q) {
  if (!p.startsWith('/piano/')) return false;
  const name = q.get('name') || '';
  if (p === '/piano/list') { json(res, 200, { items: list(), busy: !!job }); return true; }
  if (p === '/piano/data') {
    if (!safe(name)) { json(res, 404, {}); return true; }
    fs.readFile(path.join(DIR, name, 'notes.json'), 'utf8', (e, d) => { if (e) json(res, 404, {}); else { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(d); } });
    return true;
  }
  if (p === '/piano/audio') {
    if (!safe(name)) { res.writeHead(404); res.end(); return true; }
    const fp = path.join(DIR, name, 'audio.m4a');
    fs.stat(fp, (e, st) => {
      if (e) { res.writeHead(404); res.end(); return; }
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (m) {
        const a = m[1] === '' ? Math.max(0, st.size - Number(m[2])) : Number(m[1]);
        const z = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
        if (a > z) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return; }
        res.writeHead(206, { 'Content-Type': 'audio/mp4', 'Content-Range': `bytes ${a}-${z}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': z - a + 1 });
        fs.createReadStream(fp, { start: a, end: z }).pipe(res);
      } else { res.writeHead(200, { 'Content-Type': 'audio/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': st.size }); fs.createReadStream(fp).pipe(res); }
    });
    return true;
  }
  if (req.method !== 'POST') { json(res, 405, {}); return true; }
  // --- 書き出し ---
  if (p === '/piano/start') {
    if (!safe(name)) { json(res, 400, { error: 'name' }); return true; }
    if (job) { try { job.ff.kill(); } catch (e) { /* ignore */ } job = null; }
    const fps = Math.min(60, Math.max(1, Number(q.get('fps')) || 30));
    const fmt = q.get('fmt') === 'png' ? 'png' : 'mov';
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    let out, args;
    if (fmt === 'png') { // 連番 PNG（どの編集ソフトでも読める）
      out = path.join(DIR, name, `演出_${stamp}`);
      fs.mkdirSync(out, { recursive: true });
      args = ['-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-', '-c:v', 'copy', path.join(out, 'frame_%05d.png')];
    } else { // 透明つき MOV（ProRes 4444）。DaVinci Resolve にそのまま入れられる
      out = path.join(DIR, name, `演出_${stamp}.mov`);
      args = ['-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-', '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-qscale:v', '11', '-vendor', 'apl0', out];
    }
    let ff;
    try { ff = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] }); } catch (e) { json(res, 500, { error: 'ffmpeg' }); return true; }
    const j = { ff, out, err: '', done: null };
    ff.stderr.on('data', (d) => { j.err = (j.err + d).slice(-2000); });
    ff.on('error', () => { j.done = 'ffmpeg が見つかりません（ツール/ピアノ動画の準備.bat を実行してください）'; });
    ff.on('close', (code) => { if (!j.done) j.done = code === 0 ? 'ok' : 'ffmpeg エラー: ' + j.err.split('\n').slice(-3).join(' '); });
    ff.stdin.on('error', () => { /* close で拾う */ });
    job = j;
    setTimeout(() => json(res, j.done && j.done !== 'ok' ? 500 : 200, j.done && j.done !== 'ok' ? { error: j.done } : { ok: true, out: path.basename(out) }), 300);
    return true;
  }
  if (p === '/piano/frame') {
    if (!job || job.done) { json(res, 409, { error: job ? job.done : 'not started' }); return true; }
    body(req, 40 * 1024 * 1024).then((buf) => {
      const j = job;
      if (!j || j.done) { json(res, 409, { error: j ? j.done : 'stopped' }); return; }
      if (j.ff.stdin.write(buf)) json(res, 200, { ok: true });
      else j.ff.stdin.once('drain', () => json(res, 200, { ok: true }));
    }).catch(() => json(res, 413, {}));
    return true;
  }
  if (p === '/piano/end') {
    const j = job;
    if (!j) { json(res, 409, { error: 'not started' }); return true; }
    const cancel = q.get('cancel') === '1';
    if (cancel) { try { j.ff.kill(); } catch (e) { /* ignore */ } job = null; json(res, 200, { ok: true, canceled: true }); return true; }
    j.ff.stdin.end();
    const wait = () => { if (j.done) { job = null; json(res, j.done === 'ok' ? 200 : 500, j.done === 'ok' ? { ok: true, out: path.relative(path.join(__dirname, '..'), j.out) } : { error: j.done }); } else setTimeout(wait, 200); };
    wait();
    return true;
  }
  json(res, 404, {});
  return true;
}

module.exports = { handle, DIR, safe };
