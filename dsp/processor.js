
/* ---------- リバーブ（Freeverb系 簡略版） ---------- */
class Comb {
  constructor(len){ this.buf = new Float32Array(len); this.i = 0; this.lp = 0; }
  tick(x){
    const y = this.buf[this.i];
    this.lp = y * 0.7 + this.lp * 0.3;
    this.buf[this.i] = x + this.lp * 0.82;
    this.i = (this.i + 1) % this.buf.length;
    return y;
  }
}
class APass {
  constructor(len){ this.buf = new Float32Array(len); this.i = 0; }
  tick(x){
    const y = this.buf[this.i];
    this.buf[this.i] = x + y * 0.5;
    this.i = (this.i + 1) % this.buf.length;
    return y - x;
  }
}
class Reverb {
  constructor(){
    const s = SR / 44100;
    const mk = a => a.map(n => Math.max(2, Math.round(n * s)));
    this.cL = mk([1116,1188,1277,1356]).map(n => new Comb(n));
    this.cR = mk([1139,1211,1300,1379]).map(n => new Comb(n));
    this.aL = mk([556,441]).map(n => new APass(n));
    this.aR = mk([579,464]).map(n => new APass(n));
    this.l = 0; this.r = 0;
  }
  tick(x){
    const inp = x * 0.25;
    let l = 0, r = 0;
    for (let i = 0; i < 4; i++){ l += this.cL[i].tick(inp); r += this.cR[i].tick(inp); }
    for (let i = 0; i < 2; i++){ l = this.aL[i].tick(l); r = this.aR[i].tick(r); }
    this.l = l; this.r = r;
  }
}

/* ---------- プロセッサ本体 ---------- */
const MAX_VOICES = 40;
// ピアノのケース・屋根・リムでの反射による拡散。周波数特性は変えず（オールパス）、
// 弦1周期ごとの鋭いパルスを時間方向にならして、録音どおり10〜15msかけて膨らむ立ち上がりにする
class Diffuser {
  constructor(delaysMs, g){
    this.g = g;
    this.st = delaysMs.map(d => ({ buf: new Float32Array(Math.max(1, Math.round(d * SR / 1000))), p: 0 }));
  }
  tick(x){
    const g = this.g;
    for (let k = 0; k < this.st.length; k++){
      const s = this.st[k], b = s.buf[s.p], w = x + g * b;
      x = b - g * w; s.buf[s.p] = w;
      if (++s.p === s.buf.length) s.p = 0;
    }
    return x;
  }
}
function makeVoice(m, spec){
  const o = { freq: m.freq, vel: m.vel, bright: m.bright, decayMul: m.decayMul, spec, pp: m.pp };
  if (spec.type === 'pluck') return new StringVoice(o);
  if (spec.type === 'piano') return new PianoVoice(o);
  if (spec.type === 'modal') return new ModalVoice(o);
  if (spec.type === 'flute') return new FluteVoice(o);
  if (spec.type === 'reed') return new ReedVoice(o);
  if (spec.type === 'brass') return new BrassVoice(o);
  return new BowedVoice(o);
}
class PMSynth extends AudioWorkletProcessor {
  constructor(){
    super();
    this.voices = new Map(); // id -> voice（発音中でnoteOff待ち）
    this.list = [];          // 鳴っている全ボイス
    this.verb = new Reverb();
    this.wet = 0.25;
    this.bL = new Float32Array(128); this.bR = new Float32Array(128);
    this.bP = new Float32Array(128);   // ピアノのブリッジ信号（響板・共鳴弦への入力）
    this.bK = new Float32Array(128);   // フレーム・リムの共鳴への入力
    this.sb = new Soundboard(); this.sym = new Sympathetic(); this.kbk = new KnockBank(); this.pedal = false;
    this.pnL = new Float32Array(128); this.pnR = new Float32Array(128);   // ピアノの音の通り道
    this.dfL = new Diffuser([1.1, 1.7, 2.9, 4.3], 0.7); this.dfR = new Diffuser([1.3, 1.9, 3.1, 4.7], 0.7);
    // 立体音響：ピアノを7つの音源（弦の5か所＝低音〜高音、響板の左右）に分けて別の出力に出し、
    // メインスレッドで頭部伝達関数（HRTF）により空間に配置する
    this.spatial = false;
    this.zb = []; this.zdf = [];
    for (let z = 0; z < 7; z++){
      this.zb.push(new Float32Array(128));
      this.zdf.push(new Diffuser([1.1, 1.7, 2.9, 4.3].map((d, k) => d * (1 + 0.07 * z + 0.013 * k)), 0.7));
    }
    this.frame = 0;
    // MIDI 再生用：時刻つきイベントの待ち行列と、16チャンネルぶんの状態
    this.q = []; this.qi = 0; this.prepI = 0;
    this.resetChannels();
    // 起動時に各音源を一度ずつ空回しして JIT コンパイルを済ませておく。
    // しないと最初に鳴らした瞬間だけ計算が遅く、音が途切れる
    for (const inst of ['piano', 'guitar', 'violin', 'flute', 'clarinet', 'trumpet', 'marimba', 'gm_snare', 'gm_hhc']){
      const v = makeVoice({ freq: 262, vel: 0.5, bright: 0.5, decayMul: 1 }, SPECS[inst]);
      for (let i = 0; i < 1024; i++){ v.tick(); if (v.sbIn !== undefined){ this.sb.tick(v.sbIn); this.sym.tick(v.sbIn, false); } }
    }
    this.sb = new Soundboard(); this.sym = new Sympathetic(); this.kbk = new KnockBank();
    this.port.onmessage = e => {
      const m = e.data;
      if (m.type === 'noteOn') this.noteOn(m);
      else if (m.type === 'noteOff') this.noteOff(m);
      else if (m.type === 'allOff'){
        for (const v of this.list) v.noteOff();
        this.voices.clear();
      } else if (m.type === 'wet') this.wet = m.value;
      else if (m.type === 'spatial') this.spatial = !!m.on;
      else if (m.type === 'pedal') this.pedal = !!m.on;
      else if (m.type === 'sched'){
        // 届いたイベントを時刻順の待ち行列に足す（先頭の処理済み分は捨てる）
        if (this.qi > 0){ this.q = this.q.slice(this.qi); this.qi = 0; }
        for (const ev of m.events) this.q.push(ev);
        this.q.sort((a, b) => a.f - b.f || a.o - b.o);
        this.prepI = 0;
      } else if (m.type === 'stop'){
        this.q = []; this.qi = 0; this.prepI = 0;
        const fast = Math.pow(0.001, 1 / (0.08 * SR));
        for (const v of this.list) if (v.ch >= 0) v.kG = fast;   // MIDI の音だけ素早く消す
        for (const [k, v] of this.voices) if (v.ch >= 0) this.voices.delete(k);
        this.resetChannels();
      }
    };
  }
  resetChannels(){
    this.chG = new Float32Array(16).fill(Math.pow(100 / 127, 2));   // 音量×エクスプレッション
    this.chVol = new Float32Array(16).fill(100); this.chExp = new Float32Array(16).fill(127);
    this.chSus = new Uint8Array(16);
    this.chPend = []; for (let c = 0; c < 16; c++) this.chPend.push([]);
    this.midiPedal = false;
  }
  noteOff(m){
    const v = this.voices.get(m.id);
    if (!v) return;
    // サステインペダルが踏まれているチャンネルでは、ペダルを離すまで止めない
    if (m.ch >= 0 && this.chSus[m.ch]){ this.chPend[m.ch].push(m.id); return; }
    v.noteOff(); v.rel = true; this.voices.delete(m.id);
  }
  cc(ev){
    const c = ev.ch;
    if (ev.vol !== undefined) this.chVol[c] = ev.vol;
    if (ev.expr !== undefined) this.chExp[c] = ev.expr;
    // GM 推奨の音量カーブ：(値/127)^2
    this.chG[c] = Math.pow(this.chVol[c] / 127, 2) * Math.pow(this.chExp[c] / 127, 2);
    if (ev.sus !== undefined){
      const on = ev.sus >= 64;
      if (!on && this.chSus[c]){
        this.chSus[c] = 0;
        for (const id of this.chPend[c]) this.noteOff({ id, ch: c });
        this.chPend[c] = [];
      }
      this.chSus[c] = on ? 1 : 0;
      let any = false; for (let k = 0; k < 16; k++) if (this.chSus[k]) any = true;
      this.midiPedal = any;
    }
  }
  noteOn(m){
    const old = this.voices.get(m.id);
    if (old){ old.noteOff(); old.rel = true; this.voices.delete(m.id); }
    const spec = SPECS[m.inst];
    if (!spec) return;
    const fast = Math.pow(0.001, 1 / (0.04 * SR));
    // ハイハットのオープン／クローズのように、同じ組の前の音を止める
    if (m.choke) for (const v of this.list) if (v.choke === m.choke && v.ch === m.ch) v.kG = fast;
    // ボイス上限：離鍵済みの古い音から優先して素早く消す
    let active = 0; for (const v of this.list) if (v.kG === 1) active++;
    if (active >= MAX_VOICES){
      let victim = null;
      for (const v of this.list) if (v.kG === 1 && v.rel){ victim = v; break; }
      if (!victim) for (const v of this.list) if (v.kG === 1){ victim = v; break; }
      if (victim){ victim.kG = fast; for (const [k, vv] of this.voices) if (vv === victim) this.voices.delete(k); }
    }
    // 予約再生の音は、発音時刻より前に準備済み（prep）のことが多い
    const v = m.pre || makeVoice(m, spec);
    m.pre = null;
    v.kEnv = 1; v.kG = 1; v.pk = 1; v.pkb = 1; v.age = 0; v.rel = false;
    v.isPiano = spec.type === 'piano';
    v.ch = m.ch === undefined ? -1 : m.ch;
    v.choke = m.choke || 0;
    v.amp = m.amp || 1;
    v.cg = v.ch >= 0 ? this.chG[v.ch] : 1;
    // 定位：MIDI ではチャンネルのパン、鍵盤演奏では音高に応じた配置（低音が左・高音が右）
    const sprd = spec.spread === undefined ? 0.3 : spec.spread;
    let pos = 0.5 + sprd * Math.log2(m.freq / 330) / 7;
    if (m.pan !== undefined) pos = m.pan + 0.4 * (pos - 0.5);
    pos = Math.min(0.95, Math.max(0.05, pos));
    v.pL = Math.cos(pos * Math.PI / 2) * Math.SQRT2;
    v.pR = Math.sin(pos * Math.PI / 2) * Math.SQRT2;
    if (v.isPiano){
      // 弦の位置：鍵盤の低い方から高い方へ5つの音源に振り分ける（隣り合う2つに等パワーで配分）
      const zp = Math.min(3.999, Math.max(0, (69 + 12 * Math.log2(m.freq / 440) - 21) / 87 * 4)), z0 = Math.floor(zp), zf = zp - z0;
      v.zA = z0; v.zB = z0 + 1; v.zwA = Math.cos(zf * Math.PI / 2); v.zwB = Math.sin(zf * Math.PI / 2);
    }
    this.voices.set(m.id, v);
    this.list.push(v);
  }
  // [i0, i1) の区間だけ全ボイスを鳴らす（イベントの時刻で区間を区切ってサンプル単位で発音する）
  renderVoices(i0, i1){
    const bL = this.bL, bR = this.bR, bP = this.bP, bK = this.bK, pnL = this.pnL, pnR = this.pnR, len = i1 - i0, sp = this.spatial;
    for (let vi = 0; vi < this.list.length; vi++){
      const v = this.list[vi];
      // ピアノは弦の直接成分に、響板の共鳴を重ねる（共鳴が強すぎると鍵ごとに音色がばらつく）
      const dry = v.isPiano ? PIANO_MIX.dry : 1, toP = v.isPiano ? 1 : 0;
      // チャンネル音量の変化はなめらかに追従させる（急に変えるとプチッと鳴る）
      const gT = v.ch >= 0 ? this.chG[v.ch] : 1, gStep = (gT - v.cg) / len;
      let g = v.cg, pk = v.pkb;
      const pL = v.pL * dry, pR = v.pR * dry;
      const zA = sp && toP ? this.zb[v.zA] : null, zB = zA ? this.zb[v.zB] : null, wA = (v.zwA || 0) * dry, wB = (v.zwB || 0) * dry;
      for (let i = i0; i < i1; i++){
        const k = v.kEnv * g * v.amp;
        const s = v.tick() * k;
        v.kEnv *= v.kG; g += gStep;
        if (toP){ if (zA){ zA[i] += s * wA; zB[i] += s * wB; } else { pnL[i] += s * pL; pnR[i] += s * pR; } bP[i] += v.sbIn * k; bK[i] += v.kbOut * k; }
        else { bL[i] += s * pL; bR[i] += s * pR; }
        const a = s < 0 ? -s : s;
        if (a > pk) pk = a;
      }
      v.cg = gT; v.pkb = pk;
    }
  }
  process(inputs, outputs){
    const tStart = Date.now();
    const out = outputs[0];
    const L = out[0], R = out.length > 1 ? out[1] : out[0];
    const n = L.length;
    this.bL.fill(0); this.bR.fill(0); this.bP.fill(0); this.bK.fill(0); this.pnL.fill(0); this.pnR.fill(0);
    for (const z of this.zb) z.fill(0);
    for (const v of this.list) v.pkb = v.pk;
    const base = currentFrame;
    // 和音の頭で多数の音が同時に鳴り始めると、その準備計算が1ブロックに集中して音が途切れる。
    // 1.5秒先までの発音を、1ブロックあたり最大3音ずつ前もって準備しておく
    let prepped = 0;
    if (this.prepI < this.qi) this.prepI = this.qi;
    while (this.prepI < this.q.length && prepped < 3){
      const ev = this.q[this.prepI];
      if (ev.f > base + 1.5 * SR) break;
      if (ev.k === 'on' && !ev.pre && SPECS[ev.inst]){ ev.pre = makeVoice(ev, SPECS[ev.inst]); prepped++; }
      this.prepI++;
    }
    // このブロック内に時刻が来たイベントを、その位置で区間を区切って処理する
    let cur = 0;
    while (this.qi < this.q.length && this.q[this.qi].f < base + n){
      const ev = this.q[this.qi++];
      const at = Math.min(n, Math.max(0, ev.f - base));
      if (at > cur){ this.renderVoices(cur, at); cur = at; }
      if (ev.k === 'on') this.noteOn(ev);
      else if (ev.k === 'off') this.noteOff(ev);
      else this.cc(ev);
    }
    if (cur < n) this.renderVoices(cur, n);
    for (let vi = this.list.length - 1; vi >= 0; vi--){
      const v = this.list[vi];
      v.pk = v.pkb * 0.994;
      v.age += n;
      if (v.dead || v.kEnv < 1e-3 || !(v.pkb < 50) || (v.age > SR * 0.4 && v.pk < 1e-4)){
        this.list.splice(vi, 1);
        for (const [k, vv] of this.voices) if (vv === v) this.voices.delete(k);
      }
    }
    const bL = this.bL, bR = this.bR, bP = this.bP, bK = this.bK, kbk = this.kbk;
    const pedal = this.pedal || this.midiPedal;
    const wet = this.wet, MASTER = 0.5;   // 和音でも飽和しない余裕を残す（音量は後段で稼ぐ）
    const ZO = this.spatial && outputs[1] && outputs[1].length >= 7 ? outputs[1] : null;
    if (!ZO && outputs[1]) for (const ch of outputs[1]) ch.fill(0);
    for (let i = 0; i < n; i++){
      const pb = bP[i] > -50 && bP[i] < 50 ? bP[i] : 0;
      this.sb.tick(pb); this.sym.tick(pb, pedal);
      kbk.tick(bK[i] > -50 && bK[i] < 50 ? bK[i] : 0);
      // ピアノの音（直接成分＋響板＋共鳴弦）はケースでの拡散を通してから混ぜる
      let pl, pr;
      if (ZO){
        // 立体音響：弦の5音源と響板の左右を別々に出力（ケースでの拡散は音源ごとに）
        for (let z = 0; z < 5; z++){ const v = this.zdf[z].tick(this.zb[z][i]) * MASTER; ZO[z][i] = v > -5 && v < 5 ? v : 0; }
        const bl = this.zdf[5].tick(this.sb.l + this.sym.l + kbk.l) * MASTER, br = this.zdf[6].tick(this.sb.r + this.sym.r + kbk.r) * MASTER;
        ZO[5][i] = bl > -5 && bl < 5 ? bl : 0; ZO[6][i] = br > -5 && br < 5 ? br : 0;
        pl = 0; pr = 0;
      } else {
        pl = this.dfL.tick(this.pnL[i] + this.sb.l + this.sym.l + kbk.l); pr = this.dfR.tick(this.pnR[i] + this.sb.r + this.sym.r + kbk.r);
      }
      let l = bL[i] + pl, r = bR[i] + pr;
      if (!(l > -50 && l < 50)) l = 0;
      if (!(r > -50 && r < 50)) r = 0;
      this.verb.tick(0.5 * (l + r));
      L[i] = Math.tanh((l + wet * this.verb.l) * MASTER);
      R[i] = Math.tanh((r + wet * this.verb.r) * MASTER);
    }
    // 処理負荷の計測：1ブロック（128サンプル≒2.9ms）の計算にかかった時間
    const dt = Date.now() - tStart;
    this.busy = (this.busy || 0) + dt; this.maxDt = Math.max(this.maxDt || 0, dt);
    if (++this.frame % 128 === 0){
      const span = 128 * 128 / SR * 1000;
      this.port.postMessage({ type:'voices', n: this.list.length, q: this.q.length - this.qi,
        load: this.busy / span, maxDt: this.maxDt });
      this.busy = 0; this.maxDt = 0;
    }
    return true;
  }
}
registerProcessor('pm-synth', PMSynth);
