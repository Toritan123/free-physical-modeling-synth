/* ---------- モード合成：減衰共振器バンク（棒・板・膜・鐘・音叉） ---------- */
class ModalVoice {
  constructor(o){
    const sp = o.spec, vel = o.vel;
    this.dead = false; this.env = 1; this.relG = 1;
    this.ring = !!sp.ring;
    this.release = sp.release || 0.25;
    this.trem = sp.trem || 0; this.ph = 0;
    // 太鼓は鍵盤の半分の割合で音高が変わる（低い鍵でも可聴域の胴鳴りになる）
    const f0 = sp.drumMap ? sp.drumMap * Math.sqrt(o.freq / 261.63) : o.freq * (sp.freqScale || 1);
    this.choke = 0;
    // マレットの硬さ。強く叩くほどフェルトが潰れて硬くなり、高次モードまで励振される
    const fc = (400 + o.bright * o.bright * 10000) * (sp.velBright ? 0.35 + 0.85 * vel : 1) * Math.max(1, Math.pow(f0 / 262, 0.7));
    // 小さい（高い）音板ほど内部損失の割合が大きく、早く減衰する
    const tScale = o.decayMul * Math.pow(262 / (sp.drumMap ? 262 : o.freq), sp.decayExp || 0);
    this.modes = [];
    const add = (f, T, amp, flat) => {   // T は振幅が 1/e になる時定数（-60dB までは約 6.9 倍）
      if (f < 20 || f > SR * 0.45) return;
      const r = Math.exp(-1 / (Math.max(0.003, T) * SR)), w = TWO_PI * f / SR;
      const bw = flat ? 1 : 1 / (1 + Math.pow(f / fc, 2));
      this.modes.push({ r, w, a1: 2 * r * Math.cos(w), a2: -r * r, b: amp * bw * Math.sin(w), y1: 0, y2: 0 });
    };
    for (let i = 0; i < sp.ratios.length; i++){
      const f = f0 * sp.ratios[i], T = sp.decays[i] * tScale;
      add(f, T, sp.amps[i]);
      // 鐘は完全な回転対称ではないので、各モードがわずかに周波数の違う対に分かれ、
      // それが鐘特有のゆっくりしたうなりになる
      if (sp.doublet) add(f * (1 + sp.doublet * (0.5 + Math.random())), T * 0.9, sp.amps[i] * 0.7);
    }
    // 共鳴管：基音に同調した管が鳴りを増幅するぶん、エネルギーを早く吸い出す
    if (sp.tube) add(f0, sp.tube[0] * tScale, sp.tube[1]);
    // シンバル・ハイハット類：薄い金属板は非調和なモードが極めて密に並ぶ。
    // 楽器ごとに固定の乱数列でモードを並べ、毎回同じ楽器の音になるようにする
    if (sp.metal){
      const mt = sp.metal; let seed = mt.seed || 7;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      for (let k = 0; k < mt.n; k++){
        const f = mt.lo * Math.pow(mt.hi / mt.lo, rnd());
        const T = mt.T * (0.6 + 0.8 * rnd()) * Math.pow(mt.lo / f, mt.tExp === undefined ? 0.3 : mt.tExp);
        add(f, T * o.decayMul, mt.amp * (0.5 + rnd()) * Math.pow(f / mt.lo, -0.35), true);
      }
    }
    // ノイズ成分：スネアの響き線、ハイハットの擦れ、シェイカーの粒、拍手など
    this.nz = null;
    if (sp.noise){
      const nzs = sp.noise;
      this.nz = { amp: nzs.amp * vel, k: Math.exp(-1 / (nzs.T * o.decayMul * SR)), e: 0,
        hp: Math.exp(-TWO_PI * nzs.hp / SR), lp: Math.exp(-TWO_PI * Math.min(SR * 0.45, nzs.lp) / SR),
        h1: 0, l1: 0, t: 0, bursts: (nzs.bursts || [0]).map(ms => Math.round(ms * SR / 1000)), bi: 0 };
    }
    // 励振パルス（接触の力積）。強打ほど接触時間が短い
    // 小さく硬い音板ほどマレットは早く跳ね返る。接触時間が音板の周期より長いと
    // その音板をほとんど励振できない（高音が鳴らなくなる）ので、音高に追従させる
    // （シンバル類のように固有の音高を持たない音は対象外）
    const ms = sp.excMs * (sp.velBright ? 1.45 - 0.8 * vel : 1) * (sp.ratios.length ? Math.min(1.6, Math.max(0.12, Math.pow(262 / f0, 0.6))) : 1);
    const L = Math.max(2, Math.round(ms * SR / 1000));
    this.exc = new Float32Array(L);
    for (let i = 0; i < L; i++){
      const win = 0.5 - 0.5 * Math.cos(TWO_PI * i / L);
      this.exc[i] = win * (2 / L) * (sp.noiseExc ? 1 + 1.5 * (Math.random() * 2 - 1) : 1);
    }
    this.i = 0;
    this.thump = makeThump((sp.knock || 0) * vel, sp.knockMs || 5, 0.8); this.ti = 0;
    // 膜の張力変調：強く叩くと膜が伸びて張力が上がり、打撃直後だけピッチが高くなる
    this.glide = sp.glide ? sp.glide[0] * vel : 0;
    this.glideK = sp.glide ? Math.exp(-16 / (sp.glide[1] * SR)) : 0;
    this.gc = 0;
    // 電磁ピックアップ（エレピ）：振動体との距離で磁束が非線形に変わる
    this.pu = sp.pickup || null;
    if (this.pu){ this.puIn = vel * this.pu.drive; this.puOff = Math.tanh(this.pu.off); this.puPrev = 0; }
    this.gain = sp.gain * (this.pu ? 0.35 + 0.65 * vel : vel);
  }
  noteOff(){ if (!this.ring) this.relG = decayGain(this.release); }
  tick(){
    const x = this.i < this.exc.length ? this.exc[this.i++] : 0;
    const ms = this.modes;
    if (this.glide > 1e-4 && (this.gc++ & 15) === 0){
      const k = 1 + this.glide;
      for (let j = 0; j < ms.length; j++) ms[j].a1 = 2 * ms[j].r * Math.cos(ms[j].w * k);
      this.glide *= this.glideK;
    }
    let s = 0;
    for (let k = 0; k < ms.length; k++){
      const m = ms[k];
      const y = m.a1 * m.y1 + m.a2 * m.y2 + m.b * x;
      m.y2 = m.y1; m.y1 = y;
      s += y;
    }
    if (this.pu){
      const y = Math.tanh(s * this.puIn + this.pu.off) - this.puOff;
      s = y - 0.6 * this.puPrev; this.puPrev = y; // コイルは磁束の時間変化を拾う
    }
    if (this.trem){ this.ph += TWO_PI * this.trem / SR; s *= 1 + 0.3 * Math.sin(this.ph); }
    if (this.ti < this.thump.length) s += this.thump[this.ti++];
    const nz = this.nz;
    if (nz){
      if (nz.bi < nz.bursts.length && nz.t === nz.bursts[nz.bi]){ nz.e += 1; nz.bi++; }
      nz.t++;
      const w = Math.random() * 2 - 1;
      nz.h1 = nz.hp * nz.h1 + (1 - nz.hp) * w;           // 低域を除く
      nz.l1 = nz.lp * nz.l1 + (1 - nz.lp) * (w - nz.h1);  // 高域を丸める
      s += nz.l1 * nz.e * nz.amp;
      nz.e *= nz.k;
    }
    this.env *= this.relG;
    if (this.env < 1e-4) this.dead = true;
    return s * this.gain * this.env;
  }
}

