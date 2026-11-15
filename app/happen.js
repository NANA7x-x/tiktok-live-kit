// ハプニングの「アバターの動き」（サーバーとオーバーレイの両方で使う。画面全体は動かさない）
// kf(t) は アバターの中心のずれ x・y（画面の幅・高さに対する割合）、大きさ s（もとの何倍か）、回転 r（度）を返す。
// サーバーは OBS のアバターのソースをこのとおりに動かし、
// オーバーレイ（ハプニング奥＝アバターのすぐ下・手前＝すぐ上）は同じ位置に合わせて、まわりの絵を描く。
(function (root) {
  const cl = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const E = (x) => { x = cl(x); return x * x * (3 - 2 * x); };           // なめらか
  const Ein = (x) => { x = cl(x); return x * x * x; };                    // だんだん速く
  const Eout = (x) => { x = cl(x); return 1 - (1 - x) * (1 - x) * (1 - x); }; // だんだんゆっくり
  const Bnc = (x) => { x = cl(x); return 1 - Math.abs(Math.cos(x * Math.PI * 2.5)) * (1 - x) * (1 - x) * (x < 1 ? 1 : 0); }; // ぽよん
  const L = (a, b, k) => a + (b - a) * k;
  const ID = { x: 0, y: 0, s: 1, r: 0, fx: 1, fy: 1, z: 0 }; // fx・fy＝横・縦のつぶれ（くるっと回って見える）、z＝持ち上がっている高さ（影の大きさ）
  // len＝長さ（秒）、out＝しめくくり（元にもどっていく）が始まる時刻。つぎのハプニングが待っているときは、ここまで早送りする
  const H = {
    '川に流される': { len: 9, out: 5, kf(t) {
      if (t < 1.8) { const k = t / 1.8; return { x: Math.sin(t * 38) * 0.008 * k, y: Math.sin(t * 6) * 0.015 * k, s: 1, r: Math.sin(t * 22) * 2.5 * k }; }
      if (t < 5) { const k = Ein((t - 1.8) / 3.2); return { x: k * 1.35, y: Math.sin(t * 4) * 0.03, s: L(1, 0.9, E((t - 1.8) / 0.6)), r: Math.sin(t * 5) * 9, fx: 1 - 0.22 * Math.abs(Math.sin(t * 2.6)), z: 0.3 }; }
      if (t < 8) { const k = Eout((t - 5) / 3); return { x: -1.35 * (1 - k), y: Math.sin(t * 4) * 0.03 * (1 - k), s: L(0.9, 1, k), r: Math.sin(t * 5) * 9 * (1 - k), fx: 1 - 0.22 * Math.abs(Math.sin(t * 2.6)) * (1 - k), z: 0.3 * (1 - k) }; }
      return ID; } },
    '海に出ていく': { len: 10, out: 7.2, kf(t) {
      const out = E((t - 1) / 2.4), back = E((t - 7.2) / 1.8), k = out * (1 - back);
      return { x: Math.sin(t * 0.8) * 0.06 * k, y: L(0, -0.11, k) + Math.sin(t * 2.2) * 0.008 * k, s: L(1, 0.3, k), r: Math.sin(t * 1.9) * 4 * k, fy: 1 - 0.18 * k * (0.6 + 0.4 * Math.sin(t * 2.2)), z: 0.15 * k }; } },
    '化け物に連れ去られる': { len: 10.5, out: 5.8, kf(t) {
      // 0-2.3 気配 / 2.3 つかまれる / 2.6-3.4 口の中へ / 3.4-5.8 もぐもぐ / 5.8 ぺっ（よだれまみれで飛んでくる）/ 6.8- ぷるぷる
      if (t < 2.3) return { x: Math.sin(t * 50) * 0.004 * E(t / 2), y: 0, s: 1, r: Math.sin(t * 31) * 1.5 * E(t / 2) };
      if (t < 2.6) { const k = (t - 2.3) / 0.3; return { x: -0.03 * k, y: -0.01 * Math.sin(k * Math.PI), s: L(1, 0.9, k), r: L(0, 8, k), fx: L(1, 0.8, k) }; }
      if (t < 3.4) { const k = Ein((t - 2.6) / 0.8); return { x: L(-0.03, -0.15, k), y: L(0, -0.1, k), s: L(0.9, 0.3, k), r: L(8, -25, k), fx: 0.8, z: 0.4 * k }; }
      if (t < 5.8) { const c = Math.abs(Math.sin((t - 3.4) * Math.PI * 1.7)); return { x: -0.15 + Math.sin(t * 9) * 0.006, y: -0.1 + c * 0.012, s: 0.3 * (1 - 0.15 * c), r: Math.sin(t * 7) * 20, fy: 1 - 0.35 * c, z: 0.4 }; }
      if (t < 6.8) { const k = Eout((t - 5.8) / 1); return { x: L(-0.15, 0, k), y: L(-0.1, 0, k) - Math.sin(k * Math.PI) * 0.18, s: L(0.3, 1, k), r: 0, fx: Math.max(0.06, Math.abs(Math.cos(k * Math.PI * 3))), z: Math.sin(k * Math.PI) }; }
      if (t < 9.5) { const k = (t - 6.8) / 2.7; return { x: Math.sin(t * 40) * 0.006 * Math.max(0, 1 - k * 1.5), y: -Math.abs(Math.sin(k * Math.PI * 3)) * 0.02 * (1 - k), s: 1, r: Math.sin(t * 30) * 3 * Math.max(0, 1 - k * 1.5), fy: 1 - Math.abs(Math.sin(k * Math.PI * 3)) * 0.06 * (1 - k) }; }
      return ID; } },
    'UFOにさらわれる': { len: 9.5, out: 6.1, kf(t) {
      if (t < 2) return ID;
      if (t < 4.5) { const k = Ein((t - 2) / 2.5); return { x: 0, y: L(0, -0.38, k), s: L(1, 0.02, k), r: 90 * k, fx: Math.max(0.06, Math.abs(Math.cos(k * Math.PI * 5))), z: k }; }
      if (t < 6.2) return { x: 0, y: -0.38, s: 0.001, r: 0 };
      if (t < 8) { const k = (t - 6.2) / 1.8; return { x: 0, y: L(-0.38, 0, Bnc(k)), s: L(0.05, 1, Eout(k * 1.4)), r: 0, z: 1 - Bnc(k) }; }
      return ID; } },
    '増殖': { len: 10, out: 6.6, kf(t) {
      // 本体：ちょっと小さくなって、みんなの真ん中でぴょこぴょこ。最後にみんなが集まって元にもどる
      const k = E((t - 0.4) / 0.4) * (1 - E((t - 7.6) / 1)), b = t * 2.2;
      return { x: 0, y: 0.04 * k - Math.abs(Math.sin(b * Math.PI)) * 0.015 * k, s: L(1, 0.55, k), r: Math.sin(b * Math.PI) * 6 * k };
    },
    // 分身：ぽんっと出て、まわりに散らばって、いっしょに揺れて、最後に本体へもどる
    clones(t) {
      const SL = [[-0.3, -0.2], [0.3, -0.2], [-0.33, 0.12], [0.33, 0.12], [0, -0.3], [-0.17, 0.3], [0.17, 0.3], [-0.38, -0.05], [0.38, -0.05], [-0.15, -0.08], [0.15, -0.08]];
      return SL.map(([sx, sy], i) => {
        const t0 = 0.6 + i * 0.32, out = E((t - t0) / 0.45), back = Ein((t - 6.6 - i * 0.04) / 0.9);
        if (t < t0 || back >= 1) return { x: 0, y: 0, s: 0.001, r: 0, fx: 1, fy: 1, z: 0 };
        const b = t * 2.2 + i * 0.37, m = out * (1 - back), sc = 0.27 + (i % 3) * 0.04;
        return { x: sx * m, y: 0.04 + (sy - 0.04) * m - Math.abs(Math.sin(b * Math.PI)) * 0.015, s: Math.max(0.001, L(0.3, sc, out) * (1 - back * 0.9)), r: Math.sin(b * Math.PI) * 10, fx: i % 2 ? -1 : 1, fy: 1, z: 0 };
      });
    } },
    '瓶づめ': { len: 30, out: 28.2, kf(t) {
      const k = Eout(t / 1.4) * (1 - E((t - 28.4) / 1.2));
      const pop = t > 28.2 && t < 29.6 ? Math.sin(((t - 28.2) / 1.4) * Math.PI) * 0.12 : 0;
      return { x: 0, y: L(0, 0.09, k) - pop, s: L(1, 0.5, k), r: Math.sin(t * 1.2) * 3.5 * k, fx: 1 - 0.1 * k * Math.abs(Math.sin(t * 0.6)), z: pop * 4 }; } },
    '投獄': { len: 30, out: 28.6, kf(t) {
      const k = E(t / 0.9) * (1 - E((t - 28.6) / 1.2));
      const rattle = [6, 13, 21].some((a) => t > a && t < a + 0.8) ? Math.sin(t * 60) * 0.006 : 0;
      return { x: rattle, y: 0.02 * k, s: L(1, 0.8, k), r: rattle * 200 }; } },
    'いきなり踊らされる': { len: 12, out: 10.8, kf(t) {
      // 画面は動かさず、アバターをズームアップして踊らせる
      const k = E((t - 0.4) / 0.6) * (1 - E((t - 10.8) / 1)), b = t * 2.2; // 132BPM くらい
      return { x: Math.sin(b * Math.PI / 2) * 0.05 * k, y: -0.05 * k - Math.abs(Math.sin(b * Math.PI)) * 0.035 * k, s: 1 + 0.32 * k + Math.abs(Math.cos(b * Math.PI)) * 0.04 * k, r: Math.sin(b * Math.PI) * 11 * k, fx: 1 - 0.3 * k * Math.abs(Math.sin(b * Math.PI / 2)), fy: 1 - 0.05 * k * Math.abs(Math.cos(b * Math.PI)), z: 0.3 * k * Math.abs(Math.sin(b * Math.PI)) }; } },
    '巨人の料理にされる': { len: 45, out: 42, kf(t) {
      // 0-1.2 フライパンへ / 1.2-6 じゅうじゅう焼かれる（3回ひっくり返される）/ 6.8 塩 / 8-10.2 お皿に盛られてクロッシュ → じゃーん（提供）
      // 12-13.4 フォークで刺されて持ち上げられる / 13.4-15.8 口へ / 15.8-17 ぱくっ / 17-42 おなかの中から配信 / 42-43.4 げっぷで出てくる
      if (t < 1.2) { const k = E(t / 1.2); return { x: 0, y: L(0, 0.12, k), s: L(1, 0.45, k), r: 0, z: Math.sin(k * Math.PI) * 0.5 }; }
      if (t < 6.2) {
        for (const a of [2, 3.6, 5]) if (t >= a && t < a + 0.7) { const p = (t - a) / 0.7; return { x: Math.sin(p * Math.PI) * 0.02, y: 0.12 - Math.sin(p * Math.PI) * 0.22, s: 0.45, r: Math.sin(p * Math.PI) * 18, fy: Math.max(0.06, Math.abs(Math.cos(p * Math.PI * 2))), z: Math.sin(p * Math.PI) }; }
        return { x: Math.sin(t * 23) * 0.002, y: 0.12 + Math.abs(Math.sin(t * 19)) * 0.002, s: 0.45, r: Math.sin(t * 13) * 1.5, fy: 1 - Math.abs(Math.sin(t * 19)) * 0.03 };
      }
      if (t < 12) { const b = t > 10 ? Math.sin((t - 10) * Math.PI) * 0.01 * Math.max(0, 1 - (t - 10) / 2) : 0; return { x: 0, y: 0.12 - b, s: 0.45, r: 0 }; }
      if (t < 12.4) return { x: 0, y: 0.12 + Math.sin((t - 12) * 40) * 0.004, s: 0.45, r: 0 };
      if (t < 13.4) { const k = E((t - 12.4) / 1); return { x: 0, y: L(0.12, -0.12, k), s: 0.45, r: Math.sin(t * 6) * 4, fx: 1 - 0.25 * Math.abs(Math.sin(t * 3)), z: k }; }
      if (t < 15.8) { const k = E((t - 13.4) / 2.4); return { x: 0, y: L(-0.12, -0.02, k), s: L(0.45, 0.3, k), r: Math.sin(t * 6) * 4 * (1 - k), z: 1 - k }; }
      if (t < 17) { const k = E((t - 15.8) / 0.8); return { x: 0, y: L(-0.02, 0.05, k), s: L(0.3, 0.001, k), r: 0 }; }
      if (t < 42) { const k = E((t - 17) / 1.4), g = [24, 31, 37].some((a) => t > a && t < a + 1.2) ? Math.sin(t * 45) * 0.006 : 0;
        // おなかの中：アバターをズームアップして、ふわふわ浮かせる
        return { x: g + Math.sin(t * 0.9) * 0.012 * k, y: -0.03 * k + Math.sin(t * 1.3) * 0.012 * k, s: L(0.001, 1.15, k), r: Math.sin(t * 0.8) * 4 * k + g * 150, fy: 1 - 0.04 * k * Math.abs(Math.sin(t * 1.3)) }; }
      if (t < 43.4) { const k = Eout((t - 42) / 1.4); return { x: 0, y: L(-0.03, 0, k) - Math.sin(k * Math.PI) * 0.2, s: L(1.15, 1, k), r: 0, fx: Math.max(0.06, Math.abs(Math.cos(k * Math.PI * 2))), z: Math.sin(k * Math.PI) }; }
      return ID; } },
  };
  const api = { H, clones(name, t) { const h = H[name]; return h && h.clones && t >= 0 && t < h.len ? h.clones(t) : null; }, kf(name, t) { const h = H[name]; if (!h || t < 0 || t >= h.len) return ID; const v = h.kf(t); return { x: v.x || 0, y: v.y || 0, s: v.s == null ? 1 : Math.max(0.001, v.s), r: (v.r || 0) % 360, fx: v.fx == null ? 1 : Math.max(0.03, v.fx), fy: v.fy == null ? 1 : Math.max(0.03, v.fy), z: Math.max(0, Math.min(1, v.z || 0)) }; }, names: Object.keys(H) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.HAPPEN = api;
})(this);
