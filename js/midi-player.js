/* ===== MIDI 再生：先読みして時刻つきで worklet に送る ===== */
const INST_LABEL = { steelgt:'スチール弦ギター', mutedgt:'ミュートギター', ebass:'ベース', harpsi:'チェンバロ',
  clav:'クラビネット', pizz:'ピチカート', timpani:'ティンパニ', strings:'弦楽合奏（バイオリン＋チェロ）', drumkit:'ドラムセット',
  gm_cowbell:'カウベル', gm_block:'ウッドブロック', gm_tom:'タム', gm_crash:'シンバル' };
const instLabel = id => { const i = INSTS.find(x => x.id === id); return i ? i.name : (INST_LABEL[id] || id); };
const midi = { song: null, timer: 0, start: 0, idx: 0, evs: null, playing: false, raf: 0 };
const mEl = {
  file: document.getElementById('midiFile'), play: document.getElementById('midiPlay'), stop: document.getElementById('midiStop'),
  name: document.getElementById('midiName'), time: document.getElementById('midiTime'), bar: document.getElementById('midiBar'),
  ch: document.getElementById('midiCh'), wrap: document.getElementById('midiBox'),
};
const fmt = s => { s = Math.max(0, s); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };

function loadMidiBuffer(ab, fileName){
  midiStop();
  let song;
  try { song = buildSong(parseSMF(ab)); }
  catch (e){ mEl.name.textContent = '読み込めませんでした：' + e.message; mEl.play.disabled = true; return null; }
  midi.song = song;
  const defaults = {}; for (const i of INSTS) defaults[i.id] = i.bright;
  // 音符ごとに物理モデルの発音パラメータを決めておく
  let skipped = 0;
  for (const n of song.notes){ n.m = mapNote(n, defaults); if (!n.m) skipped++; }
  mEl.name.textContent = (song.name ? song.name + '（' + fileName + '）' : fileName) + ' — ' + song.notes.length + '音・' + fmt(song.duration);
  mEl.time.textContent = '0:00 / ' + fmt(song.duration);
  mEl.bar.style.width = '0%';
  mEl.play.disabled = song.notes.length === 0;
  // チャンネル一覧：GM の音色名 → 割り当てた物理モデル
  let html = '';
  song.chInfo.forEach((ci, c) => {
    if (!ci.n) return;
    const progs = [...ci.progs.entries()].sort((a, b) => b[1] - a[1]);
    const rows = progs.map(([pg, cnt]) => {
      if (pg < 0) return ['GM ドラム', 'ドラムセット（物理モデル）', cnt];
      const g = GM_MAP[pg];
      return [GM_NAMES[pg], g ? instLabel(g[0]) : '（未対応：鳴らしません）', cnt];
    });
    rows.forEach((r, k) => {
      html += `<tr><td>${k ? '' : 'Ch ' + (c + 1)}</td><td>${r[0]}</td><td class="arrow">→</td><td class="${r[1].startsWith('（') ? 'na' : 'ok'}">${r[1]}</td><td class="cnt">${r[2]}音</td></tr>`;
    });
  });
  const notes = [];
  if (song.bends) notes.push('ピッチベンド（' + song.bends + '件）は未対応のため無視します');
  if (skipped) notes.push(skipped + '音は対応する音源が無いため鳴らしません');
  mEl.ch.innerHTML = html + (notes.length ? `<tr><td colspan="5" class="note">※ ${notes.join('／')}</td></tr>` : '');
  return song;
}

async function midiPlay(){
  if (!midi.song) return;
  await ensureAudio();
  midiStop();
  // 発音・消音・コントロールを時刻順の1本の列にする（同時刻は 消音→コントロール→発音 の順）
  const evs = [];
  let serial = 0;
  for (const c of midi.song.ccs) evs.push({ t: c.t, o: 1, cc: c });
  for (const n of midi.song.notes){
    if (!n.m) continue;
    const id = 'M' + (serial++);
    evs.push({ t: n.t0, o: 2, n, id });
    evs.push({ t: n.t1, o: 0, n, id });
  }
  evs.sort((a, b) => a.t - b.t || a.o - b.o);
  midi.evs = evs; midi.idx = 0;
  midi.start = ctx.currentTime + 0.3;
  midi.playing = true;
  mEl.play.disabled = true; mEl.stop.disabled = false;
  midiPump();
  midi.timer = setInterval(midiPump, 100);
  midi.raf = requestAnimationFrame(midiTick);
}
// 2秒先までのイベントを、サンプル番号つきで worklet に送る
// （先読みを長めにとるのは、タブが裏に回ってタイマーが間引かれても途切れないようにするため）
function midiPump(){
  if (!midi.playing) return;
  const now = ctx.currentTime - midi.start, horizon = now + 2.0, sr = ctx.sampleRate, out = [];
  const evs = midi.evs;
  while (midi.idx < evs.length && evs[midi.idx].t < horizon){
    const e = evs[midi.idx++];
    const f = Math.round((midi.start + e.t) * sr);
    if (e.o === 1) out.push(Object.assign({ k: 'cc', f, o: 1 }, e.cc));
    else if (e.o === 0) out.push({ k: 'off', f, o: 0, id: e.id, ch: e.n.ch });
    else { const m = e.n.m; out.push({ k: 'on', f, o: 2, id: e.id, ch: e.n.ch, inst: m.inst, freq: m.freq, vel: m.vel,
      bright: m.bright, decayMul: m.decayMul * Math.pow(4, (+el.decay.value - 0.5) * 2), pan: m.pan, choke: m.choke, pp: m.inst === 'piano' ? pianoPP : undefined }); }
  }
  if (out.length) node.port.postMessage({ type: 'sched', events: out });
}
function midiTick(){
  if (!midi.playing) return;
  const t = ctx.currentTime - midi.start, d = midi.song.duration;
  mEl.time.textContent = fmt(Math.min(t, d)) + ' / ' + fmt(d);
  mEl.bar.style.width = Math.min(100, 100 * t / d) + '%';
  if (t > d + 0.5 && midi.idx >= midi.evs.length){ midiFinish(); return; }
  midi.raf = requestAnimationFrame(midiTick);
}
function midiFinish(){   // 最後まで再生した：余韻は自然に消えるに任せる
  midi.playing = false; clearInterval(midi.timer); cancelAnimationFrame(midi.raf);
  mEl.play.disabled = !midi.song; mEl.stop.disabled = true;
  mEl.bar.style.width = '100%';
}
function midiStop(){
  if (midi.playing && node) node.port.postMessage({ type: 'stop' });
  midi.playing = false; clearInterval(midi.timer); cancelAnimationFrame(midi.raf);
  mEl.play.disabled = !midi.song; mEl.stop.disabled = true;
  if (midi.song){ mEl.time.textContent = '0:00 / ' + fmt(midi.song.duration); mEl.bar.style.width = '0%'; }
}
function readMidiFile(file){
  const r = new FileReader();
  r.onload = () => loadMidiBuffer(r.result, file.name);
  r.readAsArrayBuffer(file);
}
mEl.file.addEventListener('change', () => { if (mEl.file.files[0]) readMidiFile(mEl.file.files[0]); mEl.file.value = ''; });
mEl.play.addEventListener('click', midiPlay);
mEl.stop.addEventListener('click', midiStop);
// ページのどこにでも MIDI ファイルをドロップできる
window.addEventListener('dragover', e => { e.preventDefault(); mEl.wrap.classList.add('drag'); });
window.addEventListener('dragleave', e => { if (e.relatedTarget === null) mEl.wrap.classList.remove('drag'); });
window.addEventListener('drop', e => {
  e.preventDefault(); mEl.wrap.classList.remove('drag');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) readMidiFile(f);
});
