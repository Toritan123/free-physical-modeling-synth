
/* ---------- 擦弦：弓・弦の摩擦モデルつき双方向導波管 (STK Bowed系) ＋ 胴 ---------- */
class BowedVoice {
  constructor(o){
    const sp = o.spec, f = o.freq * (sp.freqScale || 1);
    // ループ長はフィルタの実位相遅延から決める。固定値で近似すると
    // 高音ほど誤差の比率が効いて音程がシャープになる
    const wv = TWO_PI * f / SR;
    // 弦の損失フィルタ。固定のままだと高音では基音自体が1往復ごとに大きく削られ、
    // 発振が続かない／上の倍音へ飛ぶ。高音では遮断周波数を音高に追従させ、
    // 基音での1往復の反射率を全音域で 0.95 にそろえる
    const pole = Math.min(0.75 - 0.2 * 22050 / SR, Math.exp(-TWO_PI * Math.min(SR * 0.45, 5 * f) / SR));
    this.refl = 0.95 * Math.sqrt(1 - 2 * pole * Math.cos(wv) + pole * pole) / (1 - pole);
    const base = Math.max(8, SR / f - onePoleDelay(pole, wv));
    const beta = 0.127;
    this.bD = base * beta;
    this.nD = base * (1 - beta);
    this.bridge = new DelayLine(this.bD + 4);
    this.neck = new DelayLine(this.nD + 12);
    this.lp = new OnePole(pole);
    // 胴：f字孔の空気共鳴・表板/裏板の共鳴・駒の共振（ブリッジヒル）
    this.body = new Body(sp.body);
    this.env = 0; this.target = 1;
    // 弓をゆっくり押し当てる＝基音のヘルムホルツ運動にロックしやすい
    this.atkC = 1 - Math.exp(-1 / (0.09 * SR));
    this.relC = 1 - Math.exp(-1 / (0.08 * SR));
    // 弓速度が大きすぎると弦が高次モードに飛んで裏返る（STK基準の範囲に収める）
    // 軽い弓圧のまま速く弾くと弦を捉えきれず倍音に飛ぶので、弓圧が低いときは弓速度も抑える
    const press = Math.min(1, Math.max(0, o.bright));
    this.maxV = (0.03 + 0.10 * o.vel) * (0.7 + 0.3 * press);
    this.slope = 4.2 - 2.3 * press; // 弓圧
    this.vibPh = Math.random() * TWO_PI;
    this.t = 0;
    this.gain = sp.gain * (0.5 + 0.5 * o.vel);
    this.dead = false;
  }
  noteOff(){ this.target = 0; }
  tick(){
    this.env += (this.target - this.env) * (this.target > 0 ? this.atkC : this.relC);
    this.t++;
    if (this.target === 0 && this.env < 1e-4){ this.dead = true; return 0; }
    this.vibPh += TWO_PI * 5.4 / SR;
    const vibAmt = Math.min(1, Math.max(0, (this.t - 0.25 * SR) / (0.5 * SR)));
    const nDeff = this.nD * (1 + 0.0035 * vibAmt * Math.sin(this.vibPh));
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
    return this.body.tick(bridgeOut) * this.gain;
  }
}
