/* ---------- 擦弦：弓・弦の摩擦モデルつき双方向導波管 (STK Bowed系) ＋ 胴 ---------- */
// 胴の共鳴・強さと音高による明るさ・弓の擦れ雑音は、アイオワ大学 MIS のバイオリン／チェロ
// （arco、pp・mf・ff、全4弦）の録音と倍音ごとに比べて決めた。どれも弦の振動の外側（線形のフィルタと
// 足し込む雑音）なので、ヘルムホルツ運動の安定性には影響しない。弦そのもの（ループの損失・弓の位置・
// 弓速度と弓圧）は以前の「裏返り」対策のままで、元から残っていた低音の強奏と最高音域の不安定さだけを直した
class BowedVoice {
  constructor(o){
    const sp = o.spec, f = o.freq * (sp.freqScale || 1);
    // ループ長はフィルタの実位相遅延から決める。固定値で近似すると
    // 高音ほど誤差の比率が効いて音程がシャープになる
    const wv = TWO_PI * f / SR;
    // 弦の損失フィルタ。固定のままだと高音では基音自体が1往復ごとに大きく削られ、
    // 発振が続かない／上の倍音へ飛ぶ。高音では遮断周波数を音高に追従させ、
    // 基音での1往復の反射率を全音域で 0.95 にそろえる
    let pole = Math.min(0.75 - 0.2 * 22050 / SR, Math.exp(-TWO_PI * Math.min(SR * 0.45, 5 * f) / SR));
    // ループが十数サンプルしかない最高音域では、1次ローパスでは2倍音を基音より十分に減衰させられず
    // オクターブ上に飛ぶ（元のモデルでも A#7〜C8 で起きていた）。2倍音の反射率が基音の H2R 倍以下になるよう極を上げる
    // 1.5kHz 以下では元のまま（中低音の音色と安定性は変えない）、2.5kHz 以上で 0.9
    const H2R = 1 - 0.1 * Math.min(1, Math.max(0, (f - 1500) / 1000));
    if (H2R < 1){
      const mag = (p, w) => (1 - p) / Math.sqrt(1 - 2 * p * Math.cos(w) + p * p);
      if (mag(pole, 2 * wv) / mag(pole, wv) > H2R){
        let lo = pole, hi = 0.99;
        for (let it = 0; it < 40; it++){ const mid = 0.5 * (lo + hi); if (mag(mid, 2 * wv) / mag(mid, wv) > H2R) lo = mid; else hi = mid; }
        pole = hi;
      }
    }
    // 基音での反射率を 0.95 にそろえる補正は、ローパスの分だけ直流付近の利得も上げる。
    // 極が大きく音が高いと直流の1往復の利得が1を超えて発散する（元は鍵125以上、MIDI でしか出ない音域）ので 0.99 で止める
    this.refl = Math.min(0.99, 0.95 * Math.sqrt(1 - 2 * pole * Math.cos(wv) + pole * pole) / (1 - pole));
    const base = Math.max(8, SR / f - onePoleDelay(pole, wv));
    const beta = 0.127;
    this.bD = base * beta;
    this.nD = base * (1 - beta);
    this.bridge = new DelayLine(this.bD + 4);
    // ビブラートでナット側の遅延が伸びる分もバッファに確保する（足りないと低音で範囲外を読んで NaN になる）
    const vb = sp.vib || [5.4, 5];
    this.vibDepth = (Math.pow(2, vb[1] / 1200) - 1) / (1 - beta);   // 音程の振れ幅（セント）→ ナット側の遅延の変化率
    this.neck = new DelayLine(this.nD * (1 + this.vibDepth) + 12);
    this.lp = new OnePole(pole);
    // 胴：録音の倍音を、この弦モデルが胴なしで出す倍音で割って求めた応答（1/6オクターブで平滑化）を、
    // 並列の共鳴モードで近似したもの。f字孔の空気共鳴〜表板・裏板の共鳴・駒の共振（2〜4kHz のブリッジヒル）
    this.body = new Body(sp.body);
    // 明るさ：強く弾くほど弓を駒寄りに強く当てるので高域が増える（チェロは pp〜ff で 4kHz 付近が約20dB違った）。
    // 音高による違い（弦ごとの差）も1次のシェルフで足す
    const tl = sp.tilt || {}, key = 69 + 12 * Math.log2(f / 440);
    const tDb = Math.max(-18, Math.min(18, (tl.db || 0) + (tl.perKey || 0) * (key - (tl.ref || 69)) + (tl.perVel || 0) * (o.vel - 0.6)));
    this.tiltG = Math.pow(10, tDb / 20) - 1;
    const tiltComp = Math.pow(10, -0.3 * tDb / 20);   // 高域を上げた分だけ全体の音量が増えないように
    this.tiltP = Math.exp(-TWO_PI * (tl.hz || 1000) / SR); this.tiltY = 0;
    this.env = 0; this.target = 1;
    // 弓をゆっくり押し当てる＝基音のヘルムホルツ運動にロックしやすい
    this.atkC = 1 - Math.exp(-1 / (0.09 * SR));
    this.relC = 1 - Math.exp(-1 / (0.08 * SR));
    // 弓速度が大きすぎると弦が高次モードに飛んで裏返る（STK基準の範囲に収める）
    // 軽い弓圧のまま速く弾くと弦を捉えきれず倍音に飛ぶので、弓圧が低いときは弓速度も抑える
    // 最高音域（3〜4kHz 以上）で弓圧が強すぎると、遅い弓では弦が押さえつけられて鳴り始めない（元は B7 などが無音だった）
    const press = Math.min(1, Math.max(0, o.bright)) * (1 - 0.7 * Math.min(1, Math.max(0, (f - 3000) / 1000)));
    this.maxV = (0.03 + 0.10 * o.vel) * (0.7 + 0.3 * press);
    this.slope = 4.2 - 2.3 * press; // 弓圧
    // 低音（230Hz 以下）を強く弾くと、弓が弦をつかみきれず最初から3倍音（12度上）でロックすることがある。
    // 弓速度÷弓圧（摩擦テーブルの入力の大きさ）に上限を設け、その分の音量は出力の利得で戻す
    let vComp = 1;
    const uMax = 0.2 + 5 * Math.min(1, Math.max(0, (f - 230) / 70));
    if (this.maxV * this.slope > uMax){ vComp = this.maxV * this.slope / uMax; this.maxV /= vComp; }
    // 弓毛と松脂の擦れ雑音。弦の振動には入れず（安定性を変えない）、駒の信号に足して胴を通す。
    // 弓が弦をつかむまでの数十msは強く、弱く弾くほど相対的に大きい（録音の倍音以外の成分の量に合わせた）
    const nz = sp.noise || {};
    const nzV = Math.min(3.5, Math.pow(0.6 / Math.max(0.05, o.vel), nz.velExp || 0));
    this.nzS = (nz.steady || 0) * nzV; this.nzA = (nz.attack || 0) * nzV;
    this.nzD = Math.exp(-1 / ((nz.attackT || 0.04) * SR)); this.nzE = 1;
    this.nzHP = Math.exp(-TWO_PI * (nz.hp || 400) / SR); this.nzH = 0;
    this.nzLP = Math.exp(-TWO_PI * (nz.lp || 1500) / SR); this.nzL = 0;
    // ビブラート：弾き始めて 0.25 秒後から 0.5 秒かけて深くなる。速さは少しずつ揺らぐ
    this.vibHz = vb[0] * (0.95 + 0.1 * Math.random());
    this.vibPh = Math.random() * TWO_PI; this.vibWPh = Math.random() * TWO_PI;
    this.t = 0;
    this.gain = sp.gain * (0.5 + 0.5 * o.vel) * vComp * tiltComp;
    this.dead = false;
  }
  noteOff(){ this.target = 0; }
  tick(){
    this.env += (this.target - this.env) * (this.target > 0 ? this.atkC : this.relC);
    this.t++;
    if (this.target === 0 && this.env < 1e-4){ this.dead = true; return 0; }
    this.vibWPh += TWO_PI * 0.37 / SR;
    this.vibPh += TWO_PI * this.vibHz * (1 + 0.06 * Math.sin(this.vibWPh)) / SR;
    const vibAmt = Math.min(1, Math.max(0, (this.t - 0.25 * SR) / (0.5 * SR)));
    const nDeff = this.nD * (1 + this.vibDepth * vibAmt * Math.sin(this.vibPh));
    // 松脂のついた弓毛は均一でなく、弓速度に細かいゆらぎが乗る
    const bowVel = this.env * this.maxV * (1 + 0.04 * (Math.random() * 2 - 1));
    const bridgeOut = this.bridge.read(this.bD);
    const neckOut = this.neck.read(nDeff);
    const bridgeRefl = -this.refl * this.lp.tick(bridgeOut);
    const nutRefl = -neckOut;
    const strVel = bridgeRefl + nutRefl;
    const dv = bowVel - strVel;
    const bx = Math.abs((dv + 0.001) * this.slope) + 0.75, bx2 = bx * bx;
    let bt = 1 / (bx2 * bx2);   // 弓・弦の摩擦テーブル (|x|+0.75)^-4（pow より桁違いに速い）
    if (bt > 1) bt = 1;
    const nv = dv * bt;
    this.neck.write(bridgeRefl + nv);
    this.bridge.write(nutRefl + nv);
    // 擦れ雑音（帯域を絞った白色雑音）
    const w = Math.random() * 2 - 1;
    this.nzH = (1 - this.nzHP) * w + this.nzHP * this.nzH;
    this.nzL = (1 - this.nzLP) * (w - this.nzH) + this.nzLP * this.nzL;
    const scr = this.nzL * this.env * this.maxV * (this.nzS + this.nzA * this.nzE);
    this.nzE *= this.nzD;
    let y = this.body.tick(bridgeOut + scr);
    this.tiltY = (1 - this.tiltP) * y + this.tiltP * this.tiltY;
    y += this.tiltG * (y - this.tiltY);
    return y * this.gain;
  }
}
