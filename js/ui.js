const INSTS = [
  { id:'guitar',  name:'ギター',       em:'🎸', model:'パルス波励振の2偏波弦＋胴の空気共鳴・表板共鳴',              bright:.60, decay:.50 },
  { id:'koto',    name:'琴',           em:'🎋', model:'爪による駒寄りの撥弦（2偏波弦）＋桐の胴の共鳴',              bright:.75, decay:.50 },
  { id:'harp',    name:'ハープ',       em:'🪉', model:'指による中央寄りの撥弦（2偏波弦）＋響板',                    bright:.45, decay:.55 },
  { id:'shamisen',name:'三味線',       em:'🪕', model:'撥による鋭い撥弦＋皮張りの胴（膜共鳴と撥が皮を打つ音）',    bright:.75, decay:.50 },
  { id:'piano',   name:'ピアノ',       em:'🎹', model:'フェルトハンマーの衝突計算×非調和な結合弦＋48モード響板＋共鳴弦',  bright:.55, decay:.50 },
  { id:'epiano',  name:'エレピ',       em:'⚡', model:'音叉（タイン）のモード合成＋電磁ピックアップの非線形',      bright:.55, decay:.50 },
  { id:'marimba', name:'マリンバ',     em:'🪵', model:'木製音板のモード (1 : 4 : 10) ＋基音に同調した共鳴管',      bright:.55, decay:.50 },
  { id:'vibes',   name:'ビブラフォン', em:'✨', model:'金属音板のモード＋回転ファンのトレモロ',                    bright:.50, decay:.55 },
  { id:'glocken', name:'グロッケン',   em:'⭐', model:'鋼鉄の一様棒の曲げモード (1 : 2.76 : 5.40 …)',              bright:.75, decay:.50 },
  { id:'musicbox',name:'オルゴール',   em:'🎠', model:'片持ち梁（櫛歯）のモード 1 : 6.3 : 17.6',                   bright:.75, decay:.50 },
  { id:'bell',    name:'鐘',           em:'🔔', model:'鐘の部分音＋非対称性による縮退モード対のうなり',            bright:.50, decay:.55 },
  { id:'drum',    name:'ドラム',       em:'🥁', model:'円形膜のモード＋張力変調によるピッチの上ずり＋スティックの打撃音',          bright:.50, decay:.50 },
  { id:'flute',   name:'フルート',     em:'🪈', model:'気柱導波管＋ジェット非線形＋息の雑音（押している間持続）',  bright:.50, decay:.50 },
  { id:'clarinet',name:'クラリネット', em:'🎷', model:'リード弁の非線形＋閉管導波管（奇数倍音が主体）',            bright:.50, decay:.50 },
  { id:'trumpet', name:'トランペット', em:'🎺', model:'唇の共振弁＋管の導波管（強く吹くほど倍音が増える）',        bright:.50, decay:.50 },
  { id:'violin',  name:'バイオリン',   em:'🎻', model:'弓・弦の摩擦導波管＋胴の共鳴（f字孔・駒）',                 bright:.55, decay:.50 },
  { id:'cello',   name:'チェロ',       em:'🎻', model:'弓・弦の摩擦導波管＋大型の胴（鍵盤より1オクターブ下）',     bright:.55, decay:.50 },
];
let cur = INSTS[0];

/* --- ピアノの調整パネル：物理モデルの各要素の強さ（倍率） --- */
const PT_DEFS = [
  ['knock',   '打撃音（ハンマー・鍵盤の衝撃）', 0, 3],
  ['long',    '金属的なアタック（弦の縦振動）', 0, 3],
  ['inharm',  '非調和性（弦の硬さ）',         0, 3],
  ['detune',  'うなり（同音弦の調律ずれ）',    0, 3],
  ['board',   '響板の響き',                  0, 2],
  ['release', '離鍵後の余韻',                0.3, 3],
];
const pianoPP = {};
function ptLoad(){
  try {
    const o = JSON.parse(localStorage.getItem('pianoPP') || '{}');
    // 打撃音の標準を 0.3 倍にした（v2）。以前保存した値は、同じ音になるよう換算する。
    // 既定値（1）のままなら新しい標準（以前の 0.3 倍）をそのまま使い、動かしていた場合だけ換算する
    if (!o._v){ if (typeof o.knock === 'number' && Math.abs(o.knock - 1) > 1e-6) o.knock = Math.min(3, o.knock / 0.3); o._v = 2; localStorage.setItem('pianoPP', JSON.stringify(o)); }
    return o;
  } catch (e){ return {}; }
}
function ptSave(){ try { localStorage.setItem('pianoPP', JSON.stringify(Object.assign({ _v: 2 }, pianoPP))); } catch (e){} }
function ptBuild(){
  const saved = ptLoad(), box = document.getElementById('ptSliders');
  box.innerHTML = '';
  for (const [k, label, lo, hi] of PT_DEFS){
    pianoPP[k] = typeof saved[k] === 'number' ? saved[k] : 1;
    const d = document.createElement('div'); d.className = 'ctl';
    d.innerHTML = `<label>${label} <output>×${pianoPP[k].toFixed(2)}</output></label><input type="range" min="${lo}" max="${hi}" step="0.05" value="${pianoPP[k]}">`;
    const inp = d.querySelector('input'), out = d.querySelector('output');
    inp.addEventListener('input', () => { pianoPP[k] = +inp.value; out.textContent = '×' + pianoPP[k].toFixed(2); ptSave(); });
    box.appendChild(d);
  }
}
ptBuild();
document.getElementById('ptReset').addEventListener('click', () => {
  for (const [k] of PT_DEFS) pianoPP[k] = 1;
  ptSave(); ptBuild();
});
let baseNote = 60; // C4
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

/* --- Audio --- */
let ctx = null, node = null, analyser = null, gainNode = null, audioReady = null;
function showAudioError(msg){
  let b = document.getElementById('audioErr');
  if (!b){
    b = document.createElement('div'); b.id = 'audioErr';
    b.style.cssText = 'background:#3a1620;border:1px solid #a33;color:#ffd6dc;padding:10px 14px;border-radius:10px;margin:0 auto 10px;max-width:1030px;font-size:13px;';
    document.querySelector('.wrap').prepend(b);
  }
  b.textContent = msg;
}
// AudioWorklet 内で動く音源コード（この順につなげる）
const DSP_FILES = ['dsp/core.js', 'dsp/pluck.js', 'dsp/piano.js', 'dsp/modal.js', 'dsp/drums.js', 'dsp/winds.js', 'dsp/bowed.js', 'dsp/specs.js', 'dsp/processor.js'];
const VOL_SCALE = 2.3;
function initAudio(){
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  // Safari などはクリック直後に同期で resume しないと再生が許可されない。
  // モジュール読み込みを待ってからだと「操作の直後」とみなされず無音になる
  ctx.resume();
  if (!ctx.audioWorklet){
    showAudioError('このブラウザは AudioWorklet に対応していないため音を出せません。最新の Chrome / Edge / Safari / Firefox で開いてください。');
    return Promise.reject(new Error('AudioWorklet unsupported'));
  }
  // 音源の DSP は楽器ごとのファイルに分かれている。順につなげて1つのモジュールとして読み込む
  // （同じスコープで動く前提で書かれているため。file:// では読めないので、HTTP サーバー経由で開く）
  return Promise.all(DSP_FILES.map(f => fetch(f).then(r => { if (!r.ok) throw new Error(f + ' を読み込めません（' + r.status + '）'); return r.text(); })))
    .then(parts => ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([parts.join('')], { type: 'application/javascript' }))))
    .then(() => {
    node = new AudioWorkletNode(ctx, 'pm-synth', { numberOfOutputs: 2, outputChannelCount: [2, 7] });
    node.port.onmessage = e => {
      if (e.data.type === 'voices'){
        document.getElementById('voiceN').textContent = e.data.n;
        const ld = document.getElementById('loadN');
        if (ld && e.data.load !== undefined){
          ld.textContent = Math.round(e.data.load * 100) + '%';
          ld.style.color = e.data.load > 0.7 ? '#ff7a8a' : '';
          window.__load = window.__load || []; window.__load.push([e.data.load, e.data.maxDt, e.data.n]);
          if (window.__load.length > 600) window.__load.shift();
        }
      }
    };
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    gainNode = ctx.createGain();
    gainNode.gain.value = +el.vol.value * VOL_SCALE;
    // 最終段のリミッター：大きな和音でも歪ませずに頭を抑える
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -4; limiter.knee.value = 4; limiter.ratio.value = 20;
    limiter.attack.value = 0.002; limiter.release.value = 0.15;
    buildSpatial();
    spMix.connect(analyser);
    analyser.connect(gainNode);
    gainNode.connect(limiter);
    limiter.connect(ctx.destination);
    applySpatial();
  }).catch(e => {
    showAudioError('音声エンジンの起動に失敗しました：' + e.message);
    throw e;
  });
}
// ---- 立体音響：頭部伝達関数（HRTF）で音源を空間に置き、部屋の響きを畳み込みでつける ----
// 座標は聴き手（奏者の位置）が原点、x が右、y が上、-z が前。ピアノは目の前で、低音弦が左・高音弦が右、
// 響板は鍵盤より少し奥、耳より低い位置にある
const SP_POS = [
  [-0.55, -0.35, -1.25], [-0.30, -0.33, -1.15], [-0.05, -0.32, -1.05], [0.20, -0.32, -0.95], [0.42, -0.33, -0.90], // 弦（低音→高音）
  [-0.40, -0.45, -1.35], [0.30, -0.45, -1.15],   // 響板の左右
];
let spMix = null, spDirect = null, spOther = null, spWet = null, spConv = null;
function makeRoomIR(sr){
  // 中くらいの部屋（残響時間 約1.3秒）。最初の数十msは壁・天井・床の初期反射、その後は拡散した残響。
  // 高い周波数ほど速く減衰させる。左右は無相関
  const T = 2.4, n = Math.round(T * sr), ir = [new Float32Array(n), new Float32Array(n)];
  let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; };
  const refl = [[0.0035, 0.55, 0.5], [0.0085, 0.35, 0.3], [0.0115, 0.45, 0.12], [0.0145, 0.1, 0.4], [0.0195, 0.22, 0.25], [0.024, 0.28, 0.08], [0.029, 0.07, 0.24], [0.034, 0.16, 0.16]];
  for (const [t, gl, gr] of refl){ const i = Math.round(t * sr); ir[0][i] += gl; ir[1][i] += gr; }
  for (let c = 0; c < 2; c++){
    let lp = 0;
    for (let i = 0; i < n; i++){
      const t = i / sr, fade = Math.min(1, Math.max(0, (t - 0.008) / 0.03));
      const k = Math.exp(-2 * Math.PI * Math.max(600, 9000 * Math.exp(-t / 0.5)) / sr);   // 時間とともに暗くなる
      lp = (1 - k) * rnd() + k * lp;
      ir[c][i] += lp * fade * 0.22 * Math.exp(-6.91 * t / 1.3) * Math.sqrt(9000 / Math.max(600, 9000 * Math.exp(-t / 0.5)));
    }
  }
  const buf = ctx.createBuffer(2, n, sr); buf.copyToChannel(ir[0], 0); buf.copyToChannel(ir[1], 1); return buf;
}
function buildSpatial(){
  spMix = ctx.createGain();
  // 立体音響オフ：ワークレットの通常のステレオ出力をそのまま使う
  spDirect = ctx.createGain(); node.connect(spDirect, 0); spDirect.connect(spMix);
  const bus = ctx.createGain();
  const mkPan = (x, y, z) => { const p = new PannerNode(ctx, { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 1, rolloffFactor: 0, positionX: x, positionY: y, positionZ: z }); p.connect(bus); return p; };
  // ピアノの7音源
  const sp7 = ctx.createChannelSplitter(7); node.connect(sp7, 1);
  SP_POS.forEach((q, i) => sp7.connect(mkPan(...q), i));
  // ピアノ以外の楽器（ステレオ）は正面の左右に置く
  spOther = ctx.createGain(); node.connect(spOther, 0);
  const sp2 = ctx.createChannelSplitter(2); spOther.connect(sp2);
  sp2.connect(mkPan(-0.45, -0.1, -1.4), 0); sp2.connect(mkPan(0.45, -0.1, -1.4), 1);
  // オフ時と同じ音量になるよう合わせる（実測で HRTF 経路は約 3dB 大きい）
  const lift = ctx.createGain(); lift.gain.value = 0.68; bus.connect(lift); lift.connect(spMix);
  spConv = ctx.createConvolver(); spConv.normalize = false; spConv.buffer = makeRoomIR(ctx.sampleRate);
  spWet = ctx.createGain(); lift.connect(spConv); spConv.connect(spWet); spWet.connect(spMix);
}
function applySpatial(){
  if (!node) return;
  const on = el.spatial.checked, t = ctx.currentTime;
  node.port.postMessage({ type:'spatial', on });
  // オンのときはワークレット内の簡易リバーブを止め、部屋の畳み込みで響きをつける
  node.port.postMessage({ type:'wet', value: on ? 0 : +el.rev.value });
  spDirect.gain.setTargetAtTime(on ? 0 : 1, t, 0.01);
  spOther.gain.setTargetAtTime(on ? 1 : 0, t, 0.01);
  // 残響スライダー 0.25 で、響きのエネルギーが直接音の約 -6dB（ピアノの近くで聴いている程度）
  spWet.gain.setTargetAtTime(on ? +el.rev.value * 0.42 : 0, t, 0.02);
}
async function ensureAudio(){
  if (!audioReady) audioReady = initAudio();
  else if (ctx && ctx.state !== 'running') ctx.resume();   // 操作の直後に同期で呼ぶ
  await audioReady;
  if (ctx.state !== 'running') await ctx.resume();
}
// 最初の操作（どこをクリック／キーを押しても）で音声を起動しておく
for (const ev of ['pointerdown', 'keydown'])
  window.addEventListener(ev, () => { ensureAudio().catch(() => {}); }, { capture: true });
function midiToFreq(m){ return 440 * Math.pow(2, (m - 69) / 12); }
async function noteOn(id, midi, vel){
  await ensureAudio();
  sustained.delete(id);
  node.port.postMessage({
    type:'noteOn', id, inst: cur.id,
    freq: midiToFreq(midi), vel,
    bright: +el.bright.value,
    decayMul: Math.pow(4, (+el.decay.value - 0.5) * 2),
    pp: cur.id === 'piano' ? pianoPP : undefined,
  });
}
// サステインペダル：踏んでいる間は離鍵してもダンパーが弦に触れない
let sustain = false;
const sustained = new Set();
function noteOff(id){
  if (!node) return;
  if (sustain){ sustained.add(id); return; }
  node.port.postMessage({ type:'noteOff', id });
}
function setSustain(on){
  sustain = on;
  document.getElementById('pedal').classList.toggle('on', on);
  if (node) node.port.postMessage({ type:'pedal', on });
  if (!on){
    for (const id of sustained) if (node) node.port.postMessage({ type:'noteOff', id });
    sustained.clear();
  }
}

/* --- DOM refs --- */
const el = {
  bright: document.getElementById('bright'), decay: document.getElementById('decay'),
  rev: document.getElementById('rev'), vol: document.getElementById('vol'), spatial: document.getElementById('spatial'),
  brightOut: document.getElementById('brightOut'), decayOut: document.getElementById('decayOut'),
  revOut: document.getElementById('revOut'), volOut: document.getElementById('volOut'),
  kb: document.getElementById('kb'), insts: document.getElementById('insts'),
  desc: document.getElementById('modelDesc'), octLabel: document.getElementById('octLabel'),
};

/* --- 楽器ボタン --- */
for (const inst of INSTS){
  const b = document.createElement('button');
  b.className = 'inst';
  b.innerHTML = `<span class="em">${inst.em}</span>${inst.name}`;
  b.dataset.id = inst.id;
  b.addEventListener('click', () => selectInst(inst));
  el.insts.appendChild(b);
}
function selectInst(inst){
  cur = inst;
  document.querySelectorAll('.inst').forEach(b => b.classList.toggle('on', b.dataset.id === inst.id));
  el.desc.innerHTML = `物理モデル：<b>${inst.model}</b>`;
  el.bright.value = inst.bright; el.decay.value = inst.decay;
  updateOuts();
  const pt = document.getElementById('ptune');
  if (pt) pt.style.display = inst.id === 'piano' ? '' : 'none';
}

/* --- スライダー --- */
function updateOuts(){
  el.brightOut.textContent = (+el.bright.value).toFixed(2);
  el.decayOut.textContent = (+el.decay.value).toFixed(2);
  el.revOut.textContent = (+el.rev.value).toFixed(2);
  el.volOut.textContent = (+el.vol.value).toFixed(2);
}
el.bright.addEventListener('input', updateOuts);
el.decay.addEventListener('input', updateOuts);
el.rev.addEventListener('input', () => { updateOuts(); applySpatial(); });
try { const sv = localStorage.getItem('pmSpatial'); if (sv !== null) el.spatial.checked = sv === '1'; } catch (e) {}
el.spatial.addEventListener('change', () => { try { localStorage.setItem('pmSpatial', el.spatial.checked ? '1' : '0'); } catch (e) {} applySpatial(); });
el.vol.addEventListener('input', () => { updateOuts(); if (gainNode) gainNode.gain.setTargetAtTime(+el.vol.value * VOL_SCALE, ctx.currentTime, 0.02); });

/* --- 鍵盤 --- */
const KEY_ELEMS = new Map(); // midi -> element
function buildKeyboard(){
  el.kb.innerHTML = '';
  KEY_ELEMS.clear();
  const semis = 25; // 2オクターブ＋上のC
  const whiteIdx = [];
  let wCount = 0;
  for (let i = 0; i < semis; i++){
    const pc = (baseNote + i) % 12;
    const isBlack = [1,3,6,8,10].includes(pc);
    whiteIdx.push(wCount);
    if (!isBlack) wCount++;
  }
  const wW = 100 / wCount;
  for (let i = 0; i < semis; i++){
    const midi = baseNote + i;
    const pc = midi % 12;
    const isBlack = [1,3,6,8,10].includes(pc);
    const k = document.createElement('div');
    k.dataset.midi = midi;
    if (isBlack){
      k.className = 'bkey';
      const bw = wW * 0.62;
      k.style.left = `calc(${whiteIdx[i] * wW}% - ${bw / 2}%)`;
      k.style.width = bw + '%';
    } else {
      k.className = 'wkey';
      k.style.left = (whiteIdx[i] * wW) + '%';
      k.style.width = wW + '%';
      const lab = document.createElement('div');
      lab.className = 'klabel';
      lab.textContent = NOTE_NAMES[pc] + (Math.floor(midi / 12) - 1);
      k.appendChild(lab);
    }
    el.kb.appendChild(k);
    KEY_ELEMS.set(midi, k);
  }
  el.octLabel.textContent =
    `${NOTE_NAMES[baseNote % 12]}${Math.floor(baseNote / 12) - 1} 〜 ` +
    `${NOTE_NAMES[(baseNote + 24) % 12]}${Math.floor((baseNote + 24) / 12) - 1}`;
}
buildKeyboard();

/* --- ポインタ演奏（グリッサンド対応） --- */
const pointerNotes = new Map(); // pointerId -> {id, midi}
function keyFromEvent(e){
  const t = document.elementFromPoint(e.clientX, e.clientY);
  return t && t.dataset && t.dataset.midi ? t : null;
}
function startPointerNote(e, k){
  const midi = +k.dataset.midi;
  const rect = k.getBoundingClientRect();
  const vel = Math.min(1, Math.max(0.35, (e.clientY - rect.top) / rect.height * 1.1));
  const id = 'p' + e.pointerId + '_' + midi;
  pointerNotes.set(e.pointerId, { id, midi });
  k.classList.add('held');
  noteOn(id, midi, vel);
}
function endPointerNote(pointerId){
  const cur = pointerNotes.get(pointerId);
  if (!cur) return;
  noteOff(cur.id);
  const k = KEY_ELEMS.get(cur.midi);
  if (k) k.classList.remove('held');
  pointerNotes.delete(pointerId);
}
el.kb.addEventListener('pointerdown', e => {
  const k = keyFromEvent(e);
  if (!k) return;
  e.preventDefault();
  startPointerNote(e, k);
});
el.kb.addEventListener('pointermove', e => {
  const curNote = pointerNotes.get(e.pointerId);
  if (!curNote) return;
  const k = keyFromEvent(e);
  if (k && +k.dataset.midi !== curNote.midi){
    endPointerNote(e.pointerId);
    startPointerNote(e, k);
  }
});
window.addEventListener('pointerup', e => endPointerNote(e.pointerId));
window.addEventListener('pointercancel', e => endPointerNote(e.pointerId));

/* --- PCキーボード演奏 --- */
const KEYMAP = { a:0, w:1, s:2, e:3, d:4, f:5, t:6, g:7, y:8, h:9, u:10, j:11, k:12, o:13, l:14, p:15, ';':16 };
const heldKeys = new Map();
window.addEventListener('keydown', e => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (e.code === 'Space'){ e.preventDefault(); setSustain(true); return; }
  if (key === 'z'){ shiftOctave(-12); return; }
  if (key === 'x'){ shiftOctave(12); return; }
  if (!(key in KEYMAP) || heldKeys.has(key)) return;
  const midi = baseNote + KEYMAP[key];
  const id = 'k_' + key;
  heldKeys.set(key, { id, midi });
  const kEl = KEY_ELEMS.get(midi);
  if (kEl) kEl.classList.add('held');
  noteOn(id, midi, 0.85);
});
window.addEventListener('keyup', e => {
  if (e.code === 'Space'){ e.preventDefault(); setSustain(false); return; }
  const key = e.key.toLowerCase();
  const h = heldKeys.get(key);
  if (!h) return;
  noteOff(h.id);
  const kEl = KEY_ELEMS.get(h.midi);
  if (kEl) kEl.classList.remove('held');
  heldKeys.delete(key);
});

/* --- オクターブ --- */
function shiftOctave(d){
  baseNote = Math.min(84, Math.max(36, baseNote + d));
  for (const [, h] of heldKeys) noteOff(h.id);
  heldKeys.clear();
  buildKeyboard();
}
document.getElementById('octDown').addEventListener('click', () => shiftOctave(-12));
document.getElementById('octUp').addEventListener('click', () => shiftOctave(12));
document.getElementById('pedal').addEventListener('click', e => { setSustain(!sustain); e.currentTarget.blur(); });

/* --- 波形ビジュアライザ --- */
const scope = document.getElementById('scope');
const sctx = scope.getContext('2d');
function fitCanvas(){
  const r = scope.getBoundingClientRect();
  scope.width = r.width * devicePixelRatio;
  scope.height = r.height * devicePixelRatio;
}
window.addEventListener('resize', fitCanvas);
fitCanvas();
const wave = new Float32Array(2048);
function drawScope(){
  requestAnimationFrame(drawScope);
  const W = scope.width, H = scope.height;
  sctx.fillStyle = '#070a12';
  sctx.fillRect(0, 0, W, H);
  sctx.strokeStyle = '#182038';
  sctx.lineWidth = 1;
  sctx.beginPath();
  sctx.moveTo(0, H / 2); sctx.lineTo(W, H / 2);
  sctx.stroke();
  if (!analyser) return;
  analyser.getFloatTimeDomainData(wave);
  sctx.strokeStyle = '#3ddc97';
  sctx.lineWidth = 2 * devicePixelRatio;
  sctx.shadowColor = 'rgba(61,220,151,.6)';
  sctx.shadowBlur = 8;
  sctx.beginPath();
  for (let i = 0; i < wave.length; i++){
    const x = i / (wave.length - 1) * W;
    const y = H / 2 - wave[i] * H * 0.46;
    i === 0 ? sctx.moveTo(x, y) : sctx.lineTo(x, y);
  }
  sctx.stroke();
  sctx.shadowBlur = 0;
}
drawScope();

selectInst(INSTS[0]);
