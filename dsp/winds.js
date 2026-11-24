/* ---------- フルート：ジェットの振れ × 開管の導波管 ---------- */
class FluteVoice {
  constructor(o){
    const sp = o.spec;
    let f = o.freq;
    while (f < 123) f *= 2;   // 楽器の最低音より下は1オクターブ上で鳴らす
    const w = TWO_PI * f / SR;
    // 両端が開いた管：両端で1回ずつ位相が反転するので往復では反転せず、共鳴は f0, 2f0, 3f0 … と全倍音に並ぶ。
    // 気柱の往復を1周期分とし、基音を最低の共鳴にする（下に裏返る先の共鳴が無い）。
    // 管壁と音孔での損失：上の倍音ほど強く減衰させる（基音の数倍で丸める）
    const pole = Math.exp(-TWO_PI * Math.min(SR * 0.45, sp.lpMul * f) / SR);
    // ジェットの遅延とフィルタの位相で実際の発振周波数はずれる。そのずれ（実測の滑らかな曲線）を気柱長で補正する
    const mN = 69 + 12 * Math.log2(f / 440);
    const corr = sp.cal[0] + sp.cal[1] * (mN - 72) + sp.cal[2] * (mN - 72) * (mN - 72);
    const period = SR / f * Math.pow(2, -corr / 1200);
    this.boreD = Math.max(4, period - onePoleDelay(pole, w));
    // 1往復あたりの損失をそのまま使うと、往復回数の少ない低音がほぼ無損失になり
    // 暴走しやすい。損失を「秒あたり一定」になるよう正規化する
    const lpMag = (1 - pole) / Math.sqrt(1 - 2 * pole * Math.cos(w) + pole * pole);
    this.refl = Math.min(0.999, Math.exp(-1.5 / (0.08 * f)) / lpMag);
    // ジェットが歌口から歌口の縁（エッジ）まで届く時間。半周期にすると基音で位相が揃い、
    // 強さによらず基音で安定して鳴る（オクターブ上や下へ裏返らない）
    this.jetD = Math.max(2, 0.5 * period);
    this.bore = new DelayLine(this.boreD + 4);
    this.jet = new DelayLine(this.jetD + 4);
    this.lp = new OnePole(pole);
    this.dc = new DCBlock();
    this.env = 0; this.target = 1;
    this.atkC = 1 - Math.exp(-1 / (sp.atk * SR));
    this.relC = 1 - Math.exp(-1 / (0.09 * SR));
    // ジェットの流量はエッジの両側に分かれる（tanh）。強く吹くほど振れ幅と利得が上がる
    this.jA = 0.4 * (0.6 + 0.4 * o.vel);
    this.jG = sp.jG0 + sp.jG1 * o.vel;
    this.noiseG = sp.noise;   // 息の乱れ。発振はこの雑音から立ち上がるので 0 にはしない
    // 吹き始めは気流が定まらず、息の雑音が一瞬強く出る（チフ）。舌で突いた直後はジェットが速く
    // 利得も一瞬高い（kick）。これで低音でも発振が早く立ち上がる
    this.kick = sp.kick; this.chiff = 2.5; this.chiffK = Math.exp(-1 / (0.03 * SR));
    this.vibPh = Math.random() * TWO_PI;
    this.t = 0;
    // ジェットはエッジに対して少しずれて当たり、流量の分かれ方が上下で非対称になる。
    // これが偶数倍音（特に第2倍音）を生む。管の中で循環させると気柱の往復と
    // ジェットの遅延の組み合わせで打ち消されるため、放射される音の側で加える。
    // 録音では低音ほど・強いほど第2倍音が強い（C4 の ff では基音を上回る）
    const reg = Math.min(1, Math.max(0, (mN - 60) / 30));
    this.h2 = (sp.h2Lo + (sp.h2Hi - sp.h2Lo) * reg) * (sp.h2v0 + (1 - sp.h2v0) * o.vel) * (0.5 + o.bright);
    // 放射される音の高域：音孔の遮断周波数より上は管の外へ逃げ、倍音が急に弱まる。強く吹くほど伸びる
    const oc = sp.oLo * Math.pow(sp.oHi / sp.oLo, o.vel) * Math.pow(2, 1.2 * (o.bright - 0.5));
    this.oC = 1 - Math.exp(-TWO_PI * oc / SR); this.o1 = 0; this.o2 = 0; this.sq = 0;
    // 低音は気柱の損失が大きく音圧が下がるぶんを補正する
    this.gain = sp.gain * (0.25 + 0.75 * o.vel) * Math.min(1.3, Math.max(1, Math.pow(262 / f, 0.25)));
    this.dead = false;
  }
  noteOff(){ this.target = 0; }
  tick(){
    this.env += (this.target - this.env) * (this.target > 0 ? this.atkC : this.relC);
    if (this.target === 0 && this.env < 1e-4){ this.dead = true; return 0; }
    this.t++;
    this.vibPh += TWO_PI * 5.1 / SR;
    const vibAmt = Math.min(1, this.t / (0.35 * SR));
    const nz = this.noiseG * (1 + this.chiff) * (Math.random() * 2 - 1);
    this.chiff *= this.chiffK;
    const A = this.env * this.jA * (1 + 0.04 * vibAmt * Math.sin(this.vibPh));
    let filt = this.refl * this.lp.tick(this.bore.read(this.boreD)); // 両開管の往復（反転なし＋損失）
    filt = this.dc.tick(filt);
    this.jet.write(-0.5 * filt + nz * A);                   // 管内の振動がジェットを横に揺らす（＋息の乱れ）
    const x = this.jet.read(this.jetD);
    const jd = A > 1e-6 ? A * Math.tanh(this.jG * (1 + this.kick * this.chiff) * x / A) : 0;  // エッジで分かれた流量（飽和は滑らか）
    const boreIn = jd + 0.5 * filt;
    this.bore.write(boreIn);
    // 放射：エッジでの非対称（第2倍音）＋息の雑音＋音孔による高域の減衰
    let y = boreIn;
    const q = A > 1e-6 ? y * y / A : 0;
    this.sq += (q - this.sq) * 0.002;                       // 2乗成分の直流を除く
    y += this.h2 * (q - this.sq) + 0.6 * nz * A;
    this.o1 += (y - this.o1) * this.oC; this.o2 += (this.o1 - this.o2) * this.oC;
    return this.o2 * this.gain;
  }
}

/* ---------- クラリネット：リード弁の非線形 × 閉管の導波管 ---------- */
class ReedVoice {
  constructor(o){
    const sp = o.spec;
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
    // リードが閉じきる（ビーティング）：強く吹くほどマウスピース内の圧力は台形〜矩形に近づき、
    // 奇数倍音が強まる。管内でこれを再現すると吹圧の安定域を外れるので、放射の側で
    // 対称な飽和として与える（対称なので奇数倍音だけが増える）
    this.drv = sp.d0 + sp.d1 * o.vel * o.vel;
    this.dN = 1 / Math.tanh(this.drv);
    // 上の音域（スロート〜クラリオン、A4 付近から上）では録音で偶数倍音も強く出る。
    // 第12度（第3共鳴）で鳴らす音域では管の共鳴が奇数倍音だけに揃わず、リードの非対称さが残るため
    const mN = 69 + 12 * Math.log2(f / 440);
    this.e2 = sp.e2 * Math.min(1, Math.max(0, (mN - 66) / 8)) * (0.4 + 0.6 * o.vel); this.sq = 0;
    // ベル・音孔からの放射：低域は放射されにくく（高域通過）、音孔の遮断周波数より上は急に弱まる
    // （楽器の音域より極端に低い音では基音が消えないよう、遮断周波数を基音の20倍までにする）
    this.hpC = 1 - Math.exp(-TWO_PI * Math.min(sp.hp, 20 * f) / SR); this.hs = 0;
    // （基音より下には下げない。音域外の高い音で基音まで消えないように）
    const oc = Math.max(1.5 * f, sp.oLo * Math.pow(sp.oHi / sp.oLo, o.vel) * Math.pow(2, 1.2 * (o.bright - 0.5)));
    this.oC = 1 - Math.exp(-TWO_PI * Math.min(oc, SR * 0.45) / SR); this.o1 = 0; this.o2 = 0;
    this.gain = sp.gain * (0.4 + 0.6 * o.vel);
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
    // マウスピース内の圧力（直流を除く）→ リードの閉じきりによる飽和 → 放射
    const d = this.dc.tick(out);
    const amp = this.env * this.maxP * 0.5 + 1e-6;
    let y = amp * Math.tanh(this.drv * d / amp) * this.dN;
    const q = y * y / amp; this.sq += (q - this.sq) * 0.002; y += this.e2 * (q - this.sq);
    this.hs += (y - this.hs) * this.hpC; y -= this.hs;
    this.o1 += (y - this.o1) * this.oC; this.o2 += (this.o1 - this.o2) * this.oC;
    return this.o2 * this.gain;
  }
}

/* ---------- トランペット：唇の共振弁 × 管の導波管 × ベルの放射 ---------- */
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
    this.dcP = 0; this.dcC = 1 - Math.exp(-TWO_PI * 15 / SR); this.emb = sp.emb;
    this.dc = new DCBlock();
    this.env = 0; this.target = 1;
    this.atkC = 1 - Math.exp(-1 / (sp.atk * SR));
    this.relC = 1 - Math.exp(-1 / (0.05 * SR));
    this.vel = o.vel;
    this.maxP = 0.55 + 0.45 * o.vel;
    this.vibPh = Math.random() * TWO_PI; this.t = 0;
    // ベルからの放射：低い周波数ほど管の中に反射されて外へ出にくい（共振つき2次＋1次の高域通過）。
    // 録音の倍音分布は約 1〜1.4kHz を頂点に、それより下では 1 オクターブあたり約 10dB ずつ弱まる
    {
      const w0 = TWO_PI * sp.radHz / SR, al = Math.sin(w0) / (2 * sp.radQ), cw = Math.cos(w0), a0 = 1 + al;
      this.rb0 = (1 + cw) / 2 / a0; this.rb1 = -(1 + cw) / a0; this.ra1 = -2 * cw / a0; this.ra2 = (1 - al) / a0;
    }
    this.rx1 = 0; this.rx2 = 0; this.ry1 = 0; this.ry2 = 0;
    this.hpC = 1 - Math.exp(-TWO_PI * sp.hp1 / SR); this.hpS = 0;
    // 強く吹くほど高域が伸びる（唇が閉じる時間の割合が増え、管内の非線形伝搬で波形が切り立つ）。
    // 吹圧に応じて遮断周波数が動く低域通過で表す。録音では 1.4kHz より上の減衰が
    // pp で 1 オクターブあたり約 40dB、mf〜ff で約 17dB
    this.fLo = sp.fLo; this.fHi = sp.fHi * Math.pow(2, 1.2 * (o.bright - 0.5));
    this.sK = sp.sK; this.l1 = 0; this.l2 = 0; this.l3 = 0; this.lc = 0.5; this.lcN = 0;
    this.gain = sp.gain;
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
    const dP = mouth - bore;                                // 唇の前後の圧力差
    // 奏者は唇の筋肉で吹圧の静的な成分を受け止めている。これが無いと、低音を強く吹いたとき
    // 唇が押し開かれたままになって発振が止まる（E3〜B3 を ff で吹くと無音になっていた）
    this.dcP += (dP - this.dcP) * this.dcC;
    const y = this.lipG * (dP - this.emb * this.dcP) - this.a1 * this.y1 - this.a2 * this.y2;
    this.y2 = this.y1; this.y1 = y;
    // 唇の開口面積（0〜1）。唇は閉じきるとそれ以上は閉じない（片側だけで頭打ち）。
    // 以前は y² としていたが、これは唇が開閉の両側で開くことになり、
    // 発振が数周期ごとに揺れる（f0/8 前後のうなり＝ブルブルした音）原因だった
    const a = y < 0 ? 0 : y > 1 ? 1 : y;
    const o = this.dc.tick(a * mouth + (1 - a) * bore);
    this.dl.write(o);
    // ベルの放射（高域通過）
    let z = this.rb0 * (o + this.rx2) + this.rb1 * this.rx1 - this.ra1 * this.ry1 - this.ra2 * this.ry2;
    this.rx2 = this.rx1; this.rx1 = o; this.ry2 = this.ry1; this.ry1 = z;
    this.hpS += (z - this.hpS) * this.hpC; z -= this.hpS;
    // 吹圧に応じた高域の伸び（3段の1次低域通過）。係数は32サンプルごとに更新する
    if (--this.lcN <= 0){
      this.lcN = 32;
      // 弱い音（pp）から mf までで急に明るくなり、その先は伸びが鈍る（録音の pp/mf/ff の比較による）
      const lv = this.env * this.vel, k = this.sK, s = lv * lv / (lv * lv + k) * (1 + k);
      const fc = this.fLo * Math.pow(this.fHi / this.fLo, s);
      const wc = TWO_PI * fc / SR;
      this.lc = wc / (1 + wc);
    }
    const c = this.lc;
    this.l1 += (z - this.l1) * c; this.l2 += (this.l1 - this.l2) * c; this.l3 += (this.l2 - this.l3) * c;
    return this.l3 * this.gain;
  }
}
