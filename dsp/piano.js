
/* ---------- ピアノ：ハンマー衝突シミュレーション × 非調和弦の結合 ＋ 響板・共鳴弦 ---------- */
// 鍵ごとの物性値。C2 / C4 / C7 の実測値（Chaigne & Askenfelt 1994）を補間する
function pianoParams(m){
  const seg = (a, b, c) => m < 60 ? a + (b - a) * (m - 36) / 24 : b + (c - b) * (m - 60) / 36;
  // 最高音部（C7より上）は実測値が無い。弦の周期が接触時間より短くなると基音が鳴らないので、
  // 実機同様にハンマーをさらに小さく硬くして接触時間を縮める
  const top = Math.max(0, m - 90);
  return {
    mh: Math.max(0.5e-3, seg(4.9e-3, 2.97e-3, 2.2e-3) * Math.pow(0.93, top)),  // ハンマー質量 [kg]
    p:  Math.min(3.2, Math.max(2.1, seg(2.3, 2.5, 3.0))),     // フェルトの硬化指数
    K:  Math.pow(10, seg(8.6, 9.65, 11.0) + 0.09 * top),      // フェルトの剛性
    Z:  Math.max(1.5, seg(3.72, 2.06, 1.97)),                 // 弦の特性インピーダンス
    alpha: m < 60 ? 0.12 : 0.12 - 0.0575 * Math.min(1, (m - 60) / 36), // 打弦位置
    // 非調和係数 B（f_n = n·f0·√(1+B·n²)）。中高音は指数的に増え、巻線の最低音部でも増える
    // 最低音部は録音（Yamaha C5）の第4〜20部分音の位置から求めた値（A0 で約2.5×10⁻⁴、C1 で約2×10⁻⁴、C2 で約1×10⁻⁴）
    B: 7.5e-5 * Math.exp(0.068 * (m - 36)) + 2.3e-4 * Math.exp(-0.14 * (m - 21)),
  };
}
// ハンマーと弦の衝突を数値積分し、弦に注入される速度波を求める。
// フェルトは押し込むほど硬くなる（F = K·x^p）ので、強打ほど接触が短く鋭くなり、
// 低音では弦端から戻った波がハンマーを押し返して複数回の接触が起きる
function hammerPulse(f0, v0, P, nStr, hard){
  const os = 4, dt = 1 / (SR * os);
  const T0 = SR * os / f0;
  const dA = Math.max(1, Math.round(P.alpha * T0)), dB = Math.max(1, Math.round((1 - P.alpha) * T0));
  const bufL = new Float32Array(dA), bufR = new Float32Array(dB);
  let iL = 0, iR = 0;
  const Z2 = 2 * P.Z * nStr, K = P.K * hard, p = P.p, mh = P.mh;
  let yh = 0, vh = v0, ys = 0, acc = 0, last = 0;
  const maxN = Math.round(0.025 * SR * os), out = [];
  for (let n = 0; n < maxN; n++){
    const lin = -bufL[iL], rin = -bufR[iR];        // 両端で反転して戻ってきた波
    const comp = yh - ys;
    const F = comp > 0 ? K * Math.pow(comp, p) : 0;
    const u = F / Z2;
    bufL[iL] = u + rin; iL = (iL + 1) % dA;
    bufR[iR] = u + lin; iR = (iR + 1) % dB;
    vh -= F / mh * dt; yh += vh * dt; ys += (u + lin + rin) * dt;
    acc += u;
    if (n % os === os - 1){ out.push(acc / os); acc = 0; }
    if (F > 0) last = n;
    else if (vh < 0 && n - last > 0.0015 * SR * os) break;  // ハンマーが離れて戻っていった
  }
  return Float32Array.from(out.slice(0, Math.ceil(last / os) + 2));
}
// 弦の曲げ剛性による分散を、目標の非調和係数 B に合うオールパス列として設計する。
// 段数 M ごとに「第 nRef 部分音が目標どおりずれる係数 a」を求め、
// 全部分音の予測周波数が f_n = n·f0·√(1+B·n²) に最もよく合う M を選ぶ
function designDispersion(f0, B){
  const w1 = TWO_PI * f0 / SR, P0 = SR / f0;
  const N = Math.min(24, Math.floor(0.32 * SR / f0));
  if (N < 2) return { M: 0, a: 0, err: 0 };
  const tgt = n => Math.sqrt((1 + B * n * n) / (1 + B));     // 目標の伸び率
  const nRef = Math.max(2, Math.min(N, 8));
  const wR = w1 * nRef * tgt(nRef);
  const need = P0 * (1 - 1 / tgt(nRef));
  let best = { M: 0, a: 0, err: Infinity };
  for (let M = 1; M <= 6; M++){
    let prevA = 0, prevD = 0, a = NaN;
    for (let x = -0.01; x >= -0.961; x -= 0.01){
      const d = M * (allpassDelay(x, w1) - allpassDelay(x, wR));
      if (d >= need){ a = prevA + (x - prevA) * (need - prevD) / (d - prevD + 1e-12); break; }
      prevA = x; prevD = d;
    }
    if (!(a < 0)) continue;
    const base = M * allpassDelay(a, w1);
    if (base > 0.5 * P0) continue;
    // この (M, a) で各部分音が実際にどこへ来るかを予測し、目標とのずれ（セント）を評価
    let err = 0;
    for (let n = 2; n <= N; n++){
      let w = w1 * n * tgt(n);
      for (let it = 0; it < 4; it++) w = TWO_PI * n / (P0 - base + M * allpassDelay(a, w));
      const c = 1200 * Math.log2(w / (w1 * n * tgt(n)));
      err += c * c / n;                                     // 低次の部分音ほど重視
    }
    if (err < best.err) best = { M, a, err };
  }
  return best.err === Infinity ? { M: 0, a: 0, err: 0 } : best;
}

const DISP_CACHE = new Map();
const PIANO_STRETCH = [-7.9,-6.3,-5.1,-3.8,-3.1,-2.6,-2.5,-1.8,-1.5,-1.3,-1,-0.4,-0.7,-0.4,0,0.4,0.6,1.1,1.9,2.5,3.1,4.3,5.8,7.3,9,11.3,14.5,18.8,22,25.8];
const PIANO_GAIN = [5.25,4.94,3.30,3.87,3.63,2.67,2.40,2.50,2.79,3.05,2.41,1.32,1.11,1.60,1.76,3.40];

class PianoVoice {
  constructor(o){
    const vel = o.vel;
    // 画面の「ピアノの調整」パネルからの倍率（既定はすべて1）
    const pp = o.pp || {};
    const kKnock = (pp.knock ?? 1) * (o.spec.knockMul ?? 1), kLong = pp.long ?? 1, kInh = pp.inharm ?? 1, kDet = pp.detune ?? 1;
    this.board = pp.board ?? 1;
    const m = 69 + 12 * Math.log2(o.freq / 440);
    // ストレッチ調律：部分音が上ずるぶん、高音は高め・低音は低めに調律されている。
    // この音源の弦の実際の倍音のずれを全鍵で測り、オクターブがうならないように決めた表（3半音ごと、セント）。
    // 高音は 2:1、低音は 4:2 と 6:3 の中間で合わせる（調律師が低音で高い倍音を聴いて合わせるのと同じ）。
    // 以前の近似式では低音のオクターブが 5〜11セント、高音が約3セント広すぎ、うなって調律が狂ったように聞こえた
    const sti = Math.min(PIANO_STRETCH.length - 1.001, Math.max(0, (m - 21) / 3)), st0 = Math.floor(sti);
    const stretch = PIANO_STRETCH[st0] + (PIANO_STRETCH[st0 + 1] - PIANO_STRETCH[st0]) * (sti - st0);
    const f = o.freq * Math.pow(2, stretch / 1200);
    const w = TWO_PI * f / SR, period = SR / f;
    const P = pianoParams(m);
    // 録音に合わせて較正したハンマーの硬さ（剛性の倍率と、フェルトの硬化指数の補正）
    P.K *= o.spec.hK ?? 1; P.p += o.spec.hP ?? 0;
    // 整音（ボイシング）：音域ごとに [鍵, 表層フェルトの硬さ(log10倍率), なめらかさ(ms), 芯の混合比]。録音に合わせて較正
    const vt = o.spec.voicing;
    let vSm = 0, vHard = 0;
    if (vt){
      let j = 0; while (j < vt.length - 2 && m > vt[j + 1][0]) j++;
      const t = Math.min(1, Math.max(0, (m - vt[j][0]) / (vt[j + 1][0] - vt[j][0])));
      P.K *= Math.pow(10, vt[j][1] + (vt[j + 1][1] - vt[j][1]) * t);
      vSm = vt[j][2] + (vt[j + 1][2] - vt[j][2]) * t;
      vHard = (vt[j][3] || 0) + ((vt[j + 1][3] || 0) - (vt[j][3] || 0)) * t;
    }
    this.dead = false; this.f0 = f;

    // 実機同様、最低音部は巻線1本・その上は2本・中音以上は3本の同音弦
    const nStr = m < 31.5 ? 1 : (m < 43.5 ? 2 : 3);
    // 打鍵直後（プロンプト音）の減衰時間：C4で約8秒＝毎秒約7.5dB、高音ほど短い。
    // 複数弦の音ではその後、約3倍長く残るアフターサウンドに移る
    const Tp = Math.min(24, Math.max(0.9, 8 * Math.pow(262 / f, 0.72))) * (o.spec.tpMul ?? 1) * o.decayMul;
    const afterR = o.spec.afterRatio ?? 3;   // アフターサウンドはプロンプト音の何倍ゆっくり減衰するか
    const T60 = Tp * (nStr === 1 ? 1.3 : afterR);
    const loopG = Math.pow(0.001, 1 / (f * T60));
    // 高い部分音ほど速く減衰する度合い（第8部分音が基音の何倍速く減衰するか）。
    // 最低音部の巻線弦では、録音で第24部分音まで毎秒3〜5dBしか減衰しない（損失がほぼ周波数によらない）。
    // 中音と同じ値にしていたため、低音の高い倍音が打鍵後すぐ消え、丸い電子音のような響きになっていた
    // 中音（D#3〜C4）でも録音では各倍音が毎秒10〜20dBでそろって減衰し、高い倍音だけが急に消えることはない
    let lossR = 3 + 2 * (1 - o.bright);
    const lrT = o.spec.lossR;
    if (lrT){ let j = 0; while (j < lrT.length - 2 && m > lrT[j + 1][0]) j++; const t = Math.min(1, Math.max(0, (m - lrT[j][0]) / (lrT[j + 1][0] - lrT[j][0]))); lossR *= lrT[j][1] + (lrT[j + 1][1] - lrT[j][1]) * t; }
    const d = loopDesign(f, T60, lossR);
    // 分散フィルタの設計は鍵ごとに決まるので、一度計算したら使い回す
    const dk = Math.round(f * 100) + '_' + kInh;
    let disp = DISP_CACHE.get(dk);
    if (!disp){ disp = designDispersion(f, P.B * kInh); DISP_CACHE.set(dk, disp); }
    const M = disp.M, a = disp.a;
    const D0 = Math.max(3, period - M * allpassDelay(a, w) - d.lpDelay);

    // ハンマー：鍵盤の強さ → 打弦速度。「明るさ」はフェルトの硬さ。
    // MIDI ベロシティのべき乗に比例させる（Yamaha C5 の16段階の録音で、低音の音量が
    // ベロシティ 13→60→124 で -12dB→0→+7dB になるのに合わせた）。mf（ベロシティ約84）で 2.4m/s
    const vMidi = Math.max(1, (vel - 0.12) / 0.88 * 127);
    const v0 = 2.4 * Math.pow(vMidi / 83.7, 0.92);
    const hardB = Math.pow(10, 1.2 * (o.bright - 0.55));
    let u = hammerPulse(f, v0, P, nStr, hardB);
    // ハンマーのフェルトは2層：柔らかい表層フェルトの下に、ずっと硬い芯（アンダーフェルト）がある。
    // 表層だけだと力の波形がなめらかな山になり、倍音が単調に減っていく。芯の硬い成分が少し混ざると、
    // 低い倍音は表層で決まったまま、高い倍音が平らに残る（録音の C3 付近は、第2倍音から10〜15dB下がった後、
    // -12〜-25dB で平らに続く）。強く叩くほど表層がつぶれて芯が効くので、強打で高域だけが明るくなる
    if (vHard > 0){
      const sp0 = o.spec, PH = Object.assign({}, P, { K: P.K * Math.pow(10, sp0.hardDK ?? 1.5) });
      const uh = hammerPulse(f, v0, PH, nStr, hardB);
      const e = Math.min(0.6, vHard * Math.pow(v0 / 2.4, sp0.hardQ ?? 1));
      const un = new Float32Array(Math.max(u.length, uh.length));
      for (let i = 0; i < un.length; i++) un[i] = (1 - e) * (u[i] || 0) + e * (uh[i] || 0);
      u = un;
    }
    // フェルトの粘弾性（ヒステリシス）とハンマーの柄のたわみで、実際の力の波形はなめらかな山になる。
    // 弦端からの反射でできる鋭いギザギザが残ると、中高域の部分音が強すぎる「弾いた」音になる。
    // 平滑化の時間幅は録音（Steinway B の C4、pp/mf/ff）の部分音スペクトルに合わせて較正した。
    // 強く叩くほどフェルトが締まって短くなり、「明るさ」スライダーでも変わる
    const sp = o.spec;
    const hSm = sp.hSm || vSm;
    if (hSm){
      const tau = hSm * Math.pow(v0 / 2.4, -(sp.hSq || 0)) * Math.pow(262 / f, sp.hSf || 0) * Math.pow(10, -0.6 * (o.bright - 0.55));
      const W = Math.max(1, Math.round(tau * SR / 1000));
      if (W > 1){
        const win = new Float32Array(W); let ws = 0;
        for (let i = 0; i < W; i++){ win[i] = Math.sin(Math.PI * (i + 0.5) / W) ** 2; ws += win[i]; }
        const sm = new Float32Array(u.length + W);
        for (let i = 0; i < u.length; i++){ const ui = u[i] / ws; if (ui) for (let j = 0; j < W; j++) sm[i + j] += ui * win[j]; }
        u = sm;
      }
    }
    // 打弦位置：ブリッジには直接波と、近い側の弦端で反転して戻った波（α周期ぶん遅れ）が届く。
    // その干渉で、打弦点が節になる部分音（n = 1/α の倍数）が欠ける
    // 高音では遅延が1〜2サンプルしかないので、整数に丸めると鍵ごとに音量が6dB単位で跳ぶ。
    // 分数サンプルの遅延として補間する
    const cd = Math.max(1, P.alpha * period), c0 = Math.floor(cd), cf = cd - c0;
    const exc = new Float32Array(u.length + c0 + 2);
    for (let i = 0; i < u.length; i++){
      const v = u[i] * 0.2;
      exc[i] += v; exc[i + c0] -= v * (1 - cf); exc[i + c0 + 1] -= v * cf;
    }
    this.exc = exc; this.i = 0;
    // 打撃点から駒までの距離ぶん（弦の半往復の (1-α) 倍）だけ手前に波を入れる。
    // ループの入口に入れると、波は弦を一周してから駒に届く（C4 で 3.8ms）。本物では約1.7ms で届くので、
    // 以前は「打撃音 → 無音の谷 → 弦の音が一気に最大」という、本物に無い2段の立ち上がりになっていた
    this.injD = Math.max(0, Math.round((1 - P.alpha) * period / 2));

    // 同音弦のわずかな調律ずれ → うなりと「二段減衰」を生む
    // 調律のよいピアノの同音弦のずれは ±0.5セント程度。以前は ±1.4セントで、全部の倍音が一様に揺れて
    // 調律が狂ったピアノのように聞こえていた（録音と比べて部分音の揺れが約2倍）
    const spread = (0.00012 + 0.0002 * Math.min(1, 300 / f)) * kDet;
    this.nAP = M + 1;   // 分散フィルタ列＋分数遅延の補間用オールパス
    this.strings = [];
    for (let k = 0; k < nStr; k++){
      const dt = nStr === 1 ? 0 : ((k / (nStr - 1) - 0.5) * 2 + (Math.random() - 0.5) * 0.4) * spread;
      const Dk = D0 * (1 - dt);
      const Di = Math.max(1, Math.round(Dk - 1));
      const frac = Math.min(1.9, Math.max(0.1, Dk - Di));
      const ac = new Float32Array(M + 1);
      for (let j = 0; j < M; j++) ac[j] = a;
      ac[M] = (1 - frac) / (1 + frac);
      this.strings.push({
        buf: new Float32Array(Di), n: Di, idx: 0, g: d.g, p: d.p, lpy: 0, ac,
        // ハンマーは3本を完全に均等には叩かない。この偏りが逆相モードを励振し、
        // 減衰の遅いアフターサウンドを生む
        eg: 1 + (k - (nStr - 1) / 2) * (o.spec.egAsym ?? 0.14),
        apx: new Float32Array(M + 1), apy: new Float32Array(M + 1), out: 0,
      });
    }
    // ブリッジを介した弦どうしの結合。同相成分だけが約3倍速く減衰し、
    // 逆相成分が長く残ることで「二段減衰（プロンプト音→アフターサウンド）」になる
    this.coupling = nStr > 1 ? (1 - Math.pow(loopG, afterR - 1)) / nStr : 0;
    this.dg = 1;
    this.noDamper = m > 88.5;                           // 最高音部にはダンパーが無い
    // ダンパーのフェルトは弦を一瞬では止めない。低音ほど弦が重く、離鍵後も尾を引く
    // （以前は中音域で0.15秒に設定していて、ギターを手で押さえて止めたような切れ方になっていた）
    this.damperT = (m < 45 ? 1.2 : (m < 70 ? 0.6 : 0.35)) * (pp.release ?? 1);
    this.dc = new DCBlock();
    // 打鍵の衝撃音（ノック）。弦の振動とは別に、響板だけを揺らす2つの成分がある：
    //  ・ハンマーが弦を叩く力そのもの（片側に押す力なので、響板の低いモードを「コツッ」と鳴らす）
    //  ・鍵盤が底（キーベッド）に当たる「トン」という鈍い音。強打ほど目立つ
    // （以前はキーベッドの音を 92Hz と 215Hz の減衰正弦波で作っていたが、これはギターの胴の
    //  空気共鳴・表板共鳴とほぼ同じ周波数で、全ての音にギターの胴鳴りを足していた）
    const kL = Math.round(0.06 * SR), kn = new Float32Array(kL);
    for (let i = 0; i < u.length && i < kL; i++) kn[i] += u[i] * 0.065 * kKnock;
    // キーベッド：鍵盤の木が底のフェルトに当たる、ごく短く鈍い衝撃（特定の音程を持たない）
    const bed = 0.012 * vel * vel * v0 * kKnock, d0 = Math.round(0.002 * SR), bL = Math.round(0.006 * SR);
    let bl = 0;
    for (let i = 0; i < bL; i++){
      bl = 0.93 * bl + 0.07 * (Math.random() * 2 - 1);
      kn[d0 + i] += bed * 6 * bl * Math.sin(Math.PI * i / bL);
    }
    this.kn = kn; this.ki = 0; this.sbIn = 0;
    // 縦振動：横振動の2乗に比例して弦の張力が揺れ、弦の縦方向の固有振動（数kHz）が鳴る。
    // 打鍵の瞬間に「キン」という金属的な前駆音になり、2乗に比例するので強打ほど急激に目立つ。
    // 同じ非線形性で、部分音の和・差の周波数にファントム部分音も出る
    const fL = Math.min(9000, Math.max(500, 4200 * Math.pow(f / 262, 0.6)));
    this.L1 = new Reso(fL, Math.PI * fL * 0.035, 1);
    this.L2 = new Reso(fL * 2.02, Math.PI * fL * 2.02 * 0.02, 0.6);
    this.sqDC = new DCBlock();
    // 2乗の大きさを「この鍵をmfで弾いたときの振幅」で正規化し、全音域で同じ比率にする
    const uRef = hammerPulse(f, 0.45 * Math.pow(11, 0.7), P, nStr, 1);
    let ur = 0; for (let i = 0; i < uRef.length; i++) ur = Math.max(ur, uRef[i]);
    this.sqN = 1 / (ur * 0.2 + 1e-9);
    this.kLong = kLong * 4; this.kPh = kLong * 0.016; this.lng = 0;
    // 響板の放射効率：大きな板でも、波長の長い低い周波数は表と裏で打ち消し合ってほとんど放射されない。
    // そのため実際のピアノの低音は基音が弱く、倍音の方が強く聞こえる（録音で C2 の倍音は基音より15〜25dB強い）。
    // ただし 180Hz では F#2〜C3 の基音まで削れて低音が薄くなったので、100Hz に下げた（Yamaha C5 の録音で F#2・C3 の基音は最大の部分音）
    this.rad = null;
    const rf = o.spec.radHz;
    if (rf){
      const w = TWO_PI * rf / SR, cw = Math.cos(w), al = Math.sin(w) / (2 * 0.6), a0 = 1 + al;
      this.rad = { b0: (1 + cw) / 2 / a0, b1: -(1 + cw) / a0, b2: (1 + cw) / 2 / a0, a1: -2 * cw / a0, a2: (1 - al) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
    }
    // 鍵盤全域で聴感上の音量をそろえる補正（6半音ごとの実測値を補間）
    const gi = Math.min(PIANO_GAIN.length - 1.001, Math.max(0, (m - 21) / 6)), g0 = Math.floor(gi);
    this.gain = 0.2 / Math.sqrt(nStr) * (PIANO_GAIN[g0] + (PIANO_GAIN[g0 + 1] - PIANO_GAIN[g0]) * (gi - g0));
    // フレーム・リムの共鳴（KnockBank）への入力＝ハンマーの力の波形。高音ほど相対的に大きい
    const kbT = o.spec.knockBank, kbI = kbT ? Math.min(kbT.length - 1.001, Math.max(0, (m - 21) / 12)) : 0, kb0 = Math.floor(kbI);
    const kbG = kbT ? (kbT[kb0] + (kbT[kb0 + 1] - kbT[kb0]) * (kbI - kb0)) * this.gain * kKnock : 0;
    this.kb = new Float32Array(kbG ? u.length : 0);
    for (let i = 0; i < this.kb.length; i++) this.kb[i] = u[i] * kbG;
    this.kbi = 0; this.kbOut = 0;
  }
  // 損失は弦の1往復につき1回掛かるので、往復あたりの係数に換算する
  noteOff(){ if (!this.noDamper) this.dg = Math.pow(0.001, 1 / (this.f0 * this.damperT)); }
  tick(){
    const x = this.i < this.exc.length ? this.exc[this.i++] : 0;
    const st = this.strings, nAP = this.nAP;
    let sum = 0;
    for (let k = 0; k < st.length; k++){
      const s = st[k];
      let y = s.buf[s.idx];                      // 弦を一周してきた波（整数サンプル遅延）
      y = s.lpy = (1 - s.p) * y + s.p * s.lpy;   // 高次部分音ほど速く減衰
      y *= s.g;
      const apx = s.apx, apy = s.apy, ac = s.ac; // 分散フィルタ列＝弦の剛性
      for (let j = 0; j < nAP; j++){
        const am = ac[j], inp = y;
        y = am * inp + apx[j] - am * apy[j];
        apx[j] = inp; apy[j] = y;
      }
      s.out = y; sum += y;
    }
    const bridge = sum * this.coupling, dg = this.dg;
    for (let k = 0; k < st.length; k++){
      const s = st[k];
      s.buf[s.idx] = (s.out - bridge) * dg;
      // 打撃の波は injD サンプル後に駒へ届く位置に足し込む
      if (x){ let j = s.idx + Math.min(this.injD, s.n - 1); if (j >= s.n) j -= s.n; s.buf[j] += x * s.eg; }
      if (++s.idx === s.n) s.idx = 0;
    }
    const sq = this.sqDC.tick(sum * sum * this.sqN);
    const lng = (this.L1.tick(sq) + this.L2.tick(sq)) * this.kLong + sq * this.kPh;
    this.lng = lng;
    let y = this.dc.tick(sum + lng) * this.gain;
    const rd = this.rad;
    if (rd){
      const o2 = rd.b0 * y + rd.b1 * rd.x1 + rd.b2 * rd.x2 - rd.a1 * rd.y1 - rd.a2 * rd.y2;
      rd.x2 = rd.x1; rd.x1 = y; rd.y2 = rd.y1; rd.y1 = o2; y = o2;
    }
    // 響板への入力＝弦の振動＋打鍵のノック（ノックは直接音には混ぜない）
    this.kbOut = this.kbi < this.kb.length ? this.kb[this.kbi++] : 0;
    const yb = y * this.board;
    this.sbIn = this.ki < this.kn.length ? yb + this.kn[this.ki++] : yb;
    return y;
  }
}

// 響板：ブリッジの振動を空気に放射する大きな木の板。48個の共鳴が密に並び、
// ピアノの「箱の響き」を作る（全ピアノ音で1枚を共有する）
// ピアノの音の出口の配分：弦からの直接成分（dry）と響板の共鳴成分（board）
const PIANO_MIX = { dry: 0.8, board: 1 };
class Soundboard {
  constructor(){
    let seed = 20241;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    // 低域（〜200Hz）はモードがまばらで1つ1つが鳴り分かれ、それより上は密に重なり合って
    // 滑らかな応答になる。モードが粗いと鍵ごとに特定の部分音だけが強調／欠落して音色がばらつく
    const N = 96;
    this.rs = []; this.gl = new Float32Array(N); this.gr = new Float32Array(N);
    for (let i = 0; i < N; i++){
      const f = 48 * Math.pow(6000 / 48, (i + 0.5 + 0.6 * (rnd() - 0.5)) / N);
      const q = Math.max(4, 26 * Math.pow(100 / Math.max(100, f), 0.5));
      // 駒（駆動点）から見た響板の応答は全モードが同じ符号で寄与する。符号がばらばらだと
      // 重なり合ったモード同士が打ち消し合って深い谷ができる
      const g = Math.pow(f / 150, -0.2) * (0.7 + 0.6 * rnd());
      this.rs.push(new Reso(f, q, g));
      const pan = 0.25 + 0.5 * rnd();       // モードごとに放射の向きが違う → 自然な広がり
      this.gl[i] = Math.cos(pan * Math.PI / 2) * Math.SQRT2; this.gr[i] = Math.sin(pan * Math.PI / 2) * Math.SQRT2;
    }
    this.l = 0; this.r = 0; this.norm = 1;
    this.hk = 1 - Math.exp(-TWO_PI * 5000 / SR); this.hlp = 0;
    // 白色入力に対する利得が一定になるよう正規化
    const bgSave = PIANO_MIX.board; PIANO_MIX.board = 1;   // 正規化は配分と無関係に行う
    let e = 0; this.tick(1); e += this.l * this.l;
    for (let i = 0; i < 8000; i++){ this.tick(0); e += this.l * this.l; }
    PIANO_MIX.board = bgSave;
    this.norm = 0.24 / Math.sqrt(e);
    for (const r of this.rs){ r.y1 = 0; r.y2 = 0; }
    this.hlp = 0;
  }
  tick(x){
    const rs = this.rs, gl = this.gl, gr = this.gr;
    let l = 0, r = 0;
    for (let i = 0; i < rs.length; i++){ const y = rs[i].tick(x); l += y * gl[i]; r += y * gr[i]; }
    // 5kHz より上はモードが完全に重なり合って平坦に放射される。素通しの経路で表す
    this.hlp += this.hk * (x - this.hlp);
    const hi = 0.3 * (x - this.hlp);
    const bg = PIANO_MIX.board;
    this.l = (l * this.norm + hi) * bg; this.r = (r * this.norm + hi) * bg;
  }
}

// 打鍵の衝撃で鳴る、鉄骨フレーム・リム・弦の駒外の部分（デュープレックス）などの共鳴。
// 弦の倍音と倍音の間の周波数を埋める「打鍵のざわめき」で、録音（Steinway・Yamaha とも）では
// 倍音の間の帯域に、最大の帯の -20〜-30dB ほどのエネルギーが 0.1秒以上残る。
// これが無いと倍音だけが澄んで並ぶ、はじいた弦や電子音のような音になる（全ピアノ音で共有）
class KnockBank {
  constructor(){
    let seed = 7741;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const N = 40;
    this.rs = []; this.gl = new Float32Array(N); this.gr = new Float32Array(N);
    for (let i = 0; i < N; i++){
      const f = 70 * Math.pow(3500 / 70, (i + 0.5 + 0.8 * (rnd() - 0.5)) / N);
      const T60 = Math.min(0.45, Math.max(0.08, 0.3 * Math.pow(300 / f, 0.35))) * (0.7 + 0.6 * rnd());
      const q = Math.PI * f * T60 / 6.91;
      const g = (f < 300 ? 1 : Math.pow(300 / f, 0.5)) * (0.6 + 0.8 * rnd()) * (rnd() < 0.5 ? -1 : 1);
      this.rs.push(new Reso(f, q, g));
      const pan = rnd();
      this.gl[i] = Math.cos(pan * Math.PI / 2) * Math.SQRT2; this.gr[i] = Math.sin(pan * Math.PI / 2) * Math.SQRT2;
    }
    // インパルス応答のエネルギーを1にそろえる
    this.norm = 1; this.l = 0; this.r = 0;
    let e = 0; this.tick(1); e += this.l * this.l;
    for (let i = 0; i < SR; i++){ this.tick(0); e += this.l * this.l; }
    this.norm = 1 / Math.sqrt(e);
    for (const r of this.rs){ r.y1 = 0; r.y2 = 0; }
    this.l = 0; this.r = 0;
  }
  tick(x){
    const rs = this.rs, gl = this.gl, gr = this.gr;
    let l = 0, r = 0;
    for (let i = 0; i < rs.length; i++){ const y = rs[i].tick(x); l += y * gl[i]; r += y * gr[i]; }
    this.l = l * this.norm; this.r = r * this.norm;
  }
}

// 共鳴弦：ペダルを踏むと全弦のダンパーが上がり、弾いていない弦もブリッジ経由で共鳴する。
// 最高音部の弦はダンパーが無いので常に共鳴している
class Sympathetic {
  constructor(){
    this.s = [];
    for (let m = 31; m <= 106; m += 3){
      const f = 440 * Math.pow(2, (m - 69) / 12) * (1 + (m % 2 ? 0.0006 : -0.0005));
      const D = Math.max(2, Math.round(SR / f - 0.5));
      const T = Math.min(6, Math.max(1.2, 9 * Math.pow(55 / f, 0.45)));
      this.s.push({ buf: new Float32Array(D + 1), n: D + 1, w: 0, z: 0,
        g: Math.pow(0.001, 1 / (f * T)), gd: Math.pow(0.001, 1 / (f * 0.18)),
        open: m > 88, pan: (m - 31) / 75 });
    }
    this.l = 0; this.r = 0;
  }
  tick(x, pedal){
    const ss = this.s, inp = x * 0.0016;
    let l = 0, r = 0;
    for (let i = 0; i < ss.length; i++){
      const q = ss[i], up = pedal || q.open;
      const y0 = q.buf[q.w];                       // D サンプル前
      const y = (up ? q.g : q.gd) * 0.5 * (y0 + q.z); q.z = y0;
      q.buf[q.w] = y + (up ? inp : 0);
      q.w = q.w + 1 === q.n - 1 ? 0 : q.w + 1;
      l += y * (1 - q.pan); r += y * q.pan;
    }
    this.l = l; this.r = r;
  }
}

