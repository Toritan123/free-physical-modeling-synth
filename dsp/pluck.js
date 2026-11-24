
/* ---------- 撥弦：パルス波励振 × 2偏波の導波管 ＋ 胴の共鳴 ---------- */
class StringVoice {
  constructor(o){
    const sp = o.spec, f = o.freq, vel = o.vel;
    this.dead = false;
    const T60 = Math.min(sp.tMax || 14, Math.max(0.4, sp.t110 * Math.pow(110 / f, sp.tExp))) * o.decayMul;
    const R = Math.max(1.3, sp.R * (1.5 - o.bright));
    // 指やピックの硬さ・弾く強さ → 励振波形の角の鋭さ
    const fc = Math.min(SR * 0.45, sp.fcMin + (sp.fcMax - sp.fcMin) * o.bright * (0.45 + 0.6 * vel));
    const ps = Math.exp(-TWO_PI * fc / SR);
    this.str = [];
    // 弦は表板に垂直・平行の2方向に振動する。わずかに周波数と減衰が違うため、
    // うなりと「速い減衰→遅い減衰」の二段階の余韻が生まれる
    const pols = [[0, 1, 1], [sp.polDetune, sp.polDecay, sp.polAmp]];
    for (const [dt, ts, amp] of pols){
      const fk = f * (1 + dt);
      const d = loopDesign(fk, T60 * ts, R);
      const D0 = Math.max(2.2, SR / fk - d.lpDelay);
      const Di = Math.max(1, Math.round(D0 - 1));
      const frac = Math.min(1.9, Math.max(0.1, D0 - Di));
      const dl = new DelayLine(Di + 8);
      // 弾かれた弦がブリッジに及ぼす力は、弾いた位置で決まるデューティ比のパルス波になる
      // （位置 1/n で弾くと第n倍音が欠ける）。ノイズ励振と違い実際の撥弦と同じ倍音構成になる
      const tmp = new Float32Array(Di);
      const cw = Math.min(Di - 1, Math.max(1, Math.round(sp.pickPos * Di)));
      const duty = cw / Di;
      for (let i = 0; i < Di; i++)
        tmp[i] = (i < cw ? 1 - duty : -duty) + (Math.random() * 2 - 1) * sp.pickNoise;
      // 角を丸める（循環・往復でゼロ位相）
      let y = 0;
      for (let pass = 0; pass < 2; pass++)
        for (let i = 0; i < Di; i++){ y = (1 - ps) * tmp[i] + ps * y; if (pass) tmp[i] = y; }
      for (let pass = 0; pass < 2; pass++)
        for (let i = Di - 1; i >= 0; i--){ y = (1 - ps) * tmp[i] + ps * y; if (pass) tmp[i] = y; }
      let e = 0; for (let i = 0; i < Di; i++) e += tmp[i] * tmp[i];
      const sc = 0.3 * amp / Math.sqrt(e / Di + 1e-12);
      for (let i = 0; i < Di; i++) dl.buf[i] = tmp[i] * sc;
      dl.w = Di;
      this.str.push({ dl, D: Di, p: d.p, g: d.g, lpy: 0, a: (1 - frac) / (1 + frac), ax: 0, ay: 0 });
    }
    this.body = new Body(sp.body);
    this.dc = new DCBlock();
    this.thump = makeThump(sp.thump * vel, 7, 0.9); this.ti = 0;
    this.dg = 1; this.f0 = f; this.release = sp.release;
    this.gain = sp.gain * (0.15 + 0.85 * vel) * Math.min(1.8, Math.max(1, Math.pow(f / 262, 0.25)));
  }
  noteOff(){ this.dg = Math.pow(0.001, 1 / (this.f0 * this.release)); } // 指で弦を止める（往復あたりの損失）
  tick(){
    const st = this.str, dg = this.dg;
    let s = 0;
    for (let k = 0; k < 2; k++){
      const q = st[k];
      let y = q.dl.read(q.D);
      y = q.lpy = (1 - q.p) * y + q.p * q.lpy;
      y *= q.g;
      const out = q.a * y + q.ax - q.a * q.ay; // 分数遅延（振幅損失の無いオールパス）
      q.ax = y; q.ay = out;
      q.dl.write(out * dg);
      s += out;
    }
    if (this.ti < this.thump.length) s += this.thump[this.ti++];
    return this.body.tick(this.dc.tick(s)) * this.gain;
  }
}
