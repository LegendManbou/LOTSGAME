/* NEON BEATS — プロセカ風オリジナル音ゲー
   楽曲・譜面・デザインすべてオリジナル。WebAudioで作曲した内蔵曲と、
   端末内の音楽ファイルから譜面を自動生成するモードを持つ。 */

"use strict";

// ────────────────── ユーティリティ ──────────────────
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

// 再現性のある乱数(曲と譜面を同じ種から作るため)
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const midiFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

// ────────────────── 設定 ──────────────────
const SETTINGS = Object.assign(
  { speed: 6, offset: 0, skin: "neon", ap: true },
  JSON.parse(localStorage.getItem("nb_settings") || "{}")
);
function saveSettings() { localStorage.setItem("nb_settings", JSON.stringify(SETTINGS)); }
// ノーツの速さ(1〜12) → ノーツが降ってくる時間(秒)
const approachTime = () => clamp(3.0 / (0.55 + 0.3 * SETTINGS.speed), 0.45, 3.6);
const OFF = () => SETTINGS.offset / 1000; // タイミング調整(秒)

// ────────────────── オーディオ基盤 ──────────────────
let ctx = null, master = null, noiseBuf = null;

function audio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.connect(ctx.destination);
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(comp);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

function env(when, peak, decay, node) {
  node.gain.setValueAtTime(0.0001, when);
  node.gain.exponentialRampToValueAtTime(peak, when + 0.005);
  node.gain.exponentialRampToValueAtTime(0.0001, when + decay);
}

const INST = {
  kick(when) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(150, when);
    o.frequency.exponentialRampToValueAtTime(42, when + 0.1);
    env(when, 0.9, 0.18, g);
    o.connect(g).connect(master);
    o.start(when); o.stop(when + 0.2);
  },
  snare(when) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 1800; f.Q.value = 0.8;
    const g = ctx.createGain();
    env(when, 0.4, 0.13, g);
    s.connect(f).connect(g).connect(master);
    s.start(when, Math.random() * 0.4); s.stop(when + 0.15);
  },
  hat(when, acc) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 7800;
    const g = ctx.createGain();
    env(when, acc ? 0.22 : 0.11, acc ? 0.07 : 0.04, g);
    s.connect(f).connect(g).connect(master);
    s.start(when, Math.random() * 0.4); s.stop(when + 0.09);
  },
  bass(when, f0, dur) {
    const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = f0;
    const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 420;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.26, when + 0.01);
    g.gain.setValueAtTime(0.26, when + Math.max(0.02, dur * 0.7));
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(f).connect(g).connect(master);
    o.start(when); o.stop(when + dur + 0.05);
  },
  pad(when, freqs, dur) {
    for (const fr of freqs) {
      const o = ctx.createOscillator(); o.type = "triangle";
      o.frequency.value = fr; o.detune.value = (Math.random() - 0.5) * 10;
      const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 1000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(0.055, when + 0.12);
      g.gain.setValueAtTime(0.055, when + dur * 0.75);
      g.gain.linearRampToValueAtTime(0.0001, when + dur);
      o.connect(f).connect(g).connect(master);
      o.start(when); o.stop(when + dur + 0.05);
    }
  },
  lead(when, f0, dur, wave) {
    const o = ctx.createOscillator(); o.type = wave || "square"; o.frequency.value = f0;
    const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 2600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.13, when + 0.015);
    g.gain.setValueAtTime(0.13, when + Math.max(0.03, dur * 0.8));
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur + 0.03);
    o.connect(f).connect(g).connect(master);
    o.start(when); o.stop(when + dur + 0.1);
  },
  tapSfx(type) {
    const when = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = "sine";
    o.frequency.value = type === "flick" ? 1500 : type === "perfect" ? 1050 : 850;
    const g = ctx.createGain();
    env(when, 0.14, 0.06, g);
    o.connect(g).connect(master);
    o.start(when); o.stop(when + 0.08);
  },
  tick(when, acc) {
    const o = ctx.createOscillator(); o.type = "sine";
    o.frequency.value = acc ? 1320 : 880;
    const g = ctx.createGain();
    env(when, 0.2, 0.05, g);
    o.connect(g).connect(master);
    o.start(when); o.stop(when + 0.07);
  },
};

// ────────────────── 難易度 ──────────────────
const DIFFS = ["easy", "normal", "hard", "expert", "master", "god"];
const DIFF_META = {
  easy:   { label: "EASY",   color: "#46d275", lv: 2 },
  normal: { label: "NORMAL", color: "#38b6ff", lv: 8 },
  hard:   { label: "HARD",   color: "#ffb020", lv: 15 },
  expert: { label: "EXPERT", color: "#ff5c74", lv: 24 },
  master: { label: "MASTER", color: "#b46bff", lv: 27 },
  god:    { label: "GOD",    color: "#ffffff", lv: 30 },
};
// 譜面の密度パラメータ
const DIFF_PARAMS = {
  easy:   { gap: 0.50,  kick: 0,   snare: 0,    hat: 0,    bass: 0,   dbl: 0,    flick: false },
  normal: { gap: 0.30,  kick: 0.3, snare: 0,    hat: 0,    bass: 0,   dbl: 0,    flick: true  },
  hard:   { gap: 0.19,  kick: 1,   snare: 0.35, hat: 0,    bass: 0,   dbl: 0,    flick: true  },
  expert: { gap: 0.105, kick: 1,   snare: 1,    hat: 0.55, bass: 0,   dbl: 0.16, flick: true  },
  master: { gap: 0.075, kick: 1,   snare: 1,    hat: 0.9,  bass: 0.5, dbl: 0.30, flick: true  },
  god:    { gap: 0.058, kick: 1,   snare: 1,    hat: 1,    bass: 0.8, dbl: 0.42, flick: true  },
};

// ────────────────── 内蔵曲(自動作曲) ──────────────────
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

const SONG_DEFS = [
  { id: "starlight", name: "スターライト・ラン", emoji: "🌟", bpm: 126, seed: 11, bars: 34, root: 60, mode: "major", prog: [0, 5, 3, 4], wave: "triangle", lvBase: 3, desc: "キラキラ王道ポップ。はじめてはコレ!" },
  { id: "cyber", name: "サイバー・パレード", emoji: "🤖", bpm: 146, seed: 27, bars: 36, root: 57, mode: "minor", prog: [0, 5, 2, 6], wave: "square", lvBase: 6, desc: "ズンズン進むエレクトロ行進曲" },
  { id: "overdrive", name: "ネオン・オーバードライブ", emoji: "⚡", bpm: 168, seed: 42, bars: 38, root: 52, mode: "minor", prog: [0, 6, 5, 4], wave: "sawtooth", lvBase: 9, lvOv: { god: 38 }, desc: "最高速のクライマックス。腕が試される" },
  // GOD専用の裏ボス。lvBaseは譜面生成に使われるため9のまま、密度はdemonフラグで別枠制御
  { id: "demon", name: "デーモンズ・インフェルノ", emoji: "👹", bpm: 205, seed: 666, bars: 40, root: 48, mode: "minor", prog: [0, 1, 6, 5], wave: "sawtooth", lvBase: 9, godOnly: true, demon: true, desc: "GOD専用。逃げてもいいよ" },
];

// 曲データ(音イベント列)を種から決定的に生成する
function buildSong(def) {
  const rng = mulberry32(def.seed);
  const spb = 60 / def.bpm;               // 1拍の秒数
  const scale = def.mode === "major" ? MAJOR : MINOR;
  const deg = (d, oct = 0) => def.root + scale[((d % 7) + 7) % 7] + 12 * (Math.floor(d / 7) + oct);
  const ev = [];                          // {t(秒), inst, f, d, acc, strong, phraseEnd, pitch}
  const totalBeats = def.bars * 4;

  let mel = 7;                            // メロディの現在度数(スケール度数、7=1オクターブ上)
  for (let bar = 0; bar < def.bars; bar++) {
    const chordDeg = def.prog[bar % def.prog.length];
    const chord = [deg(chordDeg), deg(chordDeg + 2), deg(chordDeg + 4)];
    const barT = bar * 4 * spb;
    const intro = bar < 2, outro = bar >= def.bars - 2;

    // パッド(コード)
    ev.push({ t: barT, inst: "pad", freqs: chord.map((m) => midiFreq(m)), d: 4 * spb });

    // ドラム
    if (!intro) {
      for (let b = 0; b < 4; b++) {
        ev.push({ t: barT + b * spb, inst: b % 2 === 0 ? "kick" : "snare", strong: b % 2 === 0 });
        if (!outro && rng() < 0.85) ev.push({ t: barT + (b + 0.5) * spb, inst: "hat", acc: b === 3 });
      }
      if (!outro && rng() < 0.4) ev.push({ t: barT + 3.5 * spb, inst: "kick", strong: false });
    }

    // ベース(8分)
    if (!intro) {
      for (let e = 0; e < 8; e++) {
        const oct = e % 4 === 2 ? 0 : -1;
        ev.push({ t: barT + e * 0.5 * spb, inst: "bass", f: midiFreq(deg(chordDeg, oct) - 12), d: 0.5 * spb * 0.9, eighth: e });
      }
    }

    // メロディ(8分グリッドのランダムウォーク、コードトーン寄り)
    if (!intro && !outro) {
      let e = 0;
      while (e < 8) {
        if (rng() < 0.22) { e++; continue; }                       // 休符
        let durE = 1;                                              // 8分
        if (e % 2 === 0 && rng() < 0.16) durE = rng() < 0.5 ? 3 : 4; // たまにロング
        durE = Math.min(durE, 8 - e);
        const strongBeat = e % 4 === 0;
        if (strongBeat && rng() < 0.6) {
          const targets = [chordDeg, chordDeg + 2, chordDeg + 4].map((d) => d + 7);
          mel = targets[Math.floor(rng() * targets.length)];
        } else {
          mel += Math.floor(rng() * 5) - 2;
        }
        mel = clamp(mel, 5, 16);
        const phraseEnd = bar % 4 === 3 && e >= 6;
        ev.push({
          t: barT + e * 0.5 * spb, inst: "lead", f: midiFreq(deg(mel)),
          d: durE * 0.5 * spb * 0.92, wave: def.wave,
          melody: true, pitch: mel, durE, strong: strongBeat, phraseEnd,
        });
        e += durE;
      }
    }
  }
  ev.sort((a, b) => a.t - b.t);
  return { def, events: ev, spb, duration: totalBeats * spb + 2 };
}

// ── 親指2本用のレーン再配置(EXPERT/MASTER) ──
// ルール: レーン1・2=左親指 / 3・4=右親指。同時は左右1本ずつ最大2。交差禁止。
// ロング中はその親指が使えない+交差になるレーンも禁止(例: 2番ロング中は1番NG)。
// 間隔が短い連打は左右交互。置き場がないノーツだけ削除(ごく少数)。
function thumbify(notes, P) {
  notes.sort((a, b) => a.t - b.t || a.lane - b.lane);
  const FAST = 0.14;                        // これ未満の間隔は左右交互を強制
  const REUSE = Math.max(P.gap, 0.11);      // 同じレーンの再使用間隔
  const sideOf = (l) => (l <= 1 ? 0 : 1);
  // ロング中に押せるレーン(持ってる親指のレーンと、交差になるレーンを除く)
  const HOLD_ALLOW = [[1, 2, 3], [2, 3], [0, 1], [0, 1, 2]];
  const lastLaneT = [-9, -9, -9, -9];
  const holds = [];                         // {lane, end}
  let prevT = -9, prevSides = 0;            // 直前タイムスタンプとそのサイド(bit: 1=左 2=右)

  for (let i = 0; i < notes.length; i++) {
    const nt = notes[i];
    for (let h = holds.length - 1; h >= 0; h--) if (holds[h].end <= nt.t + 0.001) holds.splice(h, 1);

    const base = [0, 1, 2, 3].filter((l) => holds.every((h) => l !== h.lane && HOLD_ALLOW[h.lane].includes(l)));
    const mate = i > 0 && Math.abs(notes[i - 1].t - nt.t) < 0.0001 ? notes[i - 1] : null;
    const fastPrev = !mate && nt.t - prevT < FAST && (prevSides === 1 || prevSides === 2);
    const filters = [
      (l) => nt.t - lastLaneT[l] >= REUSE,                                  // レーン再使用
      (l) => !fastPrev || sideOf(l) !== (prevSides === 1 ? 0 : 1),          // 高速は左右交互
      (l) => !mate || sideOf(l) !== sideOf(mate.lane),                      // 同時は左右で
    ];
    // 置けない時は「再使用」だけゆるめる(左右交互・同時左右・交差は絶対条件)
    let allowed = base.filter((l) => filters.every((f) => f(l)));
    if (!allowed.length) allowed = base.filter((l) => filters[1](l) && filters[2](l));
    if (!allowed.length) { notes.splice(i, 1); i--; continue; }

    // 元のレーンに近い所を優先(メロディの形をなるべく残す)
    let best = allowed[0];
    for (const l of allowed) {
      if (Math.abs(l - nt.lane) < Math.abs(best - nt.lane) ||
          (Math.abs(l - nt.lane) === Math.abs(best - nt.lane) && lastLaneT[l] < lastLaneT[best])) best = l;
    }
    nt.lane = best;
    lastLaneT[best] = nt.type === "hold" ? nt.t + nt.dur : nt.t;
    if (nt.type === "hold") holds.push({ lane: best, end: nt.t + nt.dur });
    if (Math.abs(nt.t - prevT) < 0.0001) prevSides |= sideOf(best) + 1;
    else { prevT = nt.t; prevSides = sideOf(best) + 1; }
  }
}

// 内蔵曲の譜面: メロディ+ドラムから難易度別に生成
function chartFromSong(song, dif) {
  const { events, spb } = song;
  const P = DIFF_PARAMS[dif];
  const laneOf = (pitch) => clamp(Math.floor((pitch - 5) / 3), 0, 3);
  const notes = [];
  let lastT = -9;
  const lastLaneT = [-9, -9, -9, -9];

  const laneGap = dif === "god" ? 0.16 : 0.22;
  const laneFree = (l, t) => t - lastLaneT[l] >= Math.max(P.gap, laneGap);

  const push = (t, lane, type, dur, canDouble) => {
    if (t - lastT < P.gap && type !== "hold") return false;
    const chordSize = notes.reduce((count, n) => count + (Math.abs(n.t - t) < 0.0001 ? 1 : 0), 0);
    if (chordSize >= 2) return false;
    for (let k = 0; k < 4; k++) {
      const l = (lane + k) % 4;
      if (laneFree(l, t)) {
        notes.push({ t, lane: l, type, dur: dur || 0 });
        lastT = t; lastLaneT[l] = type === "hold" ? t + dur : t;
        // 同時押し(高難易度のみ)
        if (chordSize === 0 && canDouble && P.dbl > 0 && Math.random() < P.dbl && type !== "hold") {
          const l2 = (l + 2) % 4;
          if (laneFree(l2, t)) {
            notes.push({ t, lane: l2, type, dur: 0 });
            lastLaneT[l2] = t;
          }
        }
        return true;
      }
    }
    return false;
  };

  for (const e of events) {
    if (e.melody) {
      const lane = laneOf(e.pitch);
      if (e.durE >= 3) push(e.t, lane, "hold", e.durE * 0.5 * spb * 0.9);
      else if (e.phraseEnd && P.flick) push(e.t, lane, "flick", 0, dif === "god" || dif === "master");
      else push(e.t, lane, "tap", 0, e.strong);
    } else if (e.inst === "kick" && e.strong && P.kick > 0) {
      if (Math.random() < P.kick) push(e.t, Math.random() < 0.5 ? 0 : 3, "tap", 0, true);
    } else if (e.inst === "snare" && P.snare > 0) {
      if (Math.random() < P.snare) push(e.t, Math.random() < 0.5 ? 1 : 2, "tap", 0, true);
    } else if (e.inst === "hat" && P.hat > 0) {
      if (Math.random() < P.hat) push(e.t, Math.floor(Math.random() * 4), "tap", 0, false);
    } else if (e.inst === "bass" && P.bass > 0 && e.eighth % 2 === 1) {
      if (Math.random() < P.bass) push(e.t, Math.floor(Math.random() * 4), "tap", 0, false);
    }
  }

  // MASTER/GOD: 16分音符ラッシュを敷きつめる(GODは神の領域)
  const rushP = dif === "god" ? 0.9 : dif === "master" ? 0.65 : dif === "expert" ? 0.14 : 0;
  if (rushP > 0) {
    const bars = song.def.bars;
    const s16 = spb / 4;
    for (let t = 2 * 4 * spb; t < (bars - 2) * 4 * spb; t += s16) {
      if (Math.random() >= rushP) continue;
      // 既存ノーツとの最小間隔(全体)
      let minD = Infinity;
      for (const n of notes) minD = Math.min(minD, Math.abs(n.t - t));
      if (minD < P.gap) continue;
      // 空いているレーンを探す(ロング中のレーンは避ける)
      const lane0 = Math.floor(Math.random() * 4);
      for (let k = 0; k < 4; k++) {
        const l = (lane0 + k) % 4;
        let free = true;
        for (const n of notes) {
          if (n.lane !== l) continue;
          const end = n.type === "hold" ? n.t + n.dur : n.t;
          if (t > n.t - laneGap && t < end + laneGap) { free = false; break; }
        }
        if (free) { notes.push({ t, lane: l, type: "tap", dur: 0 }); break; }
      }
    }
  }

  // Keep the slid recipes in their intended density bands on faster songs.
  if (dif === "expert" || dif === "master") {
    const targetNps = dif === "expert" ? 5 : 8;
    const chartStart = Math.min(...notes.map((n) => n.t));
    const chartEnd = Math.max(...notes.map((n) => n.t));
    const targetNotes = Math.floor(targetNps * (chartEnd - chartStart));
    const removeCount = Math.max(0, notes.length - targetNotes);
    if (removeCount > 0) {
      const removable = notes
        .map((n, i) => ({ n, i }))
        .filter(({ n }) => n.type !== "hold" && n.t !== chartStart && n.t !== chartEnd)
        .map(({ i }) => i);
      const rng = mulberry32(song.def.seed * 53 + (dif === "expert" ? 24 : 27));
      for (let i = removable.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [removable[i], removable[j]] = [removable[j], removable[i]];
      }
      const remove = new Set(removable.slice(0, removeCount));
      for (let i = notes.length - 1; i >= 0; i--) if (remove.has(i)) notes.splice(i, 1);
    }
    thumbify(notes, P);   // 親指2本で押せる配置に直す(密度はそのまま)
  }

  if (dif === "god") {
    const demon = !!song.def.demon;
    const godScale = clamp((song.def.lvBase - 3) / 6, 0, 1);
    // デーモンは完全ネタ枠: 32分グリッドで人間の限界を超える密度を敷く
    const targetNps = demon ? 16 : 9.5 + 3 * godScale;
    const start = 2 * 4 * spb;
    const end = (song.def.bars - 2) * 4 * spb;
    const chartStart = Math.min(...notes.map((n) => n.t));
    const chartEnd = Math.max(...notes.map((n) => n.t));
    const targetNotes = Math.floor(targetNps * (chartEnd - chartStart));
    const s24 = demon ? spb / 8 : spb / 6;
    const rng = mulberry32(song.def.seed * 97 + 39);

    const canPlace = (lane, t) => {
      let sameTime = 0;
      for (const n of notes) {
        if (Math.abs(n.t - t) < 0.0001) sameTime++;
        if (n.lane !== lane) continue;
        const noteEnd = n.type === "hold" ? n.t + n.dur : n.t;
        if (t > n.t - laneGap && t < noteEnd + laneGap) return false;
      }
      return sameTime < 2;
    };

    const addAt = (t, allowDouble) => {
      const lane0 = Math.floor(rng() * 4);
      let firstLane = -1;
      for (let k = 0; k < 4; k++) {
        const lane = (lane0 + k) % 4;
        if (!canPlace(lane, t)) continue;
        const phraseBurst = Math.floor((t - start) / spb) % 16 >= 14;
        const flickP = demon ? 0.6 : 0.2 + 0.35 * godScale;
        notes.push({ t, lane, type: phraseBurst || rng() < flickP ? "flick" : "tap", dur: 0 });
        firstLane = lane;
        break;
      }
      if (firstLane < 0 || !allowDouble || notes.length >= targetNotes) return;
      const lane2 = (firstLane + 2) % 4;
      const doubleP = demon ? 0.65 : 0.18 + 0.32 * godScale;
      if (rng() < doubleP && canPlace(lane2, t)) notes.push({ t, lane: lane2, type: "tap", dur: 0 });
    };

    // Spread additions across the full song; lower levels still favor phrase-end bursts.
    const candidates = [];
    for (let t = start; t < end; t += s24) {
      const beatInPhrase = Math.floor((t - start) / spb) % 16;
      const phraseWeight = beatInPhrase >= 14 ? 4 : godScale >= 0.5 && beatInPhrase >= 10 ? 2 : 1;
      const weight = godScale === 1 ? 1 : phraseWeight;
      candidates.push({ t, priority: rng() / weight });
    }
    candidates.sort((a, b) => a.priority - b.priority);
    for (const candidate of candidates) {
      if (notes.length >= targetNotes) break;
      addAt(candidate.t, true);
    }
  }

  notes.sort((a, b) => a.t - b.t);
  return notes;
}

// ────────────────── 自分の曲 → 譜面自動生成 ──────────────────
async function analyzeAudio(buffer, dif, onProgress) {
  const sr = buffer.sampleRate;
  const n = buffer.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / buffer.numberOfChannels;
  }

  // 低域/高域に分けてフレームRMSを計算(11.6msフレーム)
  const hop = Math.round(sr * 0.0116);
  const frames = Math.floor(n / hop) - 1;
  const rms = new Float32Array(frames), rmsL = new Float32Array(frames), rmsH = new Float32Array(frames);
  const a = 1 - Math.exp(-2 * Math.PI * 180 / sr); // ~180Hzローパス
  let lp = 0;
  for (let f = 0; f < frames; f++) {
    let s = 0, sl = 0, sh = 0;
    const off = f * hop;
    for (let i = 0; i < hop; i++) {
      const x = mono[off + i];
      lp += a * (x - lp);
      const hi = x - lp;
      s += x * x; sl += lp * lp; sh += hi * hi;
    }
    rms[f] = Math.sqrt(s / hop); rmsL[f] = Math.sqrt(sl / hop); rmsH[f] = Math.sqrt(sh / hop);
    if (f % 4000 === 0) { onProgress(Math.round((f / frames) * 80)); await new Promise((r) => setTimeout(r)); }
  }

  // オンセット(音の立ち上がり)= RMSの増分
  const flux = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    flux[f] = Math.max(0, rms[f] - rms[f - 1]) + 0.6 * Math.max(0, rmsH[f] - rmsH[f - 1]);
  }
  // 適応しきい値(±0.75秒の平均+偏差)
  const W = Math.round(0.75 / (hop / sr));
  const minGap = { easy: 0.46, normal: 0.3, hard: 0.19, expert: 0.11, master: 0.08, god: 0.058 }[dif];
  const sdMul = { easy: 1.25, normal: 1.25, hard: 1.15, expert: 0.9, master: 0.72, god: 0.55 }[dif];
  const dblP = DIFF_PARAMS[dif].dbl;
  const notes = [];
  let lastT = -9, lastLane = 0, strongCount = 0;
  const lastLaneT = [-9, -9, -9, -9];
  onProgress(85);

  for (let f = 2; f < frames - 2; f++) {
    const lo = Math.max(0, f - W), hi = Math.min(frames, f + W);
    let mean = 0; for (let i = lo; i < hi; i++) mean += flux[i]; mean /= hi - lo;
    let sd = 0; for (let i = lo; i < hi; i++) sd += (flux[i] - mean) ** 2; sd = Math.sqrt(sd / (hi - lo));
    const thr = mean + sdMul * sd + 0.004;
    const t = (f * hop) / sr;
    if (flux[f] < thr) continue;
    if (!(flux[f] >= flux[f - 1] && flux[f] >= flux[f + 1])) continue;
    if (t - lastT < minGap) continue;

    // レーン: 低音優勢なら左寄り、高音優勢なら右寄り
    let lane;
    if (rmsL[f] > rmsH[f] * 1.15) lane = lastLane <= 1 ? (lastLane + 1) % 2 : 0;
    else if (rmsH[f] > rmsL[f] * 1.15) lane = lastLane >= 2 ? 2 + ((lastLane + 1) % 2) : 3;
    else lane = (lastLane + 1 + Math.floor(Math.random() * 2)) % 4;

    // 種類: 特に強い立ち上がりはフリック、直後が静かで長い間隔ならロング
    let type = "tap", dur = 0;
    const strong = flux[f] > mean + 2.6 * sd;
    if (strong) strongCount++;
    if (dif !== "easy" && strong && strongCount % 3 === 0) type = "flick";

    if (type !== "flick") {
      // 先の音量が持続しているならロング
      const ahead = Math.min(frames, f + Math.round(0.7 / (hop / sr)));
      let sus = 0; for (let i = f; i < ahead; i++) sus += rms[i]; sus /= ahead - f;
      if (sus > rms[f] * 0.55 && t - lastT > 0.8 && Math.random() < (dif === "easy" || dif === "normal" ? 0.35 : 0.5)) {
        type = "hold"; dur = clamp(dif === "easy" ? 1.0 : 0.8, 0.5, 2.2);
      }
    }
    const laneGap = dif === "god" ? 0.16 : 0.22;
    if (t - lastLaneT[lane] < laneGap) lane = (lane + 2) % 4;
    if (t - lastLaneT[lane] < laneGap) continue;
    if (t < 1.2) continue; // 曲頭は空ける

    notes.push({ t, lane, type, dur });
    lastT = t; lastLane = lane; lastLaneT[lane] = type === "hold" ? t + dur : t;

    // 高難易度: 強い音で同時押し
    if (dblP > 0 && strong && type === "tap" && Math.random() < dblP) {
      const l2 = (lane + 2) % 4;
      if (t - lastLaneT[l2] >= laneGap) {
        notes.push({ t, lane: l2, type: "tap", dur: 0 });
        lastLaneT[l2] = t;
      }
    }
    if (f % 2000 === 0) { onProgress(85 + Math.round((f / frames) * 15)); await new Promise((r) => setTimeout(r)); }
  }
  onProgress(100);
  return notes;
}

// ────────────────── ゲーム状態 ──────────────────
const LANES = 4;
const KEYS = { KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3 };
const WIN = { perfect: 0.055, great: 0.105, good: 0.145 };
const WEIGHT = { perfect: 1, great: 0.7, good: 0.4, miss: 0 };

let state = "select";
let diff = "normal";
let current = null;      // {song(内蔵) | buffer(カスタム), name, id, duration}
let chart = [];
let totalElems = 0;
let startTime = 0;       // ctx.currentTime基準の曲開始時刻
let evIdx = 0, schedTimer = 0;
let customSrc = null;
let holdKeys = [null, null, null, null];   // レーンごとの押下中ホールド {note}
let counts, weightSum, combo, maxCombo, score, apAlive;
let effects = [];        // ヒットエフェクト
let songDone = false, resultShown = false;

const canvas = $("stage"), g2d = canvas.getContext("2d");
let W = 0, H = 0, DPR = 1;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = W * DPR; canvas.height = H * DPR;
  g2d.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener("resize", resize);
resize();

// ── 画面ジオメトリ(奥行き表現) ──
const PERSP = 7;
const easeZ = (p) => (Math.pow(PERSP, clamp(p, 0, 1.06)) - 1) / (PERSP - 1);
function geo() {
  const bw = Math.min(W * 0.95, 540);
  return { bw, tw: bw * 0.24, horizon: H * 0.14, judge: H * 0.8 };
}
function laneRect(lane, p) {
  const { bw, tw, horizon, judge } = geo();
  const e = easeZ(p);
  const w = lerp(tw, bw, e);
  const y = lerp(horizon, judge, e);
  const x = W / 2 - w / 2 + (lane * w) / LANES;
  return { x, y, w: w / LANES, e };
}

// ────────────────── 描画 ──────────────────
const CAT_COLORS = { tap: "#4ffcff", flick: "#ff6bd6", hold: "#7dffa9" };

function draw() {
  g2d.clearRect(0, 0, W, H);
  const { bw, tw, horizon, judge } = geo();
  const now = playNow();
  const approach = approachTime();

  // ステージ(台形)
  const grad = g2d.createLinearGradient(0, horizon, 0, judge);
  grad.addColorStop(0, "rgba(255,255,255,0.02)");
  grad.addColorStop(1, "rgba(90,70,200,0.22)");
  g2d.fillStyle = grad;
  g2d.beginPath();
  g2d.moveTo(W / 2 - tw / 2, horizon);
  g2d.lineTo(W / 2 + tw / 2, horizon);
  g2d.lineTo(W / 2 + bw / 2, judge);
  g2d.lineTo(W / 2 - bw / 2, judge);
  g2d.closePath();
  g2d.fill();

  // レーン区切り
  g2d.strokeStyle = "rgba(150,150,255,0.32)";
  g2d.lineWidth = 1;
  for (let l = 0; l <= LANES; l++) {
    g2d.beginPath();
    g2d.moveTo(W / 2 - tw / 2 + (l * tw) / LANES, horizon);
    g2d.lineTo(W / 2 - bw / 2 + (l * bw) / LANES, judge);
    g2d.stroke();
  }

  // 判定ライン(AP継続中は虹色に光る)
  g2d.save();
  if (state === "play" && SETTINGS.ap && apAlive && combo > 0) {
    const hue = (performance.now() / 8) % 360;
    const rainGrad = g2d.createLinearGradient(W / 2 - bw / 2, 0, W / 2 + bw / 2, 0);
    for (let i = 0; i <= 6; i++) {
      rainGrad.addColorStop(i / 6, `hsl(${(hue + i * 60) % 360}, 100%, 70%)`);
    }
    g2d.shadowColor = `hsl(${hue}, 100%, 70%)`; g2d.shadowBlur = 22;
    g2d.strokeStyle = rainGrad; g2d.lineWidth = 5;
  } else {
    g2d.shadowColor = "#4ffcff"; g2d.shadowBlur = 16;
    g2d.strokeStyle = "#b7fdff"; g2d.lineWidth = 4;
  }
  g2d.beginPath();
  g2d.moveTo(W / 2 - bw / 2 - 6, judge);
  g2d.lineTo(W / 2 + bw / 2 + 6, judge);
  g2d.stroke();
  g2d.restore();

  // 押下中レーンのハイライト
  for (let l = 0; l < LANES; l++) {
    if (!laneActive[l]) continue;
    const b = laneRect(l, 1);
    const t = laneRect(l, 0);
    g2d.fillStyle = "rgba(79,252,255,0.08)";
    g2d.beginPath();
    g2d.moveTo(t.x, t.y); g2d.lineTo(t.x + t.w, t.y);
    g2d.lineTo(b.x + b.w, b.y); g2d.lineTo(b.x, b.y);
    g2d.closePath(); g2d.fill();
  }

  if (state === "play" || state === "paused") {
    // ノーツ
    for (const nt of chart) {
      if (nt.judged && nt.type !== "hold") continue;
      if (nt.type === "hold" && nt.endJudged) continue;
      const pS = 1 - (nt.t - now) / approach;
      if (nt.type === "hold") {
        const pE = 1 - (nt.t + nt.dur - now) / approach;
        if (pE > 1.06 || pS < -0.05) continue;
        drawHold(nt, pS, pE);
      } else {
        if (pS < -0.05 || pS > 1.06) continue;
        drawNote(nt, pS);
      }
    }
    // エフェクト
    const tNow = performance.now();
    effects = effects.filter((fx) => tNow - fx.t0 < 400);
    for (const fx of effects) drawFx(fx, (tNow - fx.t0) / 400);
  }
}

// ノーツ本体(スキン別)
function noteBar(lane, p, color, hFactor) {
  const r = laneRect(lane, p);
  const h = (6 + 16 * r.e) * (hFactor || 1);
  const pad = r.w * 0.07;
  const skin = SETTINGS.skin;
  g2d.save();
  if (skin === "classic") {
    // クラシック: フラットな板
    g2d.fillStyle = color;
    g2d.fillRect(r.x + pad, r.y - h / 2, r.w - pad * 2, h);
    g2d.strokeStyle = "rgba(255,255,255,.9)";
    g2d.lineWidth = 1.5;
    g2d.strokeRect(r.x + pad, r.y - h / 2, r.w - pad * 2, h);
  } else if (skin === "crystal") {
    // クリスタル: ひし形の宝石
    const cx = r.x + r.w / 2, cy = r.y;
    const hw = (r.w - pad * 2) / 2, hh = h * 1.15;
    const gr = g2d.createLinearGradient(cx, cy - hh, cx, cy + hh);
    gr.addColorStop(0, "rgba(255,255,255,.95)");
    gr.addColorStop(0.5, color);
    gr.addColorStop(1, color);
    g2d.shadowColor = color; g2d.shadowBlur = 16 * r.e;
    g2d.fillStyle = gr;
    g2d.beginPath();
    g2d.moveTo(cx, cy - hh);
    g2d.lineTo(cx + hw, cy);
    g2d.lineTo(cx, cy + hh);
    g2d.lineTo(cx - hw, cy);
    g2d.closePath();
    g2d.fill();
    g2d.strokeStyle = "rgba(255,255,255,.8)";
    g2d.lineWidth = 1;
    g2d.stroke();
  } else {
    // ネオン(標準): 光る丸棒
    g2d.shadowColor = color; g2d.shadowBlur = 14 * r.e;
    g2d.fillStyle = color;
    roundRect(r.x + pad, r.y - h / 2, r.w - pad * 2, h, h / 2.4);
    g2d.fill();
    g2d.fillStyle = "rgba(255,255,255,0.85)";
    roundRect(r.x + pad + 3, r.y - h / 6, r.w - pad * 2 - 6, h / 3, h / 6);
    g2d.fill();
  }
  g2d.restore();
  return r;
}

function roundRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g2d.beginPath();
  g2d.moveTo(x + r, y);
  g2d.arcTo(x + w, y, x + w, y + h, r);
  g2d.arcTo(x + w, y + h, x, y + h, r);
  g2d.arcTo(x, y + h, x, y, r);
  g2d.arcTo(x, y, x + w, y, r);
  g2d.closePath();
}

function drawNote(nt, p) {
  const color = CAT_COLORS[nt.type];
  const r = noteBar(nt.lane, p, color);
  if (nt.type === "flick") {
    // 上向き矢印
    g2d.save();
    g2d.fillStyle = "#fff";
    g2d.shadowColor = color; g2d.shadowBlur = 10;
    const cx = r.x + r.w / 2, s = 5 + 7 * r.e, y = r.y - (10 + 14 * r.e);
    g2d.beginPath();
    g2d.moveTo(cx, y - s);
    g2d.lineTo(cx + s, y + s * 0.7);
    g2d.lineTo(cx - s, y + s * 0.7);
    g2d.closePath();
    g2d.fill();
    g2d.restore();
  }
}

function drawHold(nt, pS, pE) {
  const holding = nt.holding;
  const pTop = clamp(pE, 0, 1.0);
  const pBot = holding ? 1 : clamp(pS, 0, 1.0);
  const a = laneRect(nt.lane, pBot), b = laneRect(nt.lane, pTop);
  const padA = a.w * 0.16, padB = b.w * 0.16;
  g2d.fillStyle = holding ? "rgba(125,255,169,0.5)" : "rgba(125,255,169,0.3)";
  g2d.beginPath();
  g2d.moveTo(a.x + padA, a.y);
  g2d.lineTo(a.x + a.w - padA, a.y);
  g2d.lineTo(b.x + b.w - padB, b.y);
  g2d.lineTo(b.x + padB, b.y);
  g2d.closePath();
  g2d.fill();
  if (!nt.judged && pS >= -0.05 && pS <= 1.06) noteBar(nt.lane, pS, CAT_COLORS.hold);
  if (pE >= -0.05) noteBar(nt.lane, pTop, CAT_COLORS.hold, 0.8);
}

function drawFx(fx, k) {
  const r = laneRect(fx.lane, 1);
  const cx = r.x + r.w / 2, cy = r.y;
  g2d.save();
  g2d.globalAlpha = 1 - k;
  g2d.strokeStyle = fx.color;
  g2d.lineWidth = 3;
  g2d.shadowColor = fx.color; g2d.shadowBlur = 18;
  g2d.beginPath();
  g2d.arc(cx, cy, 8 + k * 46, 0, Math.PI * 2);
  g2d.stroke();
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2 + fx.seed;
    const d = 10 + k * 60;
    g2d.fillStyle = fx.color;
    g2d.beginPath();
    g2d.arc(cx + Math.cos(ang) * d, cy + Math.sin(ang) * d * 0.5, 3 * (1 - k), 0, Math.PI * 2);
    g2d.fill();
  }
  g2d.restore();
}

// ────────────────── 進行 ──────────────────
function playNow() {
  return ctx ? ctx.currentTime - startTime : -99;
}

function loop() {
  if (state === "play") {
    const now = playNow();
    const nowJ = now - OFF(); // 判定用(タイミング調整込み)
    // MISS判定
    for (const nt of chart) {
      if (!nt.judged && nowJ - nt.t > WIN.good) {
        nt.judged = true;
        registerJudge("miss", nt.lane, false);
        if (nt.type === "hold") { nt.endJudged = true; registerJudge("miss", nt.lane, false); }
      }
      if (nt.type === "hold" && nt.judged && !nt.endJudged) {
        if (nt.holding && now >= nt.t + nt.dur) {
          nt.endJudged = true; nt.holding = false;
          holdKeys[nt.lane] = null;
          registerJudge("perfect", nt.lane, true);
        } else if (!nt.holding && nowJ - (nt.t + nt.dur) > WIN.good) {
          nt.endJudged = true;
          registerJudge("miss", nt.lane, false);
        }
      }
    }
    $("progFill").style.width = clamp((now / current.duration) * 100, 0, 100) + "%";
    if (!songDone && now > current.duration + 0.6) {
      songDone = true;
      setTimeout(showResult, 900);
    }
  }
  draw();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ────────────────── 判定 ──────────────────
function judgeName(dt) {
  const a = Math.abs(dt);
  if (a <= WIN.perfect) return "perfect";
  if (a <= WIN.great) return "great";
  if (a <= WIN.good) return "good";
  return null;
}

function registerJudge(name, lane, withFx, dt) {
  counts[name]++;
  weightSum += WEIGHT[name];
  if (name !== "perfect") apAlive = false;
  if (name === "miss") combo = 0;
  else { combo++; maxCombo = Math.max(maxCombo, combo); }
  score = Math.round((1000000 * weightSum) / totalElems);
  $("scoreView").textContent = score.toLocaleString();
  const cv = $("comboView");
  if (combo >= 2) { cv.classList.remove("hidden"); $("comboNum").textContent = combo; }
  else cv.classList.add("hidden");
  const jv = $("judgeView");
  jv.textContent = name.toUpperCase();
  jv.className = "judge-view " + name;
  void jv.offsetWidth;
  jv.classList.add("show");
  // FAST / SLOW 表示(PERFECT以外)
  const fs = $("fsView");
  if (dt != null && name !== "perfect" && name !== "miss") {
    const isFast = dt < 0;
    fs.textContent = isFast ? "FAST" : "SLOW";
    fs.className = "fs-view " + (isFast ? "fast" : "slow");
    void fs.offsetWidth;
    fs.classList.add("show");
  }
  if (withFx) {
    effects.push({ lane, color: name === "perfect" ? "#ffe066" : name === "great" ? "#4ffcff" : "#7dffa9", t0: performance.now(), seed: Math.random() * 6 });
  }
}

function findNote(lane, nowJ) {
  let best = null, bestA = Infinity;
  for (const nt of chart) {
    if (nt.judged || nt.lane !== lane) continue;
    const dt = nowJ - nt.t;
    if (dt < -WIN.good || dt > WIN.good) continue;
    const a = Math.abs(dt);
    if (a < bestA) { best = nt; bestA = a; }
  }
  return best;
}

function hitLane(lane, isFlickGesture) {
  if (state !== "play") return;
  const nowJ = playNow() - OFF();
  const nt = findNote(lane, nowJ);
  if (!nt) return;
  if (nt.type === "flick" && !isFlickGesture && !allowKeyFlick) return; // タッチはフリック動作が必要
  const dt = nowJ - nt.t;
  const name = judgeName(dt);
  if (!name) return;
  nt.judged = true;
  if (nt.type === "hold") {
    nt.holding = true;
    holdKeys[lane] = nt;
  }
  INST.tapSfx(name === "perfect" ? "perfect" : nt.type === "flick" ? "flick" : "tap");
  registerJudge(name, lane, true, dt);
}

function releaseLane(lane) {
  const nt = holdKeys[lane];
  if (!nt) return;
  holdKeys[lane] = null;
  if (nt.endJudged || !nt.holding) return;
  nt.holding = false;
  const dt = playNow() - OFF() - (nt.t + nt.dur);
  const name = judgeName(dt);
  nt.endJudged = true;
  if (name) { INST.tapSfx(name); registerJudge(name, lane, true, dt); }
  else registerJudge("miss", lane, false);
}

// ────────────────── 入力 ──────────────────
let laneActive = [false, false, false, false];
let allowKeyFlick = false; // キーボード/マウス時はフリックもキーでOK
const touches = new Map();

function laneFromX(x) {
  const { bw } = geo();
  return clamp(Math.floor((x - (W / 2 - bw / 2)) / (bw / LANES)), 0, LANES - 1);
}

canvas.addEventListener("touchstart", (e) => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    const lane = laneFromX(t.clientX);
    touches.set(t.identifier, { lane, x: t.clientX, y: t.clientY, t0: performance.now(), flicked: false });
    laneActive[lane] = true;
    allowKeyFlick = false;
    hitLane(lane, false);
  }
}, { passive: false });

canvas.addEventListener("touchmove", (e) => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    const tr = touches.get(t.identifier);
    if (!tr || tr.flicked) continue;
    const dy = tr.y - t.clientY, dx = Math.abs(t.clientX - tr.x);
    if (dy > 22 && dy > dx && performance.now() - tr.t0 < 260) {
      tr.flicked = true;
      hitLane(tr.lane, true);
    }
  }
}, { passive: false });

function touchEnd(e) {
  e.preventDefault();
  for (const t of e.changedTouches) {
    const tr = touches.get(t.identifier);
    if (tr) {
      releaseLane(tr.lane);
      if (![...touches.values()].some((o) => o !== tr && o.lane === tr.lane)) laneActive[tr.lane] = false;
      touches.delete(t.identifier);
    }
  }
}
canvas.addEventListener("touchend", touchEnd, { passive: false });
canvas.addEventListener("touchcancel", touchEnd, { passive: false });

// PC用: マウス
canvas.addEventListener("mousedown", (e) => {
  const lane = laneFromX(e.clientX);
  laneActive[lane] = true;
  allowKeyFlick = true; // マウスはフリック免除
  hitLane(lane, true);
  canvas._mouseLane = lane;
});
window.addEventListener("mouseup", () => {
  if (canvas._mouseLane != null) {
    releaseLane(canvas._mouseLane);
    laneActive[canvas._mouseLane] = false;
    canvas._mouseLane = null;
  }
});

// PC用: キーボード(D F J K)
window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (settingsOpen && e.code === "KeyD") { previewTap(); return; }
  const lane = KEYS[e.code];
  if (lane == null) return;
  laneActive[lane] = true;
  allowKeyFlick = true;
  hitLane(lane, true);
});
window.addEventListener("keyup", (e) => {
  const lane = KEYS[e.code];
  if (lane == null) return;
  laneActive[lane] = false;
  releaseLane(lane);
});

// ────────────────── 内蔵曲の再生スケジューラ ──────────────────
function startScheduler(song) {
  evIdx = 0;
  schedTimer = setInterval(() => {
    if (!ctx || state !== "play") return;
    const horizon = ctx.currentTime + 0.3;
    const evs = song.events;
    while (evIdx < evs.length && startTime + evs[evIdx].t < horizon) {
      const e = evs[evIdx];
      const when = startTime + e.t;
      if (when > ctx.currentTime - 0.05) {
        if (e.inst === "kick") INST.kick(when);
        else if (e.inst === "snare") INST.snare(when);
        else if (e.inst === "hat") INST.hat(when, e.acc);
        else if (e.inst === "bass") INST.bass(when, e.f, e.d);
        else if (e.inst === "pad") INST.pad(when, e.freqs, e.d);
        else if (e.inst === "lead") INST.lead(when, e.f, e.d, e.wave);
      }
      evIdx++;
    }
  }, 60);
}

// ────────────────── ゲーム開始/終了 ──────────────────
async function startGame(entry) {
  audio();
  current = entry;
  chart = entry.chart.map((n) => ({ ...n, judged: false, endJudged: false, holding: false }));
  totalElems = chart.reduce((s, n) => s + (n.type === "hold" ? 2 : 1), 0) || 1;
  counts = { perfect: 0, great: 0, good: 0, miss: 0 };
  weightSum = 0; combo = 0; maxCombo = 0; score = 0; apAlive = true;
  effects = []; songDone = false; resultShown = false;
  holdKeys = [null, null, null, null];
  $("scoreView").textContent = "0";
  $("comboView").classList.add("hidden");
  $("selectScreen").classList.add("hidden");
  $("resultScreen").classList.add("hidden");
  $("gameScreen").classList.remove("hidden");
  resize();

  // カウントダウン
  state = "countdown";
  const cd = $("countdown");
  cd.classList.remove("hidden");
  for (const n of ["3", "2", "1"]) {
    cd.textContent = n;
    await new Promise((r) => setTimeout(r, 700));
  }
  cd.classList.add("hidden");

  startTime = ctx.currentTime + 0.15;
  state = "play";
  if (entry.song) {
    startScheduler(entry.song);
  } else {
    customSrc = ctx.createBufferSource();
    customSrc.buffer = entry.buffer;
    const g = ctx.createGain(); g.gain.value = 0.9;
    customSrc.connect(g).connect(master);
    customSrc.start(startTime);
  }
}

function stopPlayback() {
  clearInterval(schedTimer);
  if (customSrc) { try { customSrc.stop(); } catch (_) {} customSrc = null; }
}

function showResult() {
  if (resultShown) return;
  resultShown = true;
  stopPlayback();
  state = "result";
  const pct = weightSum / totalElems;
  const rank = pct >= 0.95 ? "S" : pct >= 0.85 ? "A" : pct >= 0.7 ? "B" : pct >= 0.5 ? "C" : "D";
  const isAP = counts.miss === 0 && counts.great === 0 && counts.good === 0;
  const isFC = counts.miss === 0;
  const banner = $("resultBanner");
  if (isAP) { banner.textContent = "ALL PERFECT!!"; banner.className = "result-banner ap"; }
  else if (isFC) { banner.textContent = "FULL COMBO!"; banner.className = "result-banner fc"; }
  else banner.className = "result-banner hidden";
  $("resultRank").textContent = rank;
  $("resultRank").className = "result-rank" + (isAP && SETTINGS.ap ? " ap" : "");
  $("resultSong").textContent = `${current.name} [${DIFF_META[diff].label}${current.lv ? " Lv." + current.lv : ""}]`;
  $("resultScore").textContent = score.toLocaleString();
  $("cPerfect").textContent = counts.perfect;
  $("cGreat").textContent = counts.great;
  $("cGood").textContent = counts.good;
  $("cMiss").textContent = counts.miss;
  $("cCombo").textContent = maxCombo;
  const hsKey = `nb_hs_${current.id}_${diff}`;
  const prev = Number(localStorage.getItem(hsKey) || 0);
  const isNew = score > prev;
  if (isNew) localStorage.setItem(hsKey, String(score));
  $("resultNew").classList.toggle("hidden", !isNew);
  $("resultScreen").classList.remove("hidden");
  renderSongList();
}

function backToSelect() {
  stopPlayback();
  state = "select";
  $("gameScreen").classList.add("hidden");
  $("pauseOverlay").classList.add("hidden");
  $("resultScreen").classList.add("hidden");
  $("selectScreen").classList.remove("hidden");
  renderSongList();
}

// ────────────────── ポーズ ──────────────────
$("pauseBtn").onclick = () => {
  if (state !== "play") return;
  state = "paused";
  ctx.suspend();
  $("pauseOverlay").classList.remove("hidden");
};
$("resumeBtn").onclick = () => {
  $("pauseOverlay").classList.add("hidden");
  ctx.resume().then(() => { state = "play"; });
};
$("retryBtn").onclick = () => {
  $("pauseOverlay").classList.add("hidden");
  stopPlayback();
  ctx.resume().then(() => startGame(current));
};
$("quitBtn").onclick = () => { ctx.resume(); backToSelect(); };
$("resultRetryBtn").onclick = () => startGame(current);
$("resultBackBtn").onclick = backToSelect;

// ────────────────── 曲選択UI ──────────────────
const builtSongs = new Map(); // id -> song

function getSong(def) {
  if (!builtSongs.has(def.id)) builtSongs.set(def.id, buildSong(def));
  return builtSongs.get(def.id);
}

function songLv(def) { return (def.lvOv && def.lvOv[diff] != null) ? def.lvOv[diff] : def.lvBase + DIFF_META[diff].lv; }

function renderSongList() {
  const list = $("songList");
  list.innerHTML = "";
  for (const def of SONG_DEFS) {
    if (def.godOnly && diff !== "god") continue;
    const card = document.createElement("div");
    card.className = def.demon ? "song-card demon-card" : "song-card";
    const hs = localStorage.getItem(`nb_hs_${def.id}_${diff}`);
    const m = DIFF_META[diff];
    const lvStyle = def.demon
      ? `background:linear-gradient(90deg,#ff1e1e,#ff6a00,#ff1e5e);color:#fff;text-shadow:0 0 6px rgba(0,0,0,.6);`
      : diff === "god"
      ? `background:linear-gradient(90deg,#ff5c74,#ffe066,#7dffa9,#4ffcff,#b46bff);color:#111;`
      : `background:${m.color};`;
    card.innerHTML = `
      <div class="song-emoji">${def.emoji}</div>
      <div class="song-info">
        <div class="song-name">${def.name}</div>
        <div class="song-meta">BPM ${def.bpm}・${def.desc}</div>
        <span class="song-lv" style="${lvStyle}">${m.label} Lv.${songLv(def)}</span>
        ${hs ? `<div class="song-hs">じこベスト ${Number(hs).toLocaleString()}</div>` : ""}
      </div>`;
    const btn = document.createElement("button");
    btn.className = "play-btn";
    btn.textContent = "あそぶ";
    btn.onclick = () => {
      audio();
      const song = getSong(def);
      startGame({ id: def.id, name: def.name, song, duration: song.duration, lv: songLv(def), chart: chartFromSong(song, diff) });
    };
    card.appendChild(btn);
    list.appendChild(card);
  }
}

// 難易度切り替え
document.querySelectorAll(".diff-btn").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".diff-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    diff = b.dataset.diff;
    localStorage.setItem("nb_diff", diff);
    renderSongList();
  };
});
const savedDiff = localStorage.getItem("nb_diff");
if (savedDiff && DIFFS.includes(savedDiff)) {
  diff = savedDiff;
  document.querySelectorAll(".diff-btn").forEach((x) => x.classList.toggle("active", x.dataset.diff === diff));
}

// ────────────────── 設定モーダル ──────────────────
let settingsOpen = false;
let prevNotes = [];      // プレビューのノーツ時刻(ctx.currentTime基準)
let prevRaf = 0, prevSched = 0, prevFeedTimer = 0;
const prevCanvas = $("prevCanvas");
const pg = prevCanvas.getContext("2d");

function syncSettingsUI() {
  $("speedRange").value = SETTINGS.speed;
  $("speedVal").textContent = Number(SETTINGS.speed).toFixed(1);
  $("offsetRange").value = SETTINGS.offset;
  $("offsetVal").textContent = (SETTINGS.offset >= 0 ? "+" : "") + SETTINGS.offset + "ms";
  document.querySelectorAll(".skin-chip").forEach((c) => c.classList.toggle("active", c.dataset.skin === SETTINGS.skin));
  $("apToggle").classList.toggle("on", !!SETTINGS.ap);
}

function openSettings() {
  audio();
  settingsOpen = true;
  syncSettingsUI();
  $("settingsOverlay").classList.remove("hidden");
  // プレビューキャンバス初期化
  const rect = prevCanvas.getBoundingClientRect();
  prevCanvas.width = rect.width * DPR;
  prevCanvas.height = 170 * DPR;
  pg.setTransform(DPR, 0, 0, DPR, 0, 0);
  prevNotes = [];
  // 0.75秒間隔でノーツを流す(メトロノーム)
  prevSched = setInterval(() => {
    let last = prevNotes.length ? prevNotes[prevNotes.length - 1] : ctx.currentTime + 0.5;
    while (last < ctx.currentTime + 2.5) {
      last += 0.75;
      prevNotes.push(last);
      INST.tick(last, prevNotes.length % 4 === 0);
    }
    prevNotes = prevNotes.filter((t) => t > ctx.currentTime - 2);
  }, 200);
  const drawPrev = () => {
    if (!settingsOpen) return;
    const w = prevCanvas.getBoundingClientRect().width, h = 170;
    pg.clearRect(0, 0, w, h);
    const judgeY = h * 0.78, laneW = 64, cx = w / 2;
    // レーン
    pg.fillStyle = "rgba(90,70,200,0.18)";
    pg.fillRect(cx - laneW / 2, 0, laneW, h);
    pg.strokeStyle = "rgba(150,150,255,0.3)";
    pg.strokeRect(cx - laneW / 2, 0, laneW, h);
    // 判定ライン
    pg.save();
    pg.shadowColor = "#4ffcff"; pg.shadowBlur = 10;
    pg.strokeStyle = "#b7fdff"; pg.lineWidth = 3;
    pg.beginPath(); pg.moveTo(cx - laneW / 2 - 8, judgeY); pg.lineTo(cx + laneW / 2 + 8, judgeY); pg.stroke();
    pg.restore();
    // ノーツ(現在の速さ設定で落下)
    const ap = approachTime();
    for (const t of prevNotes) {
      const p = 1 - (t - ctx.currentTime) / ap;
      if (p < 0 || p > 1.05) continue;
      const y = p * judgeY;
      pg.save();
      const skin = SETTINGS.skin;
      if (skin === "classic") {
        pg.fillStyle = "#4ffcff";
        pg.fillRect(cx - laneW / 2 + 5, y - 6, laneW - 10, 12);
        pg.strokeStyle = "#fff"; pg.strokeRect(cx - laneW / 2 + 5, y - 6, laneW - 10, 12);
      } else if (skin === "crystal") {
        pg.shadowColor = "#4ffcff"; pg.shadowBlur = 10;
        pg.fillStyle = "#4ffcff";
        pg.beginPath();
        pg.moveTo(cx, y - 12); pg.lineTo(cx + laneW / 2 - 6, y); pg.lineTo(cx, y + 12); pg.lineTo(cx - laneW / 2 + 6, y);
        pg.closePath(); pg.fill();
      } else {
        pg.shadowColor = "#4ffcff"; pg.shadowBlur = 10;
        pg.fillStyle = "#4ffcff";
        if (pg.roundRect) {
          pg.beginPath();
          pg.roundRect(cx - laneW / 2 + 5, y - 7, laneW - 10, 14, 7);
          pg.fill();
          pg.fillStyle = "rgba(255,255,255,.85)";
          pg.beginPath();
          pg.roundRect(cx - laneW / 2 + 9, y - 2.5, laneW - 18, 5, 3);
          pg.fill();
        } else {
          pg.fillRect(cx - laneW / 2 + 5, y - 7, laneW - 10, 14);
        }
      }
      pg.restore();
    }
    prevRaf = requestAnimationFrame(drawPrev);
  };
  drawPrev();
}

function closeSettings() {
  settingsOpen = false;
  clearInterval(prevSched);
  cancelAnimationFrame(prevRaf);
  saveSettings();
  $("settingsOverlay").classList.add("hidden");
}

function previewTap() {
  if (!settingsOpen || !prevNotes.length) return;
  const nowJ = ctx.currentTime - OFF();
  let best = null, bestA = Infinity;
  for (const t of prevNotes) {
    const a = Math.abs(nowJ - t);
    if (a < bestA) { best = t; bestA = a; }
  }
  if (best == null || bestA > 0.3) return;
  const dt = nowJ - best;
  const name = judgeName(dt) || (dt < 0 ? "fast" : "slow");
  const feed = $("prevFeed");
  const ms = Math.round(dt * 1000);
  const fsTxt = name === "perfect" ? "" : dt < 0 ? " (FAST)" : " (SLOW)";
  feed.textContent = `${name.toUpperCase()}${fsTxt} ${ms >= 0 ? "+" : ""}${ms}ms`;
  feed.className = "prev-feed " + (["perfect", "great", "good"].includes(name) ? name : dt < 0 ? "fast" : "slow");
  INST.tapSfx(name === "perfect" ? "perfect" : "tap");
  clearTimeout(prevFeedTimer);
  prevFeedTimer = setTimeout(() => { feed.innerHTML = "&nbsp;"; }, 900);
}

$("settingsBtn").onclick = openSettings;
$("settingsClose").onclick = closeSettings;
$("settingsSave").onclick = closeSettings;
$("settingsOverlay").addEventListener("click", (e) => { if (e.target === $("settingsOverlay")) closeSettings(); });

$("speedRange").oninput = (e) => {
  SETTINGS.speed = Number(e.target.value);
  $("speedVal").textContent = SETTINGS.speed.toFixed(1);
};
$("offsetRange").oninput = (e) => {
  SETTINGS.offset = Number(e.target.value);
  $("offsetVal").textContent = (SETTINGS.offset >= 0 ? "+" : "") + SETTINGS.offset + "ms";
};
document.querySelectorAll(".skin-chip").forEach((c) => {
  c.onclick = () => {
    SETTINGS.skin = c.dataset.skin;
    document.querySelectorAll(".skin-chip").forEach((x) => x.classList.toggle("active", x === c));
  };
});
$("apToggle").onclick = () => {
  SETTINGS.ap = !SETTINGS.ap;
  $("apToggle").classList.toggle("on", SETTINGS.ap);
};
prevCanvas.addEventListener("pointerdown", (e) => { e.preventDefault(); previewTap(); });

// 旧設定(nb_speed)からの引っ越し
const oldSpeed = localStorage.getItem("nb_speed");
if (oldSpeed && !localStorage.getItem("nb_settings")) {
  const map = { "2.0": 3, "1.6": 6, "1.2": 8.5, "0.95": 10 };
  if (map[oldSpeed]) { SETTINGS.speed = map[oldSpeed]; saveSettings(); }
  localStorage.removeItem("nb_speed");
}

// ────────────────── 自分の曲 ──────────────────
$("fileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const status = $("analyzeStatus");
  try {
    audio();
    status.textContent = "🎧 読み込み中…";
    const ab = await file.arrayBuffer();
    const buf = await ctx.decodeAudioData(ab);
    if (buf.duration > 600) { status.textContent = "10分以内の曲にしてね!"; return; }
    status.textContent = "🛠 譜面を生成中… 0%";
    const notes = await analyzeAudio(buf, diff, (p) => { status.textContent = `🛠 譜面を生成中… ${p}%`; });
    if (notes.length < 10) { status.textContent = "この曲からはノーツをうまく作れなかった…別の曲で試してみて!"; return; }
    status.textContent = "";
    startGame({
      id: "custom_" + file.name.slice(0, 30),
      name: file.name.replace(/\.[^.]+$/, ""),
      buffer: buf,
      duration: buf.duration,
      chart: notes,
    });
  } catch (err) {
    console.error(err);
    status.textContent = "この音楽ファイルは読み込めなかった…(mp3 / m4a / wav がおすすめ)";
  } finally {
    e.target.value = "";
  }
});

renderSongList();
