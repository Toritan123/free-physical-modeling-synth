/* ---------- ドラムセット（GM ドラム用）：膜・金属板・響き線・打撃音を分けて扱う ----------
 * 実際のドラムセットの録音（MuldjordKit：Tama Superstar、オーバーヘッドと近接マイク、弱・中・強打）と
 * スペクトル・減衰・ピッチの時間変化を比べて決めた。各部の考え方：
 *  - 膜（太鼓の皮）：減衰共振器のモード群。強く叩くと皮が伸びて張力が上がり、打撃直後だけ音程が高い。
 *    録音のタムでは強打で約 +50%、弱打で約 +15% 高く始まり、速い成分（数十 ms）と遅い成分（百数十 ms）で戻る
 *  - 打撃音：スティックやビーターが当たった瞬間の広帯域の音（タムやバスドラムの「アタック」）
 *  - 響き線（スネア）：裏の皮に触れる金属線が鳴らす帯域ノイズ（録音では 0.3〜6 kHz が主体）
 *  - 金属板（シンバル・ハイハット）：非調和なモードが密に並ぶ。叩いた瞬間は低めのモードが鳴り、
 *    モード間の非線形な結合でエネルギーが数十 ms かけて高いモードへ流れ込む（録音でも打撃直後は
 *    0.5 kHz 付近が主で、その後 4〜10 kHz が最も強くなる）。これを、金属板のモードを打撃後に
 *    立ち上がるノイズで駆動することで表す。強く叩くほど流れ込みが強く、高い所まで届く */
class KitVoice {
  constructor(o){
    const sp = o.spec, vel = o.vel, dm = o.decayMul;
    this.dead = false; this.env = 1; this.relG = 1;
    this.ring = sp.ring !== false;
    this.release = sp.release || 0.25;
    const f0 = sp.drumMap ? sp.drumMap * Math.sqrt(o.freq / 261.63) : o.freq;
    const bright = o.bright === undefined ? 0.5 : o.bright;
    const mk = (f, T, amp) => {   // T は振幅が 1/e になる時定数
      const r = Math.exp(-1 / (Math.max(0.002, T) * SR)), w = TWO_PI * f / SR;
      return { r, w, a1: 2 * r * Math.cos(w), a2: -r * r, b: amp * Math.sin(w), y1: 0, y2: 0 };
    };
    // ----- 膜 -----
    this.mm = [];
    const mb = sp.membrane;
    this.g1 = this.g2 = 0; this.k1 = this.k2 = 0;
    this.mExc = new Float32Array(0);
    if (mb){
      // 皮に触れている時間が短いほど（強打・明るい設定ほど）高いモードまで励振される
      const fc = mb.fc * (0.35 + 0.65 * vel) * (0.5 + bright);
      // 弱く叩いた皮は長く鳴る（録音のタムで、-20dB までの時間が弱打は強打の約2倍）
      const tv = 1 + (mb.velDecay || 0) * (1 - vel);
      for (let i = 0; i < mb.ratios.length; i++){
        const f = f0 * mb.ratios[i];
        if (f < 20 || f > SR * 0.45) continue;
        this.mm.push(mk(f, mb.decays[i] * tv * dm, mb.amps[i] / (1 + Math.pow(f / fc, 2))));
      }
      const L = Math.max(2, Math.round(mb.excMs * (1.3 - 0.5 * vel) * SR / 1000));
      this.mExc = new Float32Array(L);
      for (let i = 0; i < L; i++) this.mExc[i] = (0.5 - 0.5 * Math.cos(TWO_PI * (i + 0.5) / L)) * (2 / L);
      // 張力変調によるピッチの上ずり：[速い成分の深さ, 時定数(s), 遅い成分の深さ, 時定数(s)]
      if (mb.glide){
        const gl = mb.glide, gv = Math.pow(vel, mb.glideExp === undefined ? 1.1 : mb.glideExp);
        this.g1 = gl[0] * gv; this.g2 = gl[2] * gv;
        this.k1 = Math.exp(-16 / (gl[1] * SR)); this.k2 = Math.exp(-16 / (gl[3] * SR));
      }
    }
    this.gc = 0;
    // ----- 金属板 -----
    this.mt = [];
    this.pExc = new Float32Array(0);
    this.bloom = null;
    const mt = sp.metal;
    if (mt){
      // 強く叩くほど高いモードへ流れたエネルギーが早く失われ、余韻が短い（録音のクラッシュで -20dB まで 0.67〜1.35 秒）
      const tv = (1 + (mt.velDecay || 0) * (1 - vel)) * dm;
      let seed = mt.seed || 7;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      for (let k = 0; k < mt.n; k++){
        const f = mt.lo * Math.pow(mt.hi / mt.lo, rnd());
        const T = mt.T * (0.6 + 0.8 * rnd()) * Math.pow(mt.lo / f, mt.tExp === undefined ? 0.3 : mt.tExp);
        const a = mt.amp * (0.5 + rnd()) * Math.pow(f / mt.lo, mt.slope === undefined ? -0.35 : mt.slope);
        if (f < SR * 0.45) this.mt.push(mk(f, T * tv, a));
      }
      // 低い固有の鳴り（ハイハットの 230〜320 Hz など）：[周波数 Hz, 時定数 s, 強さ]
      if (mt.tones) for (const t of mt.tones) this.mt.push(mk(t[0], t[1] * tv, t[2]));
      // スティックの先端が当たる瞬間の励振（ごく短いパルス）
      const L = Math.max(2, Math.round((mt.pingMs || 0.1) * (1.3 - 0.5 * vel) * SR / 1000));
      const pa = mt.ping === undefined ? 1 : mt.ping;
      this.pExc = new Float32Array(L);
      for (let i = 0; i < L; i++) this.pExc[i] = (0.5 - 0.5 * Math.cos(TWO_PI * (i + 0.5) / L)) * (2 / L) * pa;
      const bl = mt.bloom;   // [強さ, 立ち上がり ms, 時定数 s, 弱打の帯域 Hz, 強打の帯域 Hz, 強さの指数]
      if (bl){
        const fcB = Math.min(SR * 0.45, bl[3] * Math.pow(bl[4] / bl[3], vel));
        this.bloom = { amp: bl[0] * Math.pow(vel, bl[5] === undefined ? 1 : bl[5]), up: Math.exp(-1 / (bl[1] * SR / 1000)),
          dn: Math.exp(-1 / (bl[2] * dm * SR)), a: 1, d: 1, lp: Math.exp(-TWO_PI * fcB / SR), y: 0 };
      }
    }
    this.ei = 0;
    // ----- 打撃音（スティック・ビーターの当たり）：強打ほど大きく、硬い（高域まで出る） -----
    this.click = null;
    const ck = sp.click;
    if (ck){
      const amp = ck.amp * Math.pow(vel, ck.velExp === undefined ? 1.5 : ck.velExp);
      const lpHz = Math.min(SR * 0.45, ck.lp * (0.45 + 0.55 * vel) * (0.6 + 0.8 * bright));
      const tau = ck.ms / 1000 * SR, L = Math.round(tau * 6) + 8, c = new Float32Array(L);
      const hp = Math.exp(-TWO_PI * ck.hp / SR), lp = Math.exp(-TWO_PI * lpHz / SR);
      let h = 0, l1 = 0, l2 = 0;
      for (let i = 0; i < L; i++){
        const w = Math.random() * 2 - 1;
        h = hp * h + (1 - hp) * w;                                          // 低域を除く
        l1 = lp * l1 + (1 - lp) * (w - h); l2 = lp * l2 + (1 - lp) * l1;    // 高域を丸める（2段）
        c[i] = l2 * (i < 8 ? i / 8 : Math.exp(-(i - 8) / tau)) * amp;
      }
      this.click = c;
    }
    this.ci = 0;
    // ----- 響き線・ノイズ（低い側は1次、高い側は2段の1次で帯域を切る） -----
    this.nz = null;
    const ns = sp.noise;
    if (ns){
      this.nz = { amp: ns.amp * Math.pow(vel, ns.velExp === undefined ? 1 : ns.velExp),
        k: Math.exp(-1 / (ns.T * dm * SR)), up: Math.exp(-1 / (Math.max(0.05, ns.attMs || 0.3) * SR / 1000)),
        hp: Math.exp(-TWO_PI * ns.hp / SR), lp: Math.exp(-TWO_PI * Math.min(SR * 0.45, ns.lp) / SR),
        h: 0, l1: 0, l2: 0, e: 0, a: 1, t: 0, bursts: (ns.bursts || [0]).map(ms => Math.round(ms * SR / 1000)), bi: 0 };
    }
    this.gain = sp.gain * vel;
  }
  noteOff(){ if (!this.ring) this.relG = decayGain(this.release); }
  tick(){
    // 膜のピッチの上ずり（16サンプルごとに係数を更新）
    if ((this.g1 > 1e-4 || this.g2 > 1e-4) && (this.gc++ & 15) === 0){
      const k = 1 + this.g1 + this.g2, mm = this.mm;
      for (let j = 0; j < mm.length; j++) mm[j].a1 = 2 * mm[j].r * Math.cos(Math.min(3.1, mm[j].w * k));
      this.g1 *= this.k1; this.g2 *= this.k2;
    }
    const i = this.ei++;
    let s = 0;
    const mm = this.mm;
    if (mm.length){
      const x = i < this.mExc.length ? this.mExc[i] : 0;
      for (let k = 0; k < mm.length; k++){
        const m = mm[k], y = m.a1 * m.y1 + m.a2 * m.y2 + m.b * x;
        m.y2 = m.y1; m.y1 = y; s += y;
      }
    }
    const mt = this.mt;
    if (mt.length){
      let x = i < this.pExc.length ? this.pExc[i] : 0;
      const bl = this.bloom;
      if (bl){
        bl.y = bl.lp * bl.y + (1 - bl.lp) * (Math.random() * 2 - 1);
        x += bl.y * bl.amp * (1 - bl.a) * bl.d;
        bl.a *= bl.up; bl.d *= bl.dn;
      }
      for (let k = 0; k < mt.length; k++){
        const m = mt[k], y = m.a1 * m.y1 + m.a2 * m.y2 + m.b * x;
        m.y2 = m.y1; m.y1 = y; s += y;
      }
    }
    if (this.click && this.ci < this.click.length) s += this.click[this.ci++];
    const nz = this.nz;
    if (nz){
      if (nz.bi < nz.bursts.length && nz.t === nz.bursts[nz.bi]){ nz.e += 1; nz.a = 1; nz.bi++; }
      nz.t++;
      const w = Math.random() * 2 - 1;
      nz.h = nz.hp * nz.h + (1 - nz.hp) * w;
      nz.l1 = nz.lp * nz.l1 + (1 - nz.lp) * (w - nz.h); nz.l2 = nz.lp * nz.l2 + (1 - nz.lp) * nz.l1;
      s += nz.l2 * nz.e * (1 - nz.a) * nz.amp;
      nz.e *= nz.k; nz.a *= nz.up;
    }
    this.env *= this.relG;
    if (this.env < 1e-4) this.dead = true;
    return s * this.gain * this.env;
  }
}
