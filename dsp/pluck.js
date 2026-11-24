/* ---------- 撥弦：パルス波励振 × 2偏波の導波管 ＋ 胴の共鳴 ---------- */
// 楽器定義（specs.js）で使う項目。録音との比較で足したもの（書かなければ以前と同じ動作）：
//   hf:[b, 指数]   高域の減衰の増え方（dB/秒/kHz²、262Hzでの値と音高への依存）。R の代わりに使う
//   tMin           基音の余韻の下限（秒、既定 0.4）     bRef  画面の「明るさ」の既定値（hf・soft の基準）
//   B:[B0, 指数]   非調和係数（262Hzでの値と音高への依存）
//   pickExp / pickJit / pick2:[位置の倍率, 重み]   弾く位置の音高依存・ゆらぎ・指の幅（倍音の谷を浅く）
//   soft:[f0の倍率, Hz, 混合比, 段数, 音高指数]   指の腹で丸めた成分（第2・第3倍音を弱める）
//   sharp / sharpExp / sharpDecay   爪が離れる瞬間のクリック（基音比・音高依存・減衰 dB/秒）
//   glide:[セント, 秒]   強く弾いた直後の音程の上ずり     hp:[Hz, Q, 段数]   低域の放射の弱さ
//   sawari:[しきい値の比, 削る割合]   三味線のさわり
// 弦の曲げ剛性による非調和性（f_n = n·f0·√(1+B·n²)）を、同じ係数の1次オールパス M 段で近似する。
// 第 nRef 部分音が目標どおりずれる係数を二分法で求める（撥弦の B は 1e-5〜2e-3 と小さいので M≤3 で足りる）
function pluckDispersion(f0, B){
  const w1 = TWO_PI * f0 / SR, P0 = SR / f0;
  const nRef = Math.min(8, Math.floor(0.3 * SR / f0));
  if (!(B > 0) || nRef < 2) return { M: 0, a: 0 };
  const wR = w1 * nRef * Math.sqrt(1 + B * nRef * nRef);
  const need = P0 * (1 - Math.sqrt((1 + B) / (1 + B * nRef * nRef)));   // 第 nRef 部分音で縮めたい遅延
  for (let M = 1; M <= 3; M++){
    const gap = a => M * (allpassDelay(a, w1) - allpassDelay(a, wR));
    if (gap(-0.95) < need) continue;
    let lo = -0.95, hi = 0;
    for (let it = 0; it < 30; it++){ const mid = 0.5 * (lo + hi); if (gap(mid) > need) lo = mid; else hi = mid; }
    const a = 0.5 * (lo + hi);
    if (M * allpassDelay(a, w1) < 0.4 * P0) return { M, a };
  }
  return { M: 0, a: 0 };
}
// 楽器の放射：低い周波数ほど胴や響板から音が出にくい（2次ハイパス。段数を重ねて急にできる）
class RadHP {
  constructor(f, q){
    const w = TWO_PI * f / SR, al = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + al;
    this.b0 = (1 + c) / 2 / a0; this.b1 = -(1 + c) / a0; this.b2 = this.b0;
    this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }
  tick(x){
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y; return y;
  }
}
class StringVoice {
  constructor(o){
    const sp = o.spec, f = o.freq, vel = o.vel;
    this.dead = false;
    // 基音の余韻。録音では高い音ほど急に短くなる（ナイロン弦ギターの C5 以上・ハープの高音は1秒前後）
    const T60 = Math.min(sp.tMax || 14, Math.max(sp.tMin ?? 0.4, sp.t110 * Math.pow(110 / f, sp.tExp))) * o.decayMul;
    // 高い部分音ほど速く減衰する度合い。hf があれば、録音で測った「1kHz²あたりの減衰の増え方」
    // （絶対周波数で決まる空気・材料の損失）から、第8倍音の減衰が基音の何倍かを求める
    let R;
    if (sp.hf){
      const s1 = 60 / T60, f8 = Math.min(SR * 0.42, 8 * f) / 1000;
      const b = sp.hf[0] * Math.pow(f / 262, sp.hf[1]);
      R = (1 + b * f8 * f8 / s1) * (1.5 - o.bright) / (1.5 - (sp.bRef ?? 0.5));
      R = Math.max(1.1, Math.min(60, R));
    } else R = Math.max(1.3, sp.R * (1.5 - o.bright));
    // 指やピックの硬さ・弾く強さ → 励振波形の角の鋭さ
    const fc = Math.min(SR * 0.45, sp.fcMin + (sp.fcMax - sp.fcMin) * o.bright * (0.45 + 0.6 * vel));
    const ps = Math.exp(-TWO_PI * fc / SR);
    // 弾く位置：弦の長さに対する比。指の位置はほぼ一定なので、短い（高い）弦ほど比が中央寄りになる。
    // 毎回わずかにずらす（同じ音を続けて弾いても倍音の谷が同じ位置に来ない）
    let pick = sp.pickPos * Math.pow(f / 262, sp.pickExp || 0);
    if (sp.pickJit) pick *= 1 + sp.pickJit * (Math.random() * 2 - 1);
    pick = Math.min(0.45, Math.max(0.02, pick));
    // 非調和性
    const B = sp.B ? sp.B[0] * Math.pow(f / 262, sp.B[1]) : 0;
    const disp = B > 0 ? pluckDispersion(f, B) : { M: 0, a: 0 };
    this.str = []; this.clk = null;
    // 弦は表板に垂直・平行の2方向に振動する。わずかに周波数と減衰が違うため、
    // うなりと「速い減衰→遅い減衰」の二段階の余韻が生まれる
    const pols = [[0, 1, 1], [sp.polDetune, sp.polDecay, sp.polAmp]];
    for (const [dt, ts, amp] of pols){
      const fk = f * (1 + dt);
      const d = loopDesign(fk, T60 * ts, R);
      const D0 = Math.max(2.2, SR / fk - d.lpDelay - disp.M * allpassDelay(disp.a, TWO_PI * fk / SR));
      const Di = Math.max(1, Math.round(D0 - 1));
      const frac = Math.min(1.9, Math.max(0.1, D0 - Di));
      const dl = new DelayLine(Di + 8);
      // 弾かれた弦がブリッジに及ぼす力は、弾いた位置で決まるデューティ比のパルス波になる
      // （位置 1/n で弾くと第n倍音が欠ける）。ノイズ励振と違い実際の撥弦と同じ倍音構成になる
      const tmp = new Float32Array(Di), pz = new Float64Array(Di);
      const pulse = (pos, w) => {
        const cw = Math.min(Di - 1, Math.max(1, Math.round(pos * Di)));
        const duty = cw / Di;
        for (let i = 0; i < Di; i++) pz[i] += w * (i < cw ? 1 - duty : -duty);
      };
      pulse(pick, 1);
      // 指や爪は点ではなく幅をもって弦に触れ、離れる瞬間もずれる。少し離れた位置のパルスを混ぜて、
      // 「位置 1/n で第n倍音が完全に消える」深い谷を、録音で見られる程度の浅い谷にする
      if (sp.pick2) pulse(Math.min(0.48, pick * sp.pick2[0]), sp.pick2[1]);
      for (let i = 0; i < Di; i++) tmp[i] = pz[i] + (Math.random() * 2 - 1) * sp.pickNoise;
      // 角を丸める（循環・往復でゼロ位相）
      let y = 0;
      for (let pass = 0; pass < 2; pass++)
        for (let i = 0; i < Di; i++){ y = (1 - ps) * tmp[i] + ps * y; if (pass) tmp[i] = y; }
      for (let pass = 0; pass < 2; pass++)
        for (let i = Di - 1; i >= 0; i--){ y = (1 - ps) * tmp[i] + ps * y; if (pass) tmp[i] = y; }
      // 指の腹の柔らかさ：基音の数倍の周波数で丸めた成分を主にする（第2・第3倍音が基音より十分弱くなる）
      // 強く弾くほど・「明るさ」を上げるほど丸め方が弱くなる
      if (sp.soft){
        const fs = Math.min(SR * 0.45, (sp.soft[0] * f * Math.pow(f / 262, sp.soft[4] || 0) + sp.soft[1]) * (0.55 + 0.9 * vel) * Math.pow(4, o.bright - (sp.bRef ?? 0.5)));
        const pp = Math.exp(-TWO_PI * fs / SR), mix = sp.soft[2], order = sp.soft[3] || 1;
        const t2 = Float32Array.from(tmp);
        for (let n = 0; n < order; n++){
          for (let pass = 0; pass < 2; pass++)
            for (let i = 0; i < Di; i++){ y = (1 - pp) * t2[i] + pp * y; if (pass) t2[i] = y; }
          for (let pass = 0; pass < 2; pass++)
            for (let i = Di - 1; i >= 0; i--){ y = (1 - pp) * t2[i] + pp * y; if (pass) t2[i] = y; }
        }
        for (let i = 0; i < Di; i++) tmp[i] = mix * t2[i] + (1 - mix) * tmp[i];
      }
      let e = 0; for (let i = 0; i < Di; i++) e += tmp[i] * tmp[i];
      const sc = 0.3 * amp / Math.sqrt(e / Di + 1e-12);
      for (let i = 0; i < Di; i++) dl.buf[i] = tmp[i] * sc;
      dl.w = Di;
      // 爪（指先）が弦から離れる瞬間のクリック：高い倍音がほぼ平らに並ぶ成分で、録音では基音より
      // 低音で45dB・中音で35〜40dB・高音で約25dB 低い位置に 5〜11kHz まで平らに続き、毎秒 250〜400dB で消える（最初だけ明るい）。
      // 弦ループの損失フィルタでは高域ほど急に消えすぎるので、同じ周期で周波数によらず減衰する
      // 別の短いループで鳴らす。基音の振幅に対する比で与え、爪の硬さ（fc）で丸める
      if (sp.sharp && !this.clk){
        // 基音成分の振幅（1周期ぶんの DFT の第1成分。回転ベクトルの漸化式で三角関数を使わずに求める）
        const cr = Math.cos(TWO_PI / Di), ci = Math.sin(TWO_PI / Di);
        let re = 0, im = 0, pr = 1, pi = 0;
        for (let i = 0; i < Di; i++){ re += dl.buf[i] * pr; im += dl.buf[i] * pi; const t = pr * cr - pi * ci; pi = pr * ci + pi * cr; pr = t; }
        const a1 = 2 / Di * Math.sqrt(re * re + im * im);
        const D1 = Math.max(2.2, SR / fk), C = Math.max(1, Math.round(D1 - 1)), cf = Math.min(1.9, Math.max(0.1, D1 - C));
        const cl = new DelayLine(C + 8), imp = new Float32Array(C);
        imp[0] = sp.sharp * Math.pow(f / 262, sp.sharpExp || 0) * (0.4 + 0.6 * vel) * a1 * C / 2;
        y = 0;
        for (let pass = 0; pass < 2; pass++)
          for (let i = 0; i < C; i++){ y = (1 - ps) * imp[i] + ps * y; if (pass) imp[i] = y; }
        for (let i = 0; i < C; i++) cl.buf[i] = imp[i];
        cl.w = C;
        this.clk = { dl: cl, D: C, a: (1 - cf) / (1 + cf), ax: 0, ay: 0, g: Math.pow(10, -(sp.sharpDecay || 300) / 20 / fk), n: Math.round(0.25 * SR) };
      }
      const ap = []; for (let j = 0; j < disp.M; j++) ap.push({ x: 0, y: 0 });
      this.str.push({ dl, D: Di, p: d.p, g: d.g, lpy: 0, a: (1 - frac) / (1 + frac), ax: 0, ay: 0, ap });
    }
    this.dA = disp.a;
    // 強く弾くと弦の張力が一瞬増えて音程が少し上がり、振幅の減衰とともに戻る（録音で数〜30セント）
    this.gl = 0; this.glD = 1;
    if (sp.glide){
      const cents = sp.glide[0] * vel * vel;
      this.gl = SR / f * (1 - Math.pow(2, -cents / 1200));   // 縮める遅延（サンプル）
      this.glD = Math.exp(-1 / (sp.glide[1] * SR));
    }
    // 三味線の「さわり」：弦が上駒の近くで棹の小さな山に片側だけ触れ、毎周期わずかに振れが削られる。
    // そのたびに高い倍音が作り直されるので、ビーンという明るい響きが余韻の間ずっと続く。
    // 触れ始める位置は振幅に比例させ（振幅の追従は約20ms）、弱くなっても同じ割合で触れ続けるようにする
    this.saw = sp.sawari ? { th: sp.sawari[0], r: sp.sawari[1], env: 0, ed: Math.exp(-1 / (0.02 * SR)) } : null;
    this.body = new Body(sp.body);
    this.hp = []; if (sp.hp) for (let j = 0; j < (sp.hp[2] || 1); j++) this.hp.push(new RadHP(sp.hp[0], sp.hp[1] || 0.7));
    this.dc = new DCBlock();
    this.thump = makeThump(sp.thump * vel, 7, 0.9); this.ti = 0;
    this.dg = 1; this.f0 = f; this.release = sp.release;
    this.gain = sp.gain * (0.15 + 0.85 * vel) * Math.min(1.8, Math.max(1, Math.pow(f / 262, 0.25)));
  }
  noteOff(){ this.dg = Math.pow(0.001, 1 / (this.f0 * this.release)); } // 指で弦を止める（往復あたりの損失）
  tick(){
    const st = this.str, dg = this.dg, A = this.dA;
    let gl = 0;
    if (this.gl > 1e-4){ gl = this.gl; this.gl *= this.glD; }
    let s = 0;
    for (let k = 0; k < 2; k++){
      const q = st[k];
      let y = gl ? q.dl.read(q.D - gl) : q.dl.read(q.D);
      y = q.lpy = (1 - q.p) * y + q.p * q.lpy;
      y *= q.g;
      const ap = q.ap;
      for (let j = 0; j < ap.length; j++){ const z = ap[j], o = A * y + z.x - A * z.y; z.x = y; z.y = o; y = o; }
      if (k === 0 && this.saw){
        const w = this.saw, ay = y < 0 ? -y : y;
        w.env = ay > w.env ? ay : w.env * w.ed;
        const th = w.th * w.env;
        if (y > th) y = th + (y - th) * w.r;
      }
      const out = q.a * y + q.ax - q.a * q.ay; // 分数遅延（振幅損失の無いオールパス）
      q.ax = y; q.ay = out;
      q.dl.write(out * dg);
      s += out;
    }
    const c = this.clk;
    if (c && c.n > 0){
      const y = c.dl.read(c.D) * c.g, out = c.a * y + c.ax - c.a * c.ay;
      c.ax = y; c.ay = out; c.dl.write(out); c.n--;
      s += out;
    }
    if (this.ti < this.thump.length) s += this.thump[this.ti++];
    let o = this.body.tick(this.dc.tick(s));
    for (let j = 0; j < this.hp.length; j++) o = this.hp[j].tick(o);
    return o * this.gain;
  }
}
