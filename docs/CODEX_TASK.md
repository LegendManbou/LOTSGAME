# CODEX_TASK: NEON BEATS 難易度リバランス指示書

> この指示書は、このリポジトリ(LOTSGAME)の自作音ゲー「NEON BEATS」の難易度を
> リバランスするためのタスク定義です。**上から順に読み、すべてのタスクを完了させてください。**

---

## 0. プロジェクト背景(まず把握すること)

- **LOTSGAME** = スマホ向けブラウザゲームポータル(静的サイト、GitHub Pages公開)
  - 公開URL: https://legendmanbou.github.io/LOTSGAME/
  - デプロイ: `main` ブランチに push すると GitHub Actions(`.github/workflows/pages.yml`)が自動デプロイ
- **NEON BEATS** = `rhythm/` フォルダにある自作音ゲー(プロセカ風・完全オリジナル)
  - `rhythm/game.js` … ゲームロジック本体。**今回触るのは原則このファイルだけ**
  - 楽曲はWebAudioによる自動作曲(`SONG_DEFS` + `buildSong`)、譜面は `chartFromSong` が難易度別に生成
  - 「自分の曲で遊ぶ」モードの譜面生成は `analyzeAudio`
  - 難易度は6段階: `easy / normal / hard / expert / master / god`(`DIFFS`, `DIFF_META`, `DIFF_PARAMS`)
  - 表示レベルは `songLv(def) = def.lvBase + DIFF_META[diff].lv`(lvBase: スターライト3 / サイバー6 / オーバードライブ9)

---

## 1. 変更の目的(ユーザーの要望)

今のGODは体感「MASTER程度」なので、全体を1段階ずつ引き上げる:

| 難易度 | 新しい難しさ |
|---|---|
| EXPERT | **今のMASTER相当**にする |
| MASTER | **今のGOD相当**にする |
| GOD | **大幅に難化**。曲によってスケールし、Lv.33/36は「鬼」、最高Lv.39は「ネタ級」 |

さらに、**最高レベルは39**(現在ネオン・オーバードライブGODが40になっているのを39に)。
EASY / NORMAL / HARD は変更しない。

---

## 2. タスクA: レベル表記の変更

`rhythm/game.js` の `DIFF_META` の `lv` を変更する:

| 難易度 | 現在の lv | 新しい lv | 結果(3曲のLv表示) |
|---|---|---|---|
| easy | 2 | 2(変更なし) | 5 / 8 / 11 |
| normal | 8 | 8(変更なし) | 11 / 14 / 17 |
| hard | 15 | 15(変更なし) | 18 / 21 / 24 |
| expert | 21 | **24** | 27 / 30 / 33 |
| master | 26 | **27** | 30 / 33 / 36 |
| god | 31 | **30** | 33 / 36 / **39** ← 最高39 |

---

## 3. タスクB: EXPERT / MASTER の難易度引き上げ(内蔵曲)

`rhythm/game.js` の `DIFF_PARAMS` と `chartFromSong` を変更する。

方針: **現在のMASTERのレシピをEXPERTへ、現在のGODのレシピをMASTERへスライドする。**

- `DIFF_PARAMS.expert` ← 現在の `master` の値(gap 0.105 / snare 1 / hat 0.55 / dbl 0.16 など)
- `DIFF_PARAMS.master` ← 現在の `god` の値(gap 0.075 / hat 0.9 / bass 0.5 / dbl 0.30 など)
- `chartFromSong` 内の「16分音符ラッシュ」(`rushP`)も同様にスライド:
  - 現在: god 0.65 / master 0.14
  - 新: **master 0.65 / expert 0.14**、godは タスクC の新レシピ

---

## 4. タスクC: GOD の大幅難化(内蔵曲)⭐最重要

GODは**曲のlvBaseに応じてスケール**させる。目標密度(秒間ノーツ数 = nps、演奏区間ベース):

| 曲 | GODのLv | ランク | 目標nps | 内容 |
|---|---|---|---|---|
| スターライト・ラン | 33 | 鬼 | **9〜10** | 16分ほぼ全埋め+フレーズ末に24分バースト+同時押し多め |
| サイバー・パレード | 36 | 鬼(強) | **10.5〜11.5** | 上記+24分バースト増量+フリック連鎖 |
| ネオン・オーバードライブ | 39 | **ネタ級** | **12〜13** | 24分ほぼ常駐・同時押し連発・フリック地獄。「理論上は押せる」ギリギリの弾幕 |

実装ガイド(細部は目標npsを満たすなら調整してよい):

- GOD専用パラメータ例: `gap` を 0.055〜0.06 に、同時押し率 `dbl` を 0.35〜0.5 に
- 16分ラッシュ確率を 0.85〜0.95 に上げ、さらに **24分サブ分割パス** を追加する
  (フレーズ末や4小節目などで `spb/6` 間隔のバーストを流し込む。Lv39はバースト頻度を常駐級に)
- lvBaseでスケール: 例 `const godScale = (def.lvBase - 3) / 6;`(0〜1)を密度・バースト頻度・dblに掛ける
- **プレイ可能性の下限は守る**(タスクEの制約参照)

### 密度の測り方(必須)

ブラウザのコンソールで実測して目標npsに入っているか確認すること:

```js
// rhythm/ ページのコンソールで実行
for (const def of SONG_DEFS) {
  const song = getSong(def);
  const notes = chartFromSong(song, "god");
  const span = notes[notes.length - 1].t - notes[0].t;
  console.log(def.name, notes.length, "notes", (notes.length / span).toFixed(2), "nps");
}
```

EXPERT / MASTER も同じ方法で「EXPERT ≒ 旧MASTER(4〜5nps)」「MASTER ≒ 旧GOD(7〜8nps)」を確認。

---

## 5. タスクD: 「自分の曲で遊ぶ」モードも同様にスライド

`analyzeAudio` 内の難易度マップも1段階スライドする:

- `minGap`: expert ← 旧master(0.11)、master ← 旧god(0.08)、god は **0.055〜0.06**
- `sdMul`(オンセット検出しきい値): expert ← 0.9、master ← 0.72、god は **0.55前後**(ノーツ大幅増)
- 同時押し率は `DIFF_PARAMS` の `dbl` を参照しているので、タスクB/Cの変更に追従することを確認

---

## 6. タスクE: 壊してはいけないもの(制約)

1. **判定ウィンドウ(`WIN`)・スコア計算・AP演出・設定画面・部屋機能・ポータル側(`js/`, `index.html`)は変更しない**
2. プレイ可能性の下限:
   - 同一レーンの連続ノーツ間隔は **0.16秒以上**(現在は0.22秒。GODのみ0.16まで緩めてよい)
   - 同時押しは **2レーンまで**(3枚以上の同時押しは禁止)
   - ロングノーツ保持中のレーンにタップを重ねない(既存の `hold` 重なりチェックを維持)
3. EASY / NORMAL / HARD の譜面は変えない(ノーツ数が±5%以上変わっていたら何かを壊している)
4. 著作権: 既存曲・既存デザインはすべてオリジナル。**他作品の楽曲・素材・名称を追加しないこと**
5. `rhythm/game.js` 以外のファイルは原則変更しない(READMEの難易度記述を直すのは可)

---

## 7. 動作確認手順(push前に必ず)

1. ローカルサーバー起動: リポジトリ直下で `npx --yes http-server . -p 8123`
2. `http://localhost:8123/rhythm/` を開く
3. コンソールでエラーが出ていないこと
4. タスクCの計測スニペットで全難易度のnpsが目標に入っていること
5. Lv表示確認: 難易度を切り替えて 5/8/11 … 33/36/**39** になっていること(40が存在しないこと)
6. GODを1曲プレイ開始して、ノーツが降ってくる・叩ける・激ムズであることを目視確認
   (オートプレイで判定確認する場合は以下をコンソールで):

```js
// ゲーム開始後に実行するとオートプレイになる(判定・スコアの健全性確認用)
setInterval(() => {
  if (state !== "play") return;
  const now = playNow() - OFF();
  for (const nt of chart) {
    if (!nt.judged && Math.abs(now - nt.t) < 0.03) {
      hitLane(nt.lane, true);
      if (nt.type === "hold" && nt.holding) setTimeout(() => releaseLane(nt.lane), Math.max(0, nt.dur * 1000 - 30));
    }
  }
}, 10);
```

7. EASY でもプレイ開始し、低難易度が壊れていないことを確認

---

## 8. デプロイ手順

```bash
git add -A
git commit -m "NEON BEATS難易度リバランス: EXPERT/MASTER引き上げ・GOD鬼/ネタ級化・最高Lv39"
git push
```

- push後、GitHub Actions「Deploy to GitHub Pages」が自動実行される(`gh run watch` で確認可)
- 完了したら https://legendmanbou.github.io/LOTSGAME/rhythm/ を開き、
  難易度Lvが新表記(最高39)になっていることを確認する

---

## 9. 完了条件チェックリスト

- [ ] ネオン・オーバードライブGODの表示が **Lv.39**(40はどこにも出ない)
- [ ] Lv表: EASY 5/8/11・NORMAL 11/14/17・HARD 18/21/24・EXPERT 27/30/33・MASTER 30/33/36・GOD 33/36/39
- [ ] EXPERT実測 ≒ 旧MASTER(4〜5nps)、MASTER実測 ≒ 旧GOD(7〜8nps)
- [ ] GOD実測: スターライト 9〜10nps / サイバー 10.5〜11.5nps / オーバードライブ 12〜13nps
- [ ] 同一レーン間隔0.16秒以上・同時押し2レーンまでを維持
- [ ] EASY/NORMAL/HARDは実質変化なし
- [ ] 「自分の曲」モードの難易度もスライド済み
- [ ] コンソールエラーなし・pushしてActionsが成功・本番URLで反映確認
