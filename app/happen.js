// ハプニングの「画面全体の動き」（サーバーとオーバーレイの両方で使う）
// kf(t) は 画面の中心のずれ x・y（画面の幅・高さに対する割合）、大きさ s、回転 r（度）を返す。
// サーバーは OBS の「NANA ハプニング」シーンの中の配信画面をこのとおりに動かし、
// オーバーレイ（ハプニング奥・手前）は同じ位置に合わせて、まわりの絵を描く。
(function (root) {
  const cl = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const E = (x) => { x = cl(x); return x * x * (3 - 2 * x); };           // なめらか
  const Ein = (x) => { x = cl(x); return x * x * x; };                    // だんだん速く
  const Eout = (x) => { x = cl(x); return 1 - (1 - x) * (1 - x) * (1 - x); }; // だんだんゆっくり
  const Bnc = (x) => { x = cl(x); return 1 - Math.abs(Math.cos(x * Math.PI * 2.5)) * (1 - x) * (1 - x) * (x < 1 ? 1 : 0); }; // ぽよん
  const L = (a, b, k) => a + (b - a) * k;
  const ID = { x: 0, y: 0, s: 1, r: 0 };
  const H = {
    '川に流される': { len: 9, kf(t) {
      if (t < 1.8) { const k = t / 1.8; return { x: Math.sin(t * 38) * 0.008 * k, y: Math.sin(t * 6) * 0.015 * k, s: 1, r: Math.sin(t * 22) * 2.5 * k }; }
      if (t < 5) { const k = Ein((t - 1.8) / 3.2); return { x: k * 1.35, y: Math.sin(t * 4) * 0.03, s: L(1, 0.9, E((t - 1.8) / 0.6)), r: Math.sin(t * 5) * 9 }; }
      if (t < 8) { const k = Eout((t - 5) / 3); return { x: -1.35 * (1 - k), y: Math.sin(t * 4) * 0.03 * (1 - k), s: L(0.9, 1, k), r: Math.sin(t * 5) * 9 * (1 - k) }; }
      return ID; } },
    '海に出ていく': { len: 10, kf(t) {
      const out = E((t - 1) / 2.4), back = E((t - 7.2) / 1.8), k = out * (1 - back);
      return { x: Math.sin(t * 0.8) * 0.06 * k, y: L(0, -0.11, k) + Math.sin(t * 2.2) * 0.008 * k, s: L(1, 0.3, k), r: Math.sin(t * 1.9) * 4 * k }; } },
    '化け物に連れ去られる': { len: 8.5, kf(t) {
      if (t < 2.3) return { x: Math.sin(t * 50) * 0.004 * E(t / 2), y: 0, s: 1, r: Math.sin(t * 31) * 0.8 * E(t / 2) };
      if (t < 2.6) { const k = (t - 2.3) / 0.3; return { x: 0.03 * Math.sin(k * Math.PI), y: -0.02 * Math.sin(k * Math.PI), s: L(1, 0.85, k), r: L(0, 6, k) }; }
      if (t < 3.6) { const k = Ein((t - 2.6) / 1); return { x: -1.5 * k, y: 0.05 * k, s: 0.85, r: L(6, -30, k) }; }
      if (t < 5.6) return { x: -1.5, y: 0.05, s: 0.85, r: -30 };
      if (t < 6.6) { const k = Eout((t - 5.6) / 1); return { x: L(-1.5, 0, k), y: -Math.sin(k * Math.PI) * 0.25, s: L(0.85, 1, k), r: L(-30, 360, k) }; }
      if (t < 7.6) { const k = (t - 6.6) / 1; return { x: 0, y: -Math.abs(Math.sin(k * Math.PI * 2)) * 0.03 * (1 - k), s: 1, r: 360 + Math.sin(k * Math.PI * 3) * 4 * (1 - k) }; }
      return ID; } },
    'UFOにさらわれる': { len: 9.5, kf(t) {
      if (t < 2) return ID;
      if (t < 4.5) { const k = Ein((t - 2) / 2.5); return { x: Math.sin(t * 3) * 0.02 * (1 - k), y: L(0, -0.38, k), s: L(1, 0.02, k), r: 720 * k }; }
      if (t < 6.2) return { x: 0, y: -0.38, s: 0.001, r: 0 };
      if (t < 8) { const k = (t - 6.2) / 1.8; return { x: 0, y: L(-0.38, 0, Bnc(k)), s: L(0.05, 1, Eout(k * 1.4)), r: 0 }; }
      return ID; } },
    '網でつかまる': { len: 10, kf(t) {
      if (t < 1.3) return ID;
      if (t < 2) { const k = E((t - 1.3) / 0.7); return { x: Math.sin(t * 40) * 0.01 * k, y: 0.02 * k, s: L(1, 0.62, k), r: Math.sin(t * 30) * 3 * k }; }
      if (t < 5.2) { const k = Ein((t - 2) / 3.2); return { x: Math.sin(t * 3) * 0.05, y: L(0.02, -1.1, k), s: 0.62, r: Math.sin(t * 3.4) * 10 }; }
      if (t < 6.2) return { x: 0, y: -1.1, s: 0.62, r: 0 };
      if (t < 8.2) { const k = (t - 6.2) / 2; return { x: 0, y: L(-1.1, 0, Bnc(k)), s: L(0.62, 1, E(k * 1.3)), r: Math.sin(k * 20) * 6 * (1 - k) }; }
      return ID; } },
    '瓶づめ': { len: 30, kf(t) {
      const k = Eout(t / 1.4) * (1 - E((t - 28.4) / 1.2));
      const pop = t > 28.2 && t < 29.6 ? Math.sin(((t - 28.2) / 1.4) * Math.PI) * 0.12 : 0;
      return { x: 0, y: L(0, 0.09, k) - pop, s: L(1, 0.5, k), r: Math.sin(t * 1.2) * 3.5 * k }; } },
    '投獄': { len: 30, kf(t) {
      const k = E(t / 0.9) * (1 - E((t - 28.6) / 1.2));
      const rattle = [6, 13, 21].some((a) => t > a && t < a + 0.8) ? Math.sin(t * 60) * 0.006 : 0;
      return { x: rattle, y: 0.02 * k, s: L(1, 0.8, k), r: rattle * 200 }; } },
    'いきなり踊らされる': { len: 12, kf(t) {
      const k = E((t - 0.4) / 0.6) * (1 - E((t - 10.8) / 1)), b = t * 2.2; // 132BPM くらい
      return { x: Math.sin(b * Math.PI / 2) * 0.07 * k, y: -Math.abs(Math.sin(b * Math.PI)) * 0.05 * k, s: 1 - 0.08 * k + Math.abs(Math.cos(b * Math.PI)) * 0.04 * k, r: Math.sin(b * Math.PI) * 13 * k }; } },
    '巨人の料理にされる': { len: 42, kf(t) {
      // 0-2 お皿に乗る / 2.4-4 フォークで持ち上げられる / 4-6.4 口へ / 6.4-7.2 ぱくっ / 7.6- おなかの中から配信 / 39-41 げっぷで出てくる
      if (t < 2.2) { const k = E(t / 2); return { x: 0, y: L(0, 0.17, k), s: L(1, 0.42, k), r: 0 }; }
      if (t < 2.6) return { x: 0, y: 0.17 + Math.sin((t - 2.2) * 40) * 0.004, s: 0.42, r: 0 };
      if (t < 4) { const k = E((t - 2.6) / 1.4); return { x: 0, y: L(0.17, -0.12, k), s: 0.42, r: Math.sin(t * 6) * 4 }; }
      if (t < 6.4) { const k = E((t - 4) / 2.4); return { x: 0, y: L(-0.12, -0.02, k), s: L(0.42, 0.3, k), r: Math.sin(t * 6) * 4 * (1 - k) }; }
      if (t < 7.6) { const k = E((t - 6.4) / 0.8); return { x: 0, y: L(-0.02, 0.05, k), s: L(0.3, 0.001, k), r: 0 }; }
      if (t < 39) { const k = E((t - 7.6) / 1.4), g = [14, 23, 31].some((a) => t > a && t < a + 1.2) ? Math.sin(t * 45) * 0.008 : 0;
        return { x: g + Math.sin(t * 0.9) * 0.015 * k, y: 0.03 + Math.sin(t * 1.3) * 0.012 * k, s: L(0.001, 0.62, k), r: Math.sin(t * 0.8) * 3 * k + g * 150 }; }
      if (t < 40.4) { const k = Eout((t - 39) / 1.4); return { x: 0, y: L(0.03, 0, k) - Math.sin(k * Math.PI) * 0.2, s: L(0.62, 1, k), r: L(0, 360, k) }; }
      return { x: 0, y: 0, s: 1, r: 360 }; } },
  };
  const api = { H, kf(name, t) { const h = H[name]; if (!h || t < 0 || t >= h.len) return ID; const v = h.kf(t); return { x: v.x || 0, y: v.y || 0, s: v.s == null ? 1 : Math.max(0.001, v.s), r: (v.r || 0) % 360 }; }, names: Object.keys(H) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.HAPPEN = api;
})(this);
