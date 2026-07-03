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
};

// ────────────────── 内蔵曲(自動作曲) ──────────────────
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

const SONG_DEFS = [
  { id: "starlight", name: "スターライト・ラン", emoji: "🌟", bpm: 126, seed: 11, bars: 34, root: 60, mode: "major", prog: [0, 5, 3, 4], wave: "triangle", desc: "キラキラ王道ポップ。はじめてはコレ!" },
  { id: "cyber", name: "サイバー・パレード", emoji: "🤖", bpm: 146, seed: 27, bars: 36, root: 57, mode: "minor", prog: [0, 5, 2, 6], wave: "square", desc: "ズンズン進むエレクトロ行進曲" },
  { id: "overdrive", name: "ネオン・オーバードライブ", emoji: "⚡", bpm: 168, seed: 42, bars: 38, root: 52, mode: "minor", prog: [0, 6, 5, 4], wave: "sawtooth", desc: "最高速のクライマックス。腕が試される" },
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
        ev.push({ t: barT + e * 0.5 * spb, inst: "bass", f: midiFreq(deg(chordDeg, oct) - 12), d: 0.5 * spb * 0.9 });
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

// 内蔵曲の譜面: メロディ+ドラムから難易度別に生成
function chartFromSong(song, diff) {
  const { events, spb } = song;
  const minGap = { easy: 0.5, normal: 0.3, hard: 0.18 }[diff];
  const laneOf = (pitch) => clamp(Math.floor((pitch - 5) / 3), 0, 3);
  const notes = [];
  let lastT = -9;
  const lastLaneT = [-9, -9, -9, -9];

  const push = (t, lane, type, dur) => {
    if (t - lastT < minGap && type !== "hold") return false;
    for (let k = 0; k < 4; k++) {
      const l = (lane + k) % 4;
      if (t - lastLaneT[l] >= Math.max(minGap, 0.24)) {
        notes.push({ t, lane: l, type, dur: dur || 0 });
        lastT = t; lastLaneT[l] = type === "hold" ? t + dur : t;
        return true;
      }
    }
    return false;
  };

  for (const e of events) {
    if (e.melody) {
      const lane = laneOf(e.pitch);
      if (e.durE >= 3) push(e.t, lane, "hold", e.durE * 0.5 * spb * 0.9);
      else if (e.phraseEnd && diff !== "easy") push(e.t, lane, "flick");
      else if (e.phraseEnd && Math.random() < 0) push(e.t, lane, "tap");
      else push(e.t, lane, "tap");
    } else if (diff === "hard" && e.inst === "kick" && e.strong) {
      push(e.t, Math.random() < 0.5 ? 0 : 3, "tap");
    } else if (diff === "hard" && e.inst === "snare") {
      if (Math.random() < 0.35) push(e.t, Math.random() < 0.5 ? 1 : 2, "tap");
    } else if (diff === "normal" && e.inst === "kick" && e.strong) {
      if (Math.random() < 0.3) push(e.t, Math.random() < 0.5 ? 0 : 3, "tap");
    }
  }
  notes.sort((a, b) => a.t - b.t);
  return notes;
}

// ────────────────── 自分の曲 → 譜面自動生成 ──────────────────
async function analyzeAudio(buffer, diff, onProgress) {
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
  const minGap = { easy: 0.46, normal: 0.3, hard: 0.19 }[diff];
  const notes = [];
  let lastT = -9, lastLane = 0, strongCount = 0;
  const lastLaneT = [-9, -9, -9, -9];
  onProgress(85);

  for (let f = 2; f < frames - 2; f++) {
    const lo = Math.max(0, f - W), hi = Math.min(frames, f + W);
    let mean = 0; for (let i = lo; i < hi; i++) mean += flux[i]; mean /= hi - lo;
    let sd = 0; for (let i = lo; i < hi; i++) sd += (flux[i] - mean) ** 2; sd = Math.sqrt(sd / (hi - lo));
    const thr = mean + 1.25 * sd + 0.004;
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
    if (diff !== "easy" && strong && strongCount % 3 === 0) type = "flick";

    if (type !== "flick") {
      // 先の音量が持続しているならロング
      const ahead = Math.min(frames, f + Math.round(0.7 / (hop / sr)));
      let sus = 0; for (let i = f; i < ahead; i++) sus += rms[i]; sus /= ahead - f;
      if (sus > rms[f] * 0.55 && t - lastT > 0.8 && Math.random() < (diff === "hard" ? 0.5 : 0.35)) {
        type = "hold"; dur = clamp(diff === "easy" ? 1.0 : 0.8, 0.5, 2.2);
      }
    }
    if (t - lastLaneT[lane] < 0.24) lane = (lane + 2) % 4;
    if (t - lastLaneT[lane] < 0.24) continue;
    if (t < 1.2) continue; // 曲頭は空ける

    notes.push({ t, lane, type, dur });
    lastT = t; lastLane = lane; lastLaneT[lane] = type === "hold" ? t + dur : t;
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
let approach = 1.6;
let current = null;      // {song(内蔵) | buffer(カスタム), name, id, duration}
let chart = [];
let totalElems = 0;
let startTime = 0;       // ctx.currentTime基準の曲開始時刻
let evIdx = 0, schedTimer = 0;
let customSrc = null;
let holdKeys = [null, null, null, null];   // レーンごとの押下中ホールド {note}
let counts, weightSum, combo, maxCombo, score;
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

  // ステージ(台形)
  const grad = g2d.createLinearGradient(0, horizon, 0, judge);
  grad.addColorStop(0, "rgba(255,255,255,0.02)");
  grad.addColorStop(1, "rgba(120,60,220,0.22)");
  g2d.fillStyle = grad;
  g2d.beginPath();
  g2d.moveTo(W / 2 - tw / 2, horizon);
  g2d.lineTo(W / 2 + tw / 2, horizon);
  g2d.lineTo(W / 2 + bw / 2, judge);
  g2d.lineTo(W / 2 - bw / 2, judge);
  g2d.closePath();
  g2d.fill();

  // レーン区切り
  g2d.strokeStyle = "rgba(160,140,255,0.35)";
  g2d.lineWidth = 1;
  for (let l = 0; l <= LANES; l++) {
    g2d.beginPath();
    g2d.moveTo(W / 2 - tw / 2 + (l * tw) / LANES, horizon);
    g2d.lineTo(W / 2 - bw / 2 + (l * bw) / LANES, judge);
    g2d.stroke();
  }

  // 判定ライン
  g2d.save();
  g2d.shadowColor = "#4ffcff"; g2d.shadowBlur = 16;
  g2d.strokeStyle = "#b7fdff"; g2d.lineWidth = 4;
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
        drawHold(nt, pS, pE, now);
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

function noteBar(lane, p, color, hFactor) {
  const r = laneRect(lane, p);
  const h = (6 + 16 * r.e) * (hFactor || 1);
  const pad = r.w * 0.07;
  g2d.save();
  g2d.shadowColor = color; g2d.shadowBlur = 14 * r.e;
  g2d.fillStyle = color;
  roundRect(r.x + pad, r.y - h / 2, r.w - pad * 2, h, h / 2.4);
  g2d.fill();
  g2d.fillStyle = "rgba(255,255,255,0.85)";
  roundRect(r.x + pad + 3, r.y - h / 6, r.w - pad * 2 - 6, h / 3, h / 6);
  g2d.fill();
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

function drawHold(nt, pS, pE, now) {
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
    // MISS判定
    for (const nt of chart) {
      if (!nt.judged && now - nt.t > WIN.good) {
        nt.judged = true;
        registerJudge("miss", nt.lane, false);
        if (nt.type === "hold") { nt.endJudged = true; registerJudge("miss", nt.lane, false); }
      }
      if (nt.type === "hold" && nt.judged && !nt.endJudged) {
        if (nt.holding && now >= nt.t + nt.dur) {
          nt.endJudged = true; nt.holding = false;
          holdKeys[nt.lane] = null;
          registerJudge("perfect", nt.lane, true);
        } else if (!nt.holding && now - (nt.t + nt.dur) > WIN.good) {
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

function registerJudge(name, lane, withFx) {
  counts[name]++;
  weightSum += WEIGHT[name];
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
  if (withFx) {
    effects.push({ lane, color: name === "perfect" ? "#ffe066" : name === "great" ? "#4ffcff" : "#7dffa9", t0: performance.now(), seed: Math.random() * 6 });
  }
}

function findNote(lane, now, flickOnly) {
  let best = null, bestA = Infinity;
  for (const nt of chart) {
    if (nt.judged || nt.lane !== lane) continue;
    if (flickOnly && nt.type !== "flick") continue;
    const dt = now - nt.t;
    if (dt < -WIN.good || dt > WIN.good) continue;
    const a = Math.abs(dt);
    if (a < bestA) { best = nt; bestA = a; }
  }
  return best;
}

function hitLane(lane, isFlickGesture) {
  if (state !== "play") return;
  const now = playNow();
  const nt = findNote(lane, now, false);
  if (!nt) return;
  if (nt.type === "flick" && !isFlickGesture && !allowKeyFlick) return; // タッチはフリック動作が必要
  const name = judgeName(now - nt.t);
  if (!name) return;
  nt.judged = true;
  if (nt.type === "hold") {
    nt.holding = true;
    holdKeys[lane] = nt;
  }
  INST.tapSfx(name === "perfect" ? "perfect" : nt.type === "flick" ? "flick" : "tap");
  registerJudge(name, lane, true);
}

function releaseLane(lane) {
  const nt = holdKeys[lane];
  if (!nt) return;
  holdKeys[lane] = null;
  if (nt.endJudged || !nt.holding) return;
  nt.holding = false;
  const now = playNow();
  const dt = now - (nt.t + nt.dur);
  const name = judgeName(dt);
  nt.endJudged = true;
  if (name) { INST.tapSfx(name); registerJudge(name, lane, true); }
  else if (dt < 0) registerJudge("miss", lane, false); // 早すぎる離し
  else registerJudge("miss", lane, false);
}

// ────────────────── 入力 ──────────────────
let laneActive = [false, false, false, false];
let allowKeyFlick = false; // キーボード時はフリックもキーでOK
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
  weightSum = 0; combo = 0; maxCombo = 0; score = 0;
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
  $("resultRank").textContent = rank;
  $("resultSong").textContent = `${current.name} [${diff.toUpperCase()}]`;
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

function renderSongList() {
  const list = $("songList");
  list.innerHTML = "";
  for (const def of SONG_DEFS) {
    const card = document.createElement("div");
    card.className = "song-card";
    const hs = localStorage.getItem(`nb_hs_${def.id}_${diff}`);
    card.innerHTML = `
      <div class="song-emoji">${def.emoji}</div>
      <div class="song-info">
        <div class="song-name">${def.name}</div>
        <div class="song-meta">BPM ${def.bpm}・${def.desc}</div>
        ${hs ? `<div class="song-hs">じこベスト ${Number(hs).toLocaleString()}</div>` : ""}
      </div>`;
    const btn = document.createElement("button");
    btn.className = "play-btn";
    btn.textContent = "あそぶ";
    btn.onclick = () => {
      audio();
      const song = getSong(def);
      startGame({ id: def.id, name: def.name, song, duration: song.duration, chart: chartFromSong(song, diff) });
    };
    card.appendChild(btn);
    list.appendChild(card);
  }
}

// 難易度・速度
document.querySelectorAll(".diff-btn").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".diff-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    diff = b.dataset.diff;
    localStorage.setItem("nb_diff", diff);
    renderSongList();
  };
});
$("speedSel").onchange = (e) => {
  approach = Number(e.target.value);
  localStorage.setItem("nb_speed", e.target.value);
};

// 保存された設定を復元
const savedDiff = localStorage.getItem("nb_diff");
if (savedDiff && ["easy", "normal", "hard"].includes(savedDiff)) {
  diff = savedDiff;
  document.querySelectorAll(".diff-btn").forEach((x) => x.classList.toggle("active", x.dataset.diff === diff));
}
const savedSpeed = localStorage.getItem("nb_speed");
if (savedSpeed) { approach = Number(savedSpeed); $("speedSel").value = savedSpeed; }

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
