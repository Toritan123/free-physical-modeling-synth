const SR = sampleRate;
const TWO_PI = Math.PI * 2;

/* ---------- 基本部品 ---------- */
class DelayLine {
  constructor(maxSamples){
    this.n = Math.max(8, Math.ceil(maxSamples) + 8);
    this.buf = new Float32Array(this.n);
    this.w = 0;
  }
  read(d){ // 分数ディレイ（線形補間）。毎サンプル呼ばれるので剰余演算を避ける
    let rp = this.w - d;
    if (rp < 0) rp += this.n;
    const i0 = rp | 0, fr = rp - i0;
    const i1 = i0 + 1 === this.n ? 0 : i0 + 1;
    return this.buf[i0] + (this.buf[i1] - this.buf[i0]) * fr;
  }
  write(v){ this.buf[this.w] = v; if (++this.w === this.n) this.w = 0; }
}
class OnePole {
  constructor(pole){ this.p = pole; this.y = 0; }
  tick(x){ return this.y = (1 - this.p) * x + this.p * this.y; }
}
class DCBlock {
  constructor(){ this.x1 = 0; this.y1 = 0; }
  tick(x){ const y = x - this.x1 + 0.995 * this.y1; this.x1 = x; this.y1 = y; return y; }
}
function decayGain(seconds){ return Math.pow(0.001, 1 / (Math.max(0.01, seconds) * SR)); }
// 1次ローパス H=(1-p)/(1-p z^-1) の位相遅延（ループ長の補正に使う）
function onePoleDelay(p, w){ return Math.atan2(p * Math.sin(w), 1 - p * Math.cos(w)) / w; }
// 1次オールパス H=(a+z^-1)/(1+a z^-1) の位相遅延
function allpassDelay(a, w){
  const c = Math.cos(w), s = Math.sin(w);
  const nr = a + c, ni = -s, dr = 1 + a * c, di = -a * s;
  const den = dr * dr + di * di;
  return -Math.atan2((ni * dr - nr * di) / den, (nr * dr + ni * di) / den) / w;
}
// 2次共振器（響板・胴の共鳴用）。g は共振周波数でのピーク利得
class Reso {
  constructor(f, q, g){
    const w = TWO_PI * Math.min(f, SR * 0.45) / SR, r = Math.exp(-w / (2 * q));
    this.a1 = 2 * r * Math.cos(w); this.a2 = -r * r;
    // 正規化に 2·sin(w) を入れないと、低い共振ほど利得が膨らむ（100Hzで約35倍）
    this.b = g * (1 - r) * 2 * Math.sin(w);
    this.y1 = 0; this.y2 = 0;
  }
  tick(x){
    const y = this.a1 * this.y1 + this.a2 * this.y2 + this.b * x;
    this.y2 = this.y1; this.y1 = y; return y;
  }
}
// 楽器の胴：直接音＋共鳴モード群
class Body {
  constructor(def){
    this.dry = def.dry;
    this.rs = def.modes.map(m => new Reso(m[0], m[1], m[2]));
  }
  tick(x){
    let y = this.dry * x;
    const rs = this.rs;
    for (let i = 0; i < rs.length; i++) y += rs[i].tick(x);
    return y;
  }
}
// 弦ループの損失設計：基音が T60 秒で減衰し、第8倍音がその R 倍の速さで減衰する
// ような1次ローパスの極 p と利得 g を求める（ピアノで検証済みの方法を共通化）
function loopDesign(f, T60, R){
  const w = TWO_PI * f / SR, c = Math.cos(w);
  const loopG = Math.pow(0.001, 1 / (f * T60));
  const wB = Math.min(Math.PI * 0.95, TWO_PI * Math.min(SR * 0.42, 8 * f) / SR);
  const cB = Math.cos(wB);
  const rho = Math.pow(loopG, Math.max(1.05, R) - 1);
  let lo = 0, hi = 0.995;
  for (let it = 0; it < 40; it++){
    const mid = 0.5 * (lo + hi);
    const ratio = Math.sqrt((1 - 2 * mid * c + mid * mid) / (1 - 2 * mid * cB + mid * mid));
    if (ratio > rho) lo = mid; else hi = mid;
  }
  let p = 0.5 * (lo + hi);
  const G = loopG * loopG, A = 1 - G, B = 1 - G * c;
  const pMax = (B - Math.sqrt(Math.max(0, B * B - A * A))) / A;
  if (p > pMax) p = Math.max(0, pMax * 0.999);
  const lpMag = (1 - p) / Math.sqrt(1 - 2 * p * c + p * p);
  return { p, g: Math.min(0.99999, loopG / lpMag), lpDelay: onePoleDelay(p, w) };
}
// 打撃・撥弦時の接触ノイズ（短い低域ノイズ）
function makeThump(amp, ms, pole){
  const L = Math.max(2, Math.round(ms * SR / 1000));
  const t = new Float32Array(L);
  let lp = 0;
  for (let i = 0; i < L; i++){
    lp = (1 - pole) * (Math.random() * 2 - 1) + pole * lp;
    t[i] = lp * (0.5 - 0.5 * Math.cos(TWO_PI * i / L)) * amp;
  }
  return t;
}
