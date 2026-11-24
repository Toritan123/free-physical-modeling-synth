/* ===== 標準MIDIファイル（SMF）の読み込みと GM 音色の割り当て（DOM に依存しない部分） ===== */
// SMF を読んでトラックごとのイベント列にする。フォーマット0/1/2、ランニングステータス、
// SMPTE 時間単位、RIFF(RMID) で包まれたファイルに対応する
function parseSMF(ab){
  const u8 = new Uint8Array(ab);
  let p = 0;
  // RMID 形式は RIFF チャンクの中に SMF が入っている
  for (let i = 0; i + 4 <= u8.length; i++){
    if (u8[i] === 0x4D && u8[i + 1] === 0x54 && u8[i + 2] === 0x68 && u8[i + 3] === 0x64){ p = i; break; }
    if (i > 4096) throw new Error('MIDIファイルではありません（MThd が見つかりません）');
  }
  const u32 = q => (u8[q] << 24 | u8[q + 1] << 16 | u8[q + 2] << 8 | u8[q + 3]) >>> 0;
  const u16 = q => u8[q] << 8 | u8[q + 1];
  const id = q => String.fromCharCode(u8[q], u8[q + 1], u8[q + 2], u8[q + 3]);
  if (id(p) !== 'MThd') throw new Error('MIDIファイルではありません（MThd が見つかりません）');
  const hlen = u32(p + 4);
  const format = u16(p + 8), ntrks = u16(p + 10), division = u16(p + 12);
  p += 8 + hlen;
  const tracks = [];
  while (p + 8 <= u8.length && tracks.length < Math.max(ntrks, 1) + 64){
    const cid = id(p), len = u32(p + 4);
    const start = p + 8, end = Math.min(u8.length, start + len);
    p = start + len;
    if (cid !== 'MTrk') continue;
    const ev = [];
    let q = start, tick = 0, running = 0;
    const readVar = () => { let v = 0, c; do { if (q >= end) return v; c = u8[q++]; v = v * 128 + (c & 0x7F); } while (c & 0x80); return v; };
    while (q < end){
      tick += readVar();
      if (q >= end) break;
      let st = u8[q];
      if (st >= 0x80){ q++; if (st < 0xF0) running = st; else if (st < 0xF8) running = 0; }
      else { st = running; if (!st) break; }   // データバイトから始まる＝ランニングステータス
      if (st === 0xFF){
        const type = u8[q++], len = readVar();
        if (type === 0x51 && len >= 3) ev.push({ tick, type: 'tempo', us: u8[q] << 16 | u8[q + 1] << 8 | u8[q + 2] });
        else if (type === 0x03 && !ev.name){ let t = ''; for (let i = 0; i < len && q + i < end; i++) t += String.fromCharCode(u8[q + i]); ev.name = t; }
        q += len;
        if (type === 0x2F) break;
      } else if (st === 0xF0 || st === 0xF7){
        q += readVar();
      } else {
        const hi = st & 0xF0, ch = st & 15;
        const a = u8[q++], b = (hi === 0xC0 || hi === 0xD0) ? 0 : u8[q++];
        ev.push({ tick, type: hi, ch, a, b });
      }
    }
    tracks.push(ev);
  }
  return { format, division, tracks };
}

// トラックを1本の時間軸にまとめ、音符（開始・終了時刻つき）とコントロールの変化に変換する
function buildSong(smf){
  const all = [];
  smf.tracks.forEach((tr, ti) => tr.forEach((e, k) => all.push({ e, s: ti * 1e7 + k })));
  all.sort((x, y) => x.e.tick - y.e.tick || x.s - y.s);
  const div = smf.division;
  const smpte = div & 0x8000;
  const secPerTickSmpte = smpte ? 1 / ((256 - (div >> 8)) * (div & 0xFF)) : 0;
  let tempo = 500000, lastTick = 0, time = 0;
  const prog = new Uint8Array(16), pan = new Uint8Array(16).fill(64);
  const pending = new Map();   // ch*128+key → 発音中の音（同じ鍵の重ね打ちは古い順に止める）
  const notes = [], ccs = [];
  let bends = 0, endTime = 0;
  const chInfo = []; for (let c = 0; c < 16; c++) chInfo.push({ progs: new Map(), n: 0 });
  for (const { e } of all){
    time += (e.tick - lastTick) * (smpte ? secPerTickSmpte : tempo / 1e6 / div);
    lastTick = e.tick;
    endTime = Math.max(endTime, time);
    if (e.type === 'tempo'){ tempo = e.us || 500000; continue; }
    const ch = e.ch;
    if (e.type === 0x90 && e.b > 0){
      const key = ch * 128 + e.a;
      if (!pending.has(key)) pending.set(key, []);
      pending.get(key).push({ t0: time, ch, key: e.a, vel: e.b, prog: prog[ch], pan: pan[ch] });
    } else if (e.type === 0x80 || (e.type === 0x90 && e.b === 0)){
      const list = pending.get(ch * 128 + e.a);
      if (list && list.length){ const n = list.shift(); n.t1 = Math.max(time, n.t0 + 0.01); notes.push(n); }
    } else if (e.type === 0xC0){
      prog[ch] = e.a;
    } else if (e.type === 0xB0){
      if (e.a === 7) ccs.push({ t: time, ch, vol: e.b });
      else if (e.a === 11) ccs.push({ t: time, ch, expr: e.b });
      else if (e.a === 10) pan[ch] = e.b;
      else if (e.a === 64) ccs.push({ t: time, ch, sus: e.b });
      else if (e.a === 121){ ccs.push({ t: time, ch, expr: 127, sus: 0 }); }
    } else if (e.type === 0xE0) bends++;
  }
  for (const list of pending.values()) for (const n of list){ n.t1 = Math.max(endTime, n.t0 + 0.5); notes.push(n); }
  notes.sort((a, b) => a.t0 - b.t0);
  for (const n of notes){
    const ci = chInfo[n.ch]; ci.n++;
    const pk = n.ch === 9 ? -1 : n.prog;
    ci.progs.set(pk, (ci.progs.get(pk) || 0) + 1);
  }
  let dur = 0; for (const n of notes) dur = Math.max(dur, n.t1);
  return { notes, ccs, duration: dur, bends, chInfo, name: (smf.tracks[0] && smf.tracks[0].name) || '' };
}

const GM_NAMES = ['Acoustic Grand Piano','Bright Acoustic Piano','Electric Grand Piano','Honky-tonk Piano','Electric Piano 1','Electric Piano 2','Harpsichord','Clavi',
'Celesta','Glockenspiel','Music Box','Vibraphone','Marimba','Xylophone','Tubular Bells','Dulcimer',
'Drawbar Organ','Percussive Organ','Rock Organ','Church Organ','Reed Organ','Accordion','Harmonica','Tango Accordion',
'Acoustic Guitar (nylon)','Acoustic Guitar (steel)','Electric Guitar (jazz)','Electric Guitar (clean)','Electric Guitar (muted)','Overdriven Guitar','Distortion Guitar','Guitar Harmonics',
'Acoustic Bass','Electric Bass (finger)','Electric Bass (pick)','Fretless Bass','Slap Bass 1','Slap Bass 2','Synth Bass 1','Synth Bass 2',
'Violin','Viola','Cello','Contrabass','Tremolo Strings','Pizzicato Strings','Orchestral Harp','Timpani',
'String Ensemble 1','String Ensemble 2','Synth Strings 1','Synth Strings 2','Choir Aahs','Voice Oohs','Synth Voice','Orchestra Hit',
'Trumpet','Trombone','Tuba','Muted Trumpet','French Horn','Brass Section','Synth Brass 1','Synth Brass 2',
'Soprano Sax','Alto Sax','Tenor Sax','Baritone Sax','Oboe','English Horn','Bassoon','Clarinet',
'Piccolo','Flute','Recorder','Pan Flute','Blown Bottle','Shakuhachi','Whistle','Ocarina',
'Lead 1 (square)','Lead 2 (sawtooth)','Lead 3 (calliope)','Lead 4 (chiff)','Lead 5 (charang)','Lead 6 (voice)','Lead 7 (fifths)','Lead 8 (bass + lead)',
'Pad 1 (new age)','Pad 2 (warm)','Pad 3 (polysynth)','Pad 4 (choir)','Pad 5 (bowed)','Pad 6 (metallic)','Pad 7 (halo)','Pad 8 (sweep)',
'FX 1 (rain)','FX 2 (soundtrack)','FX 3 (crystal)','FX 4 (atmosphere)','FX 5 (brightness)','FX 6 (goblins)','FX 7 (echoes)','FX 8 (sci-fi)',
'Sitar','Banjo','Shamisen','Koto','Kalimba','Bag pipe','Fiddle','Shanai',
'Tinkle Bell','Agogo','Steel Drums','Woodblock','Taiko Drum','Melodic Tom','Synth Drum','Reverse Cymbal',
'Guitar Fret Noise','Breath Noise','Seashore','Bird Tweet','Telephone Ring','Helicopter','Applause','Gunshot'];

// GM の音色番号 → 物理モデル。[楽器, 明るさ(省略時は楽器の既定値)]。
// 専用モデルの無い音色（オルガン・合唱・シンセ等）は、発音の仕組みが近い楽器に割り当てる
// （例：パイプオルガン＝エアリードの管→フルート、アコーディオン＝自由リード→クラリネット）
const GM_MAP = [
  ['piano'],['piano',.7],['piano',.65],['piano',.6],['epiano'],['epiano',.7],['harpsi'],['clav'],
  ['glocken',.35],['glocken'],['musicbox'],['vibes'],['marimba'],['marimba',.9],['bell'],['koto',.8],
  ['flute',.6],['flute',.7],['flute',.75],['flute',.5],['clarinet',.45],['clarinet',.55],['clarinet',.7],['clarinet',.55],
  ['guitar'],['steelgt'],['guitar',.4],['steelgt',.5],['mutedgt'],['steelgt',.8],['steelgt',.9],['harp',.8],
  ['ebass',.35],['ebass'],['ebass',.7],['ebass',.3],['ebass',.9],['ebass',.9],['ebass',.8],['ebass',.8],
  ['violin'],['violin',.5],['cello'],['cello',.5],['violin',.6],['pizz'],['harp'],['timpani'],
  ['strings'],['strings',.5],['strings',.6],['strings',.6],['flute',.3],['flute',.3],['flute',.4],['trumpet',.8],
  ['trumpet'],['trumpet',.4],['trumpet',.3],['trumpet',.8],['trumpet',.25],['trumpet'],['trumpet',.7],['trumpet',.7],
  ['clarinet',.7],['clarinet',.6],['clarinet',.55],['clarinet',.5],['clarinet',.8],['clarinet',.7],['clarinet',.45],['clarinet'],
  ['flute',.7],['flute'],['flute',.4],['flute',.45],['flute',.35],['flute',.6],['flute',.8],['flute',.4],
  ['clarinet',.8],['trumpet',.8],['flute'],['flute'],['steelgt',.8],['flute',.4],['trumpet',.7],['ebass',.8],
  ['epiano'],['strings',.45],['strings',.6],['flute',.35],['strings',.5],['vibes'],['flute',.45],['strings',.6],
  ['vibes'],['strings'],['glocken'],['harp'],['vibes',.7],['strings'],['vibes'],['bell'],
  ['shamisen',.7],['shamisen',.6],['shamisen'],['koto'],['musicbox',.5],['clarinet',.8],['violin',.6],['clarinet',.9],
  ['glocken'],['gm_cowbell'],['vibes',.7],['gm_block'],['drum'],['gm_tom'],['gm_tom'],['gm_crash'],
  null,null,null,null,null,null,null,null,
];

// GM ドラム（10ch）の鍵 → [楽器, 周波数Hz, 定位(-1左〜+1右), チョーク組]
const GM_DRUMS = {
  35:['gm_kick',46,0], 36:['gm_kick',52,0], 37:['gm_block',1800,0.05], 38:['gm_snare',200,0.05], 39:['gm_clap',1,0.1],
  40:['gm_snare',220,0.05], 41:['gm_tom',66,0.3], 42:['gm_hhc',1,-0.25,1], 43:['gm_tom',74,0.25], 44:['gm_hhp',1,-0.25,1],
  45:['gm_tom',84,0.15], 46:['gm_hho',1,-0.25,1], 47:['gm_tom',106,0.05], 48:['gm_tom',138,-0.05], 49:['gm_crash',1,-0.35],
  50:['gm_tom',163,-0.15], 51:['gm_ride',1,0.35], 52:['gm_china',1,0.45], 53:['gm_rbell',1,0.35], 54:['gm_tamb',1,-0.1],
  55:['gm_splash',1,-0.15], 56:['gm_cowbell',560,0.2], 57:['gm_crash',1,0.3], 58:['gm_shaker',1,0.2], 59:['gm_ride',1,0.3],
  60:['gm_conga',420,0.25], 61:['gm_conga',320,0.3], 62:['gm_conga',340,-0.2], 63:['gm_conga',300,-0.2], 64:['gm_conga',220,-0.3],
  65:['gm_timbale',450,0.3], 66:['gm_timbale',340,0.35], 67:['gm_cowbell',900,-0.3], 68:['gm_cowbell',680,-0.3],
  69:['gm_shaker',1,0.3], 70:['gm_shaker',1,-0.3], 73:['gm_shaker',1,0.1], 74:['gm_shaker',1,0.1], 75:['gm_block',2500,-0.2],
  76:['gm_block',1200,0.2], 77:['gm_block',900,0.25], 80:['gm_triangle',1500,0.3,2], 81:['gm_triangle',1500,0.3,2],
};

// 音符を物理モデルの発音パラメータに変換する（割り当て不能なら null）
function mapNote(n, defaults){
  const vel = 0.12 + 0.88 * n.vel / 127;
  const pan = n.pan / 127;
  if (n.ch === 9){
    const d = GM_DRUMS[n.key];
    if (!d) return null;
    return { inst: d[0], freq: d[1], vel, bright: 0.5, decayMul: 1, pan: Math.min(1, Math.max(0, pan + 0.5 * d[2])), choke: d[3] || 0 };
  }
  const g = GM_MAP[n.prog];
  if (!g) return null;
  let inst = g[0];
  // 弦楽合奏：低い音はチェロ、高い音はバイオリンで鳴らす
  if (inst === 'strings') inst = n.key < 55 ? 'cello' : 'violin';
  let freq = 440 * Math.pow(2, (n.key - 69) / 12);
  if (inst === 'cello') freq *= 2;        // チェロは鍵盤用に1オクターブ下げてあるので戻す
  const bright = g[1] !== undefined ? g[1] : (defaults[inst] !== undefined ? defaults[inst] : 0.5);
  return { inst, freq, vel, bright, decayMul: 1, pan, choke: 0 };
}
