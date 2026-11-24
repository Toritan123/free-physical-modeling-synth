/* ---------- フルート：ジェット非線形性つき気柱導波管 (STK Flute系) ---------- */
class FluteVoice {
  constructor(o){
    let f = o.freq;
    while (f < 123) f *= 2;   // 楽器の最低音より下は1オクターブ上で鳴らす
    const w = TWO_PI * f / SR;
    // 管壁の損失フィルタは基音では素通りに近く、上の倍音だけを丸める
    const pole = Math.exp(-TWO_PI * Math.min(SR * 0.45, 5 * f) / SR);
    // 開口端反射は位相を反転するので、この気柱の共振は SR/(2*boreD) の奇数倍になる。
    // boreD を1周期分にすると共振が f0/2, 1.5f0, … となり基音が共振点に無く、必ず裏返る。
    // STK同様に1.5周期分とすることで f0/3, f0, 5f0/3 … となり基音が第2共振に一致する
    // ジェットの遅延とフィルタの位相により実際の発振周波数は理論値より少し低くなる。
    // そのずれ（実測：中音域で約-27セントの滑らかな曲線）を気柱長で補正する
    const mN = 69 + 12 * Math.log2(f / 440);
    const corr = -27 + 0.030 * (mN - 70) * (mN - 70);
    const delay = 1.5 * SR / f * Math.pow(2, corr / 1200);
    this.boreD = Math.max(4, delay - onePoleDelay(pole, w));
    // 1往復あたりの損失をそのまま使うと、往復回数の少ない低音がほぼ無損失になり
    // わずかな吹圧で暴走する。損失を「秒あたり一定」になるよう正規化する
    const lpMag = (1 - pole) / Math.sqrt(1 - 2 * pole * Math.cos(w) + pole * pole);
    this.refl = Math.min(0.999, Math.exp(-1.5 / (0.08 * f)) / lpMag);
    // ジェットの伝搬遅延がどの共振を選ぶかを決める
    this.jetD = Math.max(2, delay * 0.38);
    this.bore = new DelayLine(this.boreD + 4);
    this.jet = new DelayLine(this.jetD + 4);
    this.lp = new OnePole(pole);
    this.dc = new DCBlock();
    this.env = 0; this.target = 1;
    // ゆっくり吹き込むほど基音にロックしやすい
    this.atkC = 1 - Math.exp(-1 / (0.07 * SR));
    this.relC = 1 - Math.exp(-1 / (0.09 * SR));
    // 吹圧の安定域は狭い。1.1を下回ると発振せず、1.3を超えると低音から順に
    // 上の共振へ飛び移る（オーバーブロー）ので、その中央に収める
    this.maxP = 1.14 + 0.06 * o.vel + 0.04 * (o.bright - 0.5);
    this.noiseG = 0.04;
    // 吹き始めは気流が定まらず、息の雑音が一瞬強く出る（チフ）
    this.chiff = 2.5; this.chiffK = Math.exp(-1 / (0.03 * SR));
    this.vibPh = Math.random() * TWO_PI;
    this.t = 0;
    // 低音は気柱の損失が大きく音圧が下がるぶんを補正する
    this.gain = 0.335 * o.vel * Math.min(1.3, Math.max(1, Math.pow(262 / f, 0.25)));
    this.dead = false;
  }
  noteOff(){ this.target = 0; }
  tick(){
    this.env += (this.target - this.env) * (this.target > 0 ? this.atkC : this.relC);
    if (this.target === 0 && this.env < 1e-4){ this.dead = true; return 0; }
    this.t++;
    this.vibPh += TWO_PI * 5.1 / SR;
    const vibAmt = Math.min(1, this.t / (0.35 * SR));
    const breath = this.env * this.maxP
      * (1 + 0.025 * vibAmt * Math.sin(this.vibPh))
      * (1 + this.noiseG * (1 + this.chiff) * (Math.random() * 2 - 1));
    this.chiff *= this.chiffK;
    let filt = -this.refl * this.lp.tick(this.bore.read(this.boreD)); // 開口端反射（位相反転＋損失）
    filt = this.dc.tick(filt);
    let pd = breath - 0.5 * filt;
    this.jet.write(pd);
    let jd = this.jet.read(this.jetD);
    jd = jd * (jd * jd - 1); // ジェットの非線形（3次）
    if (jd > 1) jd = 1; else if (jd < -1) jd = -1;
    const boreIn = jd + 0.5 * filt;
    this.bore.write(boreIn);
    return 0.3 * boreIn * this.gain;
  }
}

/* ---------- クラリネット：リード弁の非線形 × 閉管の導波管 (STK Clarinet系) ---------- */
class ReedVoice {
  constructor(o){
    const f = o.freq;
    // 閉管は片端で位相が反転するので、管の往復は半周期ぶん → 奇数倍音だけが鳴る
    // 管壁の損失：上の倍音ほど強く減衰させる。これが弱いと第3倍音（12度上）が
    // 基音と同じだけ持続してしまい、音が裏返りかける
    const w = TWO_PI * f / SR;
    const pole = Math.exp(-TWO_PI * Math.min(SR * 0.45, 5 * f) / SR);
    this.lp = new OnePole(pole);
    this.refl = Math.min(0.99, 0.95 * Math.sqrt(1 - 2 * pole * Math.cos(w) + pole * pole) / (1 - pole));
    this.D = Math.max(2, 0.5 * SR / f - 0.5 - onePoleDelay(pole, w));
    this.dl = new DelayLine(this.D + 4);
    this.z1 = 0;
    this.dc = new DCBlock();
    this.env = 0; this.target = 1;
    this.atkC = 1 - Math.exp(-1 / (0.03 * SR));
    this.relC = 1 - Math.exp(-1 / (0.05 * SR));
    // 吹圧が低いと発振せず、高すぎるとリードが閉じきって鳴らない。その間に収める
    this.maxP = 0.65 + 0.19 * o.vel;
    this.slope = -0.31 - 0.05 * (o.bright - 0.5); // リードの硬さ
    this.noiseG = 0.06;
    this.vibPh = Math.random() * TWO_PI; this.t = 0;
    this.hp = 0;
    this.gain = 0.5 * (0.4 + 0.6 * o.vel);
    this.dead = false;
  }
  noteOff(){ this.target = 0; }
  tick(){
    this.env += (this.target - this.env) * (this.target > 0 ? this.atkC : this.relC);
    if (this.target === 0 && this.env < 1e-4){ this.dead = true; return 0; }
    this.t++;
    this.vibPh += TWO_PI * 5.2 / SR;
    const vibAmt = Math.min(1, Math.max(0, (this.t - 0.3 * SR) / (0.5 * SR)));
    let bp = this.env * this.maxP;
    bp *= 1 + this.noiseG * (Math.random() * 2 - 1) + 0.02 * vibAmt * Math.sin(this.vibPh);
    const last = this.dl.read(this.D);
    const filt = this.lp.tick(0.5 * (last + this.z1)); this.z1 = last; // 管壁と開口端での損失
    const pd = -this.refl * filt - bp;                     // リード前後の圧力差
    let rt = 0.7 + this.slope * pd;                        // リードの開き具合
    if (rt > 1) rt = 1; else if (rt < -1) rt = -1;
    const out = bp + pd * rt;
    this.dl.write(out);
    // ベルからの放射は高域ほど効率が良い
    const d = this.dc.tick(out);
    const y = d - 0.55 * this.hp; this.hp = d;
    return y * this.gain;
  }
}

/* ---------- トランペット：唇の共振弁 × 管の導波管 (STK Brass系) ---------- */
class BrassVoice {
  constructor(o){
    const sp = o.spec;
    let f = o.freq;
    while (f < 160) f *= 2;      // 楽器の音域外は折り返す
    while (f > 1110) f /= 2;
    // 唇の共振と管の共鳴が引き合うため、発振周波数は両者の設定値より高くなる。
    // そのずれを音高ごとに実測した較正表で打ち消す
    const ci = Math.min(sp.cal.length - 1.001, Math.max(0, (69 + 12 * Math.log2(f / 440) - 50) / 2));
    const c0 = Math.floor(ci), cc = sp.cal[c0] + (sp.cal[c0 + 1] - sp.cal[c0]) * (ci - c0);
    f *= Math.pow(2, -cc / 1200);
    this.D = 2 * SR / f + sp.dOff;
    this.dl = new DelayLine(this.D + 4);
    // 唇は質量とばねの共振系。その共振周波数に近い管の共鳴が選ばれて鳴る
    const r = sp.lipR, w = TWO_PI * f * sp.lipDet / SR;
    this.a1 = -2 * r * Math.cos(w); this.a2 = r * r;
    // 共振のピーク利得を音高によらず一定にする（そのままだと低音ほど利得が過大になる）
    this.lipG = sp.lipK * f * (1 - r) * 2 * Math.sin(w);
    this.y1 = 0; this.y2 = 0;
    this.dc = new DCBlock();
    this.env = 0; this.target = 1;
    this.atkC = 1 - Math.exp(-1 / (0.025 * SR));
    this.relC = 1 - Math.exp(-1 / (0.05 * SR));
    this.maxP = 0.55 + 0.45 * o.vel;
    this.vibPh = Math.random() * TWO_PI; this.t = 0;
    this.hp = 0; this.bright = 0.35 + 0.5 * o.bright;
    this.gain = 1.9;
    this.dead = false;
  }
  noteOff(){ this.target = 0; }
  tick(){
    this.env += (this.target - this.env) * (this.target > 0 ? this.atkC : this.relC);
    if (this.target === 0 && this.env < 1e-4){ this.dead = true; return 0; }
    this.t++;
    this.vibPh += TWO_PI * 5.6 / SR;
    const vibAmt = Math.min(1, Math.max(0, (this.t - 0.35 * SR) / (0.5 * SR)));
    const breath = this.env * this.maxP * (1 + 0.03 * vibAmt * Math.sin(this.vibPh));
    const mouth = 0.3 * breath;
    const bore = 0.85 * this.dl.read(this.D);
    let dP = mouth - bore;                                  // 唇の前後の圧力差
    const y = this.lipG * dP - this.a1 * this.y1 - this.a2 * this.y2;
    this.y2 = this.y1; this.y1 = y;
    dP = y * y; if (dP > 1) dP = 1;                         // 唇の開口面積（0〜1）
    const o = this.dc.tick(dP * mouth + (1 - dP) * bore);
    this.dl.write(o);
    const z = o - this.bright * this.hp; this.hp = o;       // ベルの放射特性
    return z * this.gain;
  }
}
