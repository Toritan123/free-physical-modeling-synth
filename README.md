# Free Physical Modeling Synth

ブラウザだけで動く、**無料の物理モデル音源**の楽器集です。インストール不要・登録不要で、誰でも自由に使えます（MIT ライセンス）。サンプル（録音した音）は一切使わず、弦・ハンマー・管・弓などの振る舞いを AudioWorklet の中で1サンプルずつ計算して、リアルタイムに波形を作ります。

**デモ:** https://toritan123.github.io/free-physical-modeling-synth/

## 作り方：AI が書き、人が耳で聴いて直す

コードは Anthropic の AI「Claude」が [Claude Code](https://claude.com/claude-code) で書きました。ただし、AI に任せきりではありません。作者が実際に何度も弾いて耳で聴き、そのたびに「立ち上がりがギターっぽい」「低音が電子的」「全体に少し調律が狂って聞こえる」「G3 あたりがまだ偽物っぽい」といった感想を伝えて、直してもらっています。

Claude はその感想を手がかりに、本物のピアノの録音と倍音・減衰・調律などを数値で比べて原因を探し、直しました。聴いて、比べて、直す。これを何十回も繰り返して今の音になっています。

Anthropic の公式プロジェクトではありません。

> **Free** real-time physical-modeling instruments that run entirely in the browser (Web Audio AudioWorklet): piano, plucked and bowed strings, winds, mallets and drums, plus General MIDI file playback. No samples are used. The code was written by Claude (Anthropic's AI) using Claude Code, but it was not left to the AI alone: the author played and listened to it by ear many times, and every round of feedback ("the attack sounds like a guitar", "the bass sounds electronic", "it sounds slightly out of tune") was traced against real piano recordings and fixed. Not an official Anthropic project.

## 遊び方

- 画面の鍵盤をクリック、または PC のキーボード（A W S E D F T G …）で演奏します。
- 楽器を選び、「明るさ」「減衰・余韻」「残響」で音色を変えられます。
- **立体音響**（ヘッドホン向け）：ピアノを目の前約1.2mに置いたように聞こえます（頭部伝達関数 HRTF と部屋の響きの畳み込み）。
- **MIDI ファイル**（.mid / .rmi）をドラッグ＆ドロップすると、General MIDI の128音色とドラムセットを物理モデルに割り当てて再生します。
- ピアノを選ぶと「ピアノの調整」パネルが出て、打撃音・弦の硬さ・同音弦のうなりなどを耳で合わせられます。

## ローカルで動かす

音源のコードを `fetch` で読み込むため、`file://` で直接開くと動きません。HTTP サーバーから開いてください。

```bash
python3 -m http.server 8931
```

ブラウザで http://localhost:8931/ を開きます。

## 楽器と物理モデル

| 楽器 | モデル | ファイル |
|---|---|---|
| ピアノ | ハンマーと弦の衝突シミュレーション（2層フェルト）、非調和性をもつ弦の導波管、同音弦の結合（二段減衰）、響板・フレームの共鳴、共鳴弦、縦振動、ストレッチ調律 | `dsp/piano.js` |
| ギター・琴・ハープ・三味線 | パルス波励振の2偏波弦導波管＋胴の共鳴 | `dsp/pluck.js` |
| エレピ・マリンバ・ビブラフォン・グロッケン・オルゴール・鐘 | モード合成（減衰共振器バンク） | `dsp/modal.js` |
| ドラム・GM ドラムセット | 膜のモード（張力変調によるピッチの上ずり、二段減衰）、スティック・ビーターの打撃音、スネアの響き線、シンバル・ハイハットの密な金属板モード（打撃後に高いモードへエネルギーが流れ込む過程を含む） | `dsp/drums.js` |
| フルート・クラリネット・トランペット | ジェット駆動の気柱／リード弁と閉管／唇の共振弁と管 | `dsp/winds.js` |
| バイオリン・チェロ | 弓と弦の摩擦モデル＋胴の共鳴 | `dsp/bowed.js` |

楽器ごとのパラメータ（GM 音色の割り当て用を含む）は `dsp/specs.js` にあります。

### ピアノの較正について

ピアノは、次の録音と数値で比べながら合わせ込みました。録音そのものはこのリポジトリに含まれていません（解析にだけ使用）。

- University of Iowa Electronic Music Studios, *Musical Instrument Samples*（Steinway B）
- *Salamander Grand Piano*（Yamaha C5、Alexander Holm 作、CC BY 3.0）

比べたのは、倍音ごとのレベルと減衰の速さ、非調和性、打鍵の強さによる音量と音色の変化、立ち上がり、音域ごとの音量バランスなどです。

### ドラムの較正について

ドラムセット（バスドラム・スネア・タム・ハイハット・クラッシュ・ライド・チャイナ）は、*MuldjordKit*（Lars Muldjord 作、Tama Superstar、CC BY 4.0）の弱・中・強打の録音（近接マイクとオーバーヘッド）と比べて合わせ込みました。録音はこのリポジトリに含まれていません。比べたのは、帯域ごとのエネルギーの時間変化、減衰の速さ、打撃直後のピッチの上ずり、叩く強さによる音色の変化です。生録音のままではタムがよく鳴ってジャズ寄りに聴こえたので、余韻の長さ・音の高さ・音色の釣り合いは、MIDI でいう標準的なキット（*GeneralUser GS*、S. Christian Collins 作の Standard キット）に合わせました。

## ファイル構成

```
index.html          画面
css/style.css       見た目
js/ui.js            画面・鍵盤・音声の経路（立体音響を含む）
js/midi-core.js     MIDI ファイルの解析と GM 音色の割り当て
js/midi-player.js   MIDI の予約再生
dsp/                AudioWorklet 内で動く音源（この順につなげて1つのモジュールとして読み込む）
  core.js           共通部品（遅延線・フィルタ・共振器・ループ損失の設計）
  pluck.js          撥弦
  piano.js          ピアノ
  modal.js          モード合成
  drums.js          ドラムセット
  winds.js          管楽器
  bowed.js          擦弦
  specs.js          楽器定義
  processor.js      発音管理・残響・ミキサー（AudioWorkletProcessor）
```

## ライセンス

[MIT](LICENSE)
