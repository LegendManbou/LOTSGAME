/* NEON PK — 3DのPK対決(Three.js + PeerJS、すべて自作) */
import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";

// ────────────────── 定数 ──────────────────
const GOAL_W = 7.32, GOAL_H = 2.44;     // 実物大ゴール
const SPOT_Z = 11;                       // ペナルティスポット
const KEEPER_Z = 0.55;                   // キーパーの立ち位置(ゴール前)
const BALL_R = 0.13;
const TORSO_Y = 1.05;                    // キーパー胴体の中心高さ
const RUNUP = 1.15;                      // 助走の秒数(この間に守る準備!)
const DIVE_DUR = 0.55, DIVE_MAX = GOAL_W; // 飛びこみ(フルスワイプでゴール端から端まで)
const COLLIDE_D = 0.8;                   // キーパー同士がぶつかる距離(飛びこみ中のみ)
const KEEPER_X_MAX = GOAL_W / 2 - 0.45;  // スタート位置の左右かぎり
const MAX_KEEPERS = 9, MAX_MEMBERS = 10; // 最大10人(キッカー+キーパー9)
const MAX_BALLS = 3;                     // 同時に蹴れる最大人数
const slotXs = (n) => {                  // n人ぶんの初期位置をゴール幅に均等配置
  if (n <= 1) return [0];
  const span = 5.7 * (n - 1) / n;
  return Array.from({ length: n }, (_, i) => -span / 2 + (span * i) / (n - 1));
};
const ballSx = (slot, n) => (slot - (n - 1) / 2) * 2.2;   // 同時キック時のボール開始位置

const TEAMS = [
  { name: "レッド", emoji: "🔴", color: "#ff5c74" },
  { name: "ブルー", emoji: "🔵", color: "#4f9cff" },
  { name: "グリーン", emoji: "🟢", color: "#7dffa9" },
  { name: "イエロー", emoji: "🟡", color: "#ffe066" },
];
// CPUの強さ(guess=読み当てる率 / dive=飛びこみのブレ / wild=キックが枠外に暴れる率)
const CPU_LVS = [
  { guess: 0.45, dive: 1.3, wild: 0.25 },   // よわい
  { guess: 0.68, dive: 0.7, wild: 0.10 },   // ふつう
  { guess: 0.87, dive: 0.4, wild: 0.04 },   // つよい
];

const flightT = (pow) => 1.0 - 0.5 * pow;            // 強いほど速い
const arcH = (pow) => (1 - pow) * 1.0 + 0.12;        // 弱いほどふんわり
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const $ = (id) => document.getElementById(id);

// ────────────────── 状態 ──────────────────
const store = {
  get name() { return localStorage.getItem("lg_name") || ""; },
  set name(v) { localStorage.setItem("lg_name", v); },
  get lastRoom() { return localStorage.getItem("lg_room") || ""; },
  set lastRoom(v) { localStorage.setItem("lg_room", v); },
};

const G = {
  mode: "solo",            // solo | room
  phase: "lobby",          // lobby | set | aim | fly | verdict | final
  cfg: {
    keepers: 1, rounds: 5, cycles: 1,
    kickersN: 1,           // 同時に蹴る人数(ボールの数)
    setDur: 6,             // 配置タイム秒
    kickLimit: 12,         // キック制限秒
    cpuLevel: 1,           // 0よわい 1ふつう 2つよい
    sudden: false,         // サドンデス
    teamMode: false,
  },
  round: 0, totalRounds: 0,
  members: [],             // room: [{mid, name}] / solo: [{mid:0, name:あなた}]
  myMid: 0,
  kickers: [],             // 今ラウンドの蹴る人 [{mid|null, name, cpu, avatar}]
  keepers: [],             // [{mid|null, name, cpu, x, dive, avatar}]
  kicks: [],               // slotごと {sx,tx,ty,pow,crv,launchAt(ms)}|null
  teams: null,             // チーム戦: [{emoji,name,mids:[..]}]
  roundTeam: null,         // 今蹴ってるチームindex
  activeMids: null,        // 部屋: 試合に参加中のmid Set
  roundKickLimit: 12,
  scores: {},              // name -> pts
  myDove: false, myKicked: false,
  simCache: null,
};

// ────────────────── 3Dシーン ──────────────────
const renderer = new THREE.WebGLRenderer({ canvas: $("gl"), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x061530);
scene.fog = new THREE.Fog(0x061530, 30, 70);
const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 120);

scene.add(new THREE.AmbientLight(0xaabbff, 0.85));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(6, 14, 8);
scene.add(sun);
const goalGlow = new THREE.PointLight(0x4ffcff, 12, 18);
goalGlow.position.set(0, 3.4, 1.2);
scene.add(goalGlow);

// 芝生(ネオン夜スタジアム風)
{
  const field = new THREE.Mesh(new THREE.PlaneGeometry(46, 40), new THREE.MeshLambertMaterial({ color: 0x0b4d2b }));
  field.rotation.x = -Math.PI / 2;
  field.position.set(0, 0, 8);
  scene.add(field);
  for (let i = 0; i < 5; i++) {                       // しまもよう
    const s = new THREE.Mesh(new THREE.PlaneGeometry(46, 3.4), new THREE.MeshLambertMaterial({ color: 0x0d5c34 }));
    s.rotation.x = -Math.PI / 2;
    s.position.set(0, 0.005, 1.7 + i * 6.8);
    scene.add(s);
  }
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xd8ffe9 });
  const goalLine = new THREE.Mesh(new THREE.PlaneGeometry(20, 0.1), lineMat);
  goalLine.rotation.x = -Math.PI / 2;
  goalLine.position.set(0, 0.01, 0);
  scene.add(goalLine);
  const spot = new THREE.Mesh(new THREE.CircleGeometry(0.16, 24), lineMat);
  spot.rotation.x = -Math.PI / 2;
  spot.position.set(0, 0.011, SPOT_Z);
  scene.add(spot);
  const arc = new THREE.Mesh(new THREE.RingGeometry(5.4, 5.5, 48, 1, 0, Math.PI), new THREE.MeshBasicMaterial({ color: 0xd8ffe9, side: THREE.DoubleSide }));
  arc.rotation.x = -Math.PI / 2;
  arc.position.set(0, 0.012, SPOT_Z + 1);
  scene.add(arc);
}

// ゴール+ネット
{
  const postMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x334455, roughness: 0.35 });
  const mkPost = (x) => {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, GOAL_H, 12), postMat);
    p.position.set(x, GOAL_H / 2, 0);
    scene.add(p);
  };
  mkPost(-GOAL_W / 2); mkPost(GOAL_W / 2);
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, GOAL_W + 0.14, 12), postMat);
  bar.rotation.z = Math.PI / 2;
  bar.position.set(0, GOAL_H, 0);
  scene.add(bar);

  const netMat = new THREE.LineBasicMaterial({ color: 0x9fb8ff, transparent: true, opacity: 0.4 });
  const pts = [];
  const D = 1.3;                                       // ネットの奥行き
  for (let i = 0; i <= 16; i++) {                      // たて糸
    const x = -GOAL_W / 2 + (GOAL_W / 16) * i;
    pts.push(x, GOAL_H, 0, x, GOAL_H * 0.55, -D, x, GOAL_H * 0.55, -D, x, 0, -D);
  }
  for (let j = 0; j <= 6; j++) {                       // よこ糸(うしろ面)
    const y = (GOAL_H * 0.55 / 6) * j;
    pts.push(-GOAL_W / 2, y, -D, GOAL_W / 2, y, -D);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  scene.add(new THREE.LineSegments(geo, netMat));
}

// スタジアムのネオン照明(かざり)
for (const [x, z, c] of [[-14, 4, 0x4ffcff], [14, 4, 0xff6bd6], [-11, 22, 0x7dffa9], [11, 22, 0xffe066]]) {
  const tower = new THREE.Mesh(new THREE.BoxGeometry(0.3, 9, 0.3), new THREE.MeshBasicMaterial({ color: 0x223055 }));
  tower.position.set(x, 4.5, z);
  scene.add(tower);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 12), new THREE.MeshBasicMaterial({ color: c }));
  lamp.position.set(x, 9.3, z);
  scene.add(lamp);
}

// ボール(同時キック用に3個プール)
const balls = [], ballShadows = [];
for (let i = 0; i < MAX_BALLS; i++) {
  const b = new THREE.Mesh(
    new THREE.SphereGeometry(BALL_R + 0.03, 20, 20),
    new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x222233, roughness: 0.3 })
  );
  b.visible = false;
  scene.add(b);
  balls.push(b);
  const sh = new THREE.Mesh(new THREE.CircleGeometry(0.16, 16), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }));
  sh.rotation.x = -Math.PI / 2;
  sh.visible = false;
  scene.add(sh);
  ballShadows.push(sh);
}

// 人のアバター
const PLAYER_COLORS = [0x4ffcff, 0xff6bd6, 0x7dffa9, 0xffe066, 0xb46bff, 0xff8c5a];
function nameSprite(text, color) {
  const cv = document.createElement("canvas");
  cv.width = 256; cv.height = 72;
  const c = cv.getContext("2d");
  c.font = "900 34px 'M PLUS Rounded 1c', sans-serif";
  c.textAlign = "center"; c.textBaseline = "middle";
  c.shadowColor = "rgba(0,0,0,.8)"; c.shadowBlur = 8;
  c.fillStyle = color;
  c.fillText(text.slice(0, 8), 128, 36);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true }));
  sp.scale.set(1.9, 0.53, 1);
  return sp;
}
function makeAvatar(name, colorIdx, isKeeper) {
  const g = new THREE.Group();
  const col = PLAYER_COLORS[colorIdx % PLAYER_COLORS.length];
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.23, 0.62, 6, 14),
    new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.25, roughness: 0.5 })
  );
  body.position.y = 0.75;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 14), new THREE.MeshStandardMaterial({ color: 0xffdcb2, roughness: 0.7 }));
  head.position.y = 1.35;
  const label = nameSprite(name, "#" + col.toString(16).padStart(6, "0"));
  label.position.y = 1.85;
  g.add(body, head, label);
  // 顔(キーパーはキッカー向き=+z、キッカーはゴール向き=-z)
  const fz = isKeeper ? 1 : -1;
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x222233 });
  for (const ex of [-0.06, 0.06]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 8), eyeMat);
    eye.position.set(ex, 1.39, fz * 0.145);
    g.add(eye);
  }
  const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 8), new THREE.MeshBasicMaterial({ color: 0xb0404f }));
  mouth.scale.set(1.9, 0.65, 0.6);
  mouth.position.set(0, 1.295, fz * 0.16);
  g.add(mouth);
  g.userData = { body, head, label, isKeeper };
  scene.add(g);
  return g;
}
function clearAvatars() {
  for (const k of G.kickers) if (k.avatar) scene.remove(k.avatar);
  for (const k of G.keepers) if (k.avatar) scene.remove(k.avatar);
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  fitOrtho();
  resizeFx();
}
addEventListener("resize", resize);   // 初回のresize()はファイル末尾(ortho/fxの定義後)で呼ぶ

// ────────────────── カメラ ──────────────────
let camShake = 0;
let camView = localStorage.getItem("lg_pk_cam") === "small" ? "small" : "big";
// 視点「小」: ゴール真後ろの2D風(平行投影)ビュー
const ortho = new THREE.OrthographicCamera(-5, 5, 3, -3, 0.1, 80);
function fitOrtho() {
  const halfW = Math.max(4.9, 2.95 * innerWidth / innerHeight);
  const halfH = halfW * innerHeight / innerWidth;
  ortho.left = -halfW; ortho.right = halfW;
  ortho.top = halfH; ortho.bottom = -halfH;
  ortho.updateProjectionMatrix();
}
function setFov(f) {
  if (camera.fov !== f) { camera.fov = f; camera.updateProjectionMatrix(); }
}
function updateCamera() {
  const me = myKeeper();
  let cam = camera;
  if (me && G.phase !== "lobby") {
    if (camView === "small") {
      cam = ortho;
      ortho.position.set(0, 3.4, -7.5);           // ほんの少しだけ見下ろして地面も見える2D風
      ortho.lookAt(0, 1.5, SPOT_Z);
    } else {
      // キーパー視点(大): ゴールのうしろから望遠ぎみに(遠くのキッカーの顔が見えるように)
      setFov(40);
      camera.position.set(me.x * 0.6, 3.1, -8.5);
      camera.lookAt(me.x * 0.22, 1.05, SPOT_Z);
    }
  } else {
    // キッカー/観戦視点: ボールのうしろから
    setFov(58);
    camera.position.set(0, 2.7, SPOT_Z + 4.6);
    camera.lookAt(0, 1.15, 0);
  }
  if (camShake > 0) {
    cam.position.x += (Math.random() - 0.5) * camShake;
    cam.position.y += (Math.random() - 0.5) * camShake;
    camShake *= 0.86;
  }
  return cam;
}

// ────────────────── シミュレーション(判定のキモ・全員同じ計算) ──────────────────
// ボールの位置(sx=開始位置、カーブは横方向のふくらみ crv で表現、着地点は tx のまま)
function ballPos(kick, t) {
  const T = flightT(kick.pow), H = arcH(kick.pow);
  const s = clamp(t / T, 0, 1);
  const sx = kick.sx || 0;
  return new THREE.Vector3(
    sx + (kick.tx - sx) * s + (kick.crv || 0) * 4 * s * (1 - s),
    BALL_R + (kick.ty - BALL_R) * s + H * 4 * s * (1 - s),
    SPOT_Z * (1 - s)
  );
}
// キーパーのポーズ(足もと基準)— 見た目のアニメと判定で同じ計算を使う
function divePose(x0, dive, p) {
  const e = 1 - (1 - p) * (1 - p);
  return {
    x: x0 + dive.dx * dive.len * e,
    y: clamp(dive.dy * dive.len * e * 0.6 - p * p * 0.5, 0, 1.6),
    rotZ: -Math.sign(dive.dx) * p * 1.25,
  };
}
// ポーズ上の高さhの体の点(rotZで回転)
function bodyPoint(pose, h) {
  return { x: pose.x - Math.sin(pose.rotZ) * h, y: pose.y + Math.cos(pose.rotZ) * h };
}
// ボールが体(胴体カプセル+頭)にちゃんと当たったかのピンポイント判定
function ballHitsBody(pose, bp) {
  const dz = bp.z - KEEPER_Z;
  const a = bodyPoint(pose, 0.42), b = bodyPoint(pose, 1.08);   // 胴体の軸
  const abx = b.x - a.x, aby = b.y - a.y;
  const L2 = abx * abx + aby * aby || 1;
  const u = clamp(((bp.x - a.x) * abx + (bp.y - a.y) * aby) / L2, 0, 1);
  const dxy = Math.hypot(bp.x - (a.x + abx * u), bp.y - (a.y + aby * u));
  if (Math.hypot(dxy, dz) < 0.23 + BALL_R + 0.07) return true;
  const hd = bodyPoint(pose, 1.35);                              // 頭
  return Math.hypot(Math.hypot(bp.x - hd.x, bp.y - hd.y), dz) < 0.17 + BALL_R + 0.07;
}

// 複数ボール対応: 時間は絶対ms(kick.launchAt / dive.atMs)ベース
// kicks: [{sx,tx,ty,pow,crv,launchAt}|null] / keepers: [{x, dive:{dx,dy,len,atMs}|null}]
function simulateAll(kicks, keepers) {
  const live = kicks.filter(Boolean);
  const ks = keepers.map((k) => ({ x0: k.x, dive: k.dive, frozenAt: Infinity }));   // frozenAtはms
  const poseAt = (k, ms) => {
    if (!k.dive) return { x: k.x0, y: 0, rotZ: 0 };
    const p = clamp((Math.min(ms, k.frozenAt) - k.dive.atMs) / 1000 / DIVE_DUR, 0, 1);
    return divePose(k.x0, k.dive, p);
  };
  // キーパー同士の衝突(強い=長いスワイプが勝ち、負けた方はぶつかった所で止まる)
  // ※移動中(飛ぶ前)の重なりはOK。飛んだ後だけ力関係が働く
  const divers = ks.filter((k) => k.dive);
  if (divers.length && ks.length > 1) {
    const t0 = Math.min(...divers.map((k) => k.dive.atMs));
    const t1 = Math.max(
      ...divers.map((k) => k.dive.atMs + DIVE_DUR * 1000),
      ...(live.length ? live.map((c) => c.launchAt + flightT(c.pow) * 1000) : [t0])
    );
    const dt = 1000 / 120;
    const wasApart = new Map();          // ペアが一度はなれてから当たった時だけ衝突あつかい
    let firstTick = true;
    const centers = ks.map(() => ({ x: 0, y: 0 }));
    for (let ms = t0; ms <= t1; ms += dt) {
      for (let i = 0; i < ks.length; i++) {
        const c = bodyPoint(poseAt(ks[i], ms), 0.75);
        centers[i].x = c.x; centers[i].y = c.y;
      }
      for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) {
        const a = ks[i], b = ks[j];
        const key = i * 16 + j;
        const near = Math.hypot(centers[i].x - centers[j].x, centers[i].y - centers[j].y) < COLLIDE_D;
        if (near && wasApart.get(key) && !firstTick) {
          const movingA = a.dive && ms > a.dive.atMs && ms < a.dive.atMs + DIVE_DUR * 1000 && a.frozenAt === Infinity;
          const movingB = b.dive && ms > b.dive.atMs && ms < b.dive.atMs + DIVE_DUR * 1000 && b.frozenAt === Infinity;
          if (movingA && movingB && Math.abs(a.dive.len - b.dive.len) > 0.45) {
            if (a.dive.len > b.dive.len) b.frozenAt = ms; else a.frozenAt = ms;
          } else {
            if (movingA) a.frozenAt = ms;
            if (movingB) b.frozenAt = ms;
          }
          if (movingA || movingB) wasApart.set(key, false);
        }
        if (!near) wasApart.set(key, true);
      }
      firstTick = false;
    }
  }
  // 各ボールの判定(体にちゃんと当たった時だけ弾く)
  const results = kicks.map((kick) => {
    if (!kick) return null;
    const T = flightT(kick.pow);
    for (let t = 0; t <= T; t += 1 / 120) {
      const bp = ballPos(kick, t);
      const ms = kick.launchAt + t * 1000;
      for (let i = 0; i < ks.length; i++) {
        if (ballHitsBody(poseAt(ks[i], ms), bp)) {
          return { res: "save", by: i, hitT: t, hitPos: bp };
        }
      }
    }
    const inX = Math.abs(kick.tx) <= GOAL_W / 2 - 0.08;
    const inY = kick.ty >= 0 && kick.ty <= GOAL_H - 0.08;
    const nearPostX = Math.abs(Math.abs(kick.tx) - GOAL_W / 2) < 0.18 && kick.ty < GOAL_H;
    const nearBarY = Math.abs(kick.ty - GOAL_H) < 0.18 && Math.abs(kick.tx) < GOAL_W / 2;
    let res = inX && inY ? "goal" : "miss";
    if (res === "miss" && (nearPostX || nearBarY)) res = "post";
    return { res, by: -1, hitT: T, hitPos: ballPos(kick, T) };
  });
  return { results, frozen: ks.map((k) => k.frozenAt) };
}

function getSim() {
  if (!G.kicks.some(Boolean)) return null;
  const key = JSON.stringify([
    G.kicks.map((c) => c && [c.sx, c.tx, c.ty, c.pow, c.crv, c.launchAt]),
    G.keepers.map((k) => [k.x, k.dive && [k.dive.dx, k.dive.dy, k.dive.len, k.dive.atMs]]),
  ]);
  if (!G.simCache || G.simCache.key !== key) {
    G.simCache = { key, sim: simulateAll(G.kicks, G.keepers) };
  }
  return G.simCache.sim;
}

// ────────────────── ネット(部屋)/ ローカル配送 ──────────────────
const net = {
  peer: null, isHost: false, hostConn: null,
  conns: new Map(),        // ホスト: mid -> conn
  nextMid: 1,
  send(msg) {              // 自分→みんな(ホスト経由)
    if (G.mode === "solo") { handleMsg({ ...msg, mid: G.myMid }); return; }
    if (this.isHost) { this.relay({ ...msg, mid: G.myMid }); }
    else if (this.hostConn && this.hostConn.open) this.hostConn.send(msg);
  },
  relay(msg) {             // ホスト: 全員へ+自分でも処理
    for (const c of this.conns.values()) if (c.open) c.send(msg);
    handleMsg(msg);
  },
};

const PEER_PREFIX = "lotsgame-pk-";
const randomRoomId = () => String(Math.floor(1000 + Math.random() * 9000));
const myName = () => store.name || "ななしさん";

function destroyPeer() {
  if (net.peer) { try { net.peer.destroy(); } catch (_) {} }
  net.peer = null; net.hostConn = null; net.conns.clear();
  net.isHost = false; net.nextMid = 1;
  G.members = []; G.myMid = 0;
}
function setRoomStatus(msg, cls = "") {
  $("roomStatus").textContent = msg;
  $("roomStatus").className = "room-status " + cls;
}
function renderMembers() {
  const el = $("memberList");
  el.innerHTML = "";
  for (const m of G.members) {
    const c = document.createElement("span");
    c.className = "member-chip" + (m.mid === G.myMid ? " me" : "");
    c.textContent = (m.mid === 0 ? "👑 " : "🙂 ") + m.name;
    el.appendChild(c);
  }
  $("hostSettings").classList.toggle("hidden", !(net.isHost && G.members.length >= 1));
  $("guestWait").classList.toggle("hidden", !(net.peer && !net.isHost && G.members.length >= 1));
  renderTeamAssign();
  renderGamePanel();
}

// ホストがキックを受けつけていいか(スロットの持ち主か・まだ蹴ってないか)
function hostAcceptsKick(msg, senderMid) {
  if (G.phase !== "aim" && G.phase !== "fly") return false;
  const slot = msg.slot | 0;
  const k = G.kickers[slot];
  if (!k || G.kicks[slot]) return false;
  if (senderMid === -1) return true;                  // CPU/自動キック(ホスト発)
  return !k.cpu && k.mid === senderMid;
}

function createRoom(id) {
  destroyPeer();
  setRoomStatus("部屋を作成中…");
  const peer = new Peer(PEER_PREFIX + id, { debug: 1 });
  net.peer = peer;
  peer.on("open", () => {
    net.isHost = true;
    G.myMid = 0;
    G.members = [{ mid: 0, name: myName() }];
    store.lastRoom = id;
    setRoomStatus(`部屋 ${id} を作ったよ!みんなに伝えて「部屋に入る」してもらってね(最大10人)`, "ok");
    renderMembers();
  });
  peer.on("connection", (conn) => {
    conn.on("data", (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.t === "hello") {
        if (G.members.length >= MAX_MEMBERS) {          // まんいん(最大10人)
          conn.send({ t: "full" });
          setTimeout(() => { try { conn.close(); } catch (_) {} }, 300);
          return;
        }
        const mid = net.nextMid++;
        conn._mid = mid;
        net.conns.set(mid, conn);
        G.members.push({ mid, name: String(msg.name || "ななしさん").slice(0, 12) });
        conn.send({ t: "welcome", mid });
        net.relay({ t: "members", list: G.members });
      } else {
        // キックはホストが門番(スロット不正・二重うちを防ぐ)
        if (msg.t === "kick" && !hostAcceptsKick(msg, conn._mid)) return;
        net.relay({ ...msg, mid: conn._mid });
      }
    });
    conn.on("close", () => {
      if (conn._mid == null) return;
      net.conns.delete(conn._mid);
      G.members = G.members.filter((m) => m.mid !== conn._mid);
      net.relay({ t: "members", list: G.members });
    });
  });
  peer.on("error", (err) => {
    if (err.type === "unavailable-id") {
      destroyPeer();
      setRoomStatus(`部屋 ${id} はもうあるみたい。「部屋に入る」で参加してみて!`, "err");
    } else peerError(err);
  });
  peer.on("disconnected", () => { if (net.peer === peer && !peer.destroyed) peer.reconnect(); });
}

function joinRoom(id) {
  destroyPeer();
  setRoomStatus(`部屋 ${id} に参加中…`);
  const peer = new Peer({ debug: 1 });
  net.peer = peer;
  peer.on("open", () => {
    const conn = peer.connect(PEER_PREFIX + id, { reliable: true });
    net.hostConn = conn;
    let opened = false;
    conn.on("open", () => {
      opened = true;
      store.lastRoom = id;
      conn.send({ t: "hello", name: myName() });
      setRoomStatus(`部屋 ${id} に入ったよ!ホストのスタートを待とう`, "ok");
    });
    conn.on("data", (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.t === "welcome") { G.myMid = msg.mid; return; }
      if (msg.t === "full") {
        opened = false;
        destroyPeer();
        setRoomStatus(`部屋 ${id} はまんいんだよ(最大10人)`, "err");
        return;
      }
      handleMsg(msg);
    });
    conn.on("close", () => {
      if (!opened) return;
      destroyPeer();
      renderMembers();
      setRoomStatus("部屋が閉じられたみたい(ホストが退出したかも)", "err");
      if (G.phase !== "lobby") backToLobby();
    });
    setTimeout(() => {
      if (!opened && net.peer === peer) {
        destroyPeer();
        setRoomStatus(`部屋 ${id} が見つからない…。IDと、部屋を作った人が画面を開いたままか確認してね`, "err");
      }
    }, 12000);
  });
  peer.on("error", (err) => {
    if (err.type === "peer-unavailable") {
      destroyPeer();
      setRoomStatus(`部屋 ${id} が見つからないよ。先にだれかが「部屋を作る」必要があるよ`, "err");
    } else peerError(err);
  });
}
function peerError(err) {
  console.warn("Peer error:", err.type, err);
  if (["network", "server-error", "socket-error", "socket-closed"].includes(err.type)) {
    destroyPeer();
    renderMembers();
    setRoomStatus("通信サーバーにつながらない…。電波のいい場所でもう一度ためしてね", "err");
  }
}

// ────────────────── 試合の進行(ホスト/ソロが仕切る) ──────────────────
const host = {
  order: [],               // [{ks:[{mid}|{cpu:true},...], team:idx|null}]
  roundNo: 0, timers: [], suddenN: 0, cpuDivesArmed: false,
  clearTimers() { for (const t of this.timers) clearTimeout(t); this.timers = []; },
  after(ms, fn) { this.timers.push(setTimeout(fn, ms)); },

  // 全員が1回ずつ蹴る1周ぶんのラウンドを作る
  buildCycleChunks() {
    const kn = clamp(G.cfg.kickersN, 1, MAX_BALLS);
    const chunks = [];
    if (G.mode === "solo") {
      const cpus = (n) => Array.from({ length: n }, () => ({ cpu: true }));
      chunks.push({ ks: [{ mid: 0 }, ...cpus(kn - 1)], team: null });
      chunks.push({ ks: cpus(kn), team: null });
      return chunks;
    }
    const active = G.members.filter((m) => G.activeMids.has(m.mid));
    if (G.teams) {
      G.teams.forEach((t, ti) => {
        const mids = t.mids.filter((mid) => active.some((m) => m.mid === mid));
        for (let i = 0; i < mids.length; i += kn) {
          chunks.push({ ks: mids.slice(i, i + kn).map((mid) => ({ mid })), team: ti });
        }
      });
    } else {
      const mids = active.map((m) => m.mid);
      for (let i = 0; i < mids.length; i += kn) {
        chunks.push({ ks: mids.slice(i, i + kn).map((mid) => ({ mid })), team: null });
      }
    }
    return chunks;
  },

  startMatch(teams) {
    this.clearTimers();
    this.suddenN = 0;
    const scores = {};
    if (G.mode === "solo") {
      G.teams = null;
      G.activeMids = new Set([0]);
      scores["あなた"] = 0; scores["CPU"] = 0;
      this.order = [];
      for (let r = 0; r < G.cfg.rounds; r++) this.order.push(...this.buildCycleChunks());
    } else {
      G.teams = teams || null;
      G.activeMids = new Set(G.members.map((m) => m.mid));
      for (const m of G.members) scores[m.name] = 0;
      if (this.needsCpu()) scores["CPU"] = 0;
      this.order = [];
      for (let c = 0; c < G.cfg.cycles; c++) this.order.push(...this.buildCycleChunks());
    }
    this.roundNo = 0;
    net.send({ t: "start", scores, teams: G.teams, active: [...G.activeMids] });
    this.after(600, () => this.startRound());
  },
  needsCpu() {
    const humans = G.members.length - 1;
    const want = G.cfg.keepers === 0 ? clamp(humans, 1, MAX_KEEPERS) : G.cfg.keepers;
    return want > humans || G.cfg.kickersN > 1;   // 同時キックでも自動キックがCPU名義になる場合あり
  },
  startRound() {
    this.clearTimers();
    this.cpuDivesArmed = false;
    if (this.roundNo >= this.order.length) { this.finish(false); return; }
    const entry = this.order[this.roundNo];
    let kickers;
    if (G.mode === "solo") {
      kickers = entry.ks.map((s) => (s.cpu ? { cpu: true, name: "CPU" } : { mid: 0, name: "あなた" }));
    } else {
      kickers = entry.ks
        .map((s) => {
          if (s.cpu) return { cpu: true, name: "CPU" };
          const m = G.members.find((x) => x.mid === s.mid);
          return m ? { mid: m.mid, name: m.name } : null;   // 抜けた人はスキップ
        })
        .filter(Boolean);
      if (!kickers.length) { this.roundNo++; this.startRound(); return; }
    }
    // キーパー候補(チーム戦は蹴ってるチーム以外/みんなでは蹴ってない人)
    let cands;
    if (G.mode === "solo") {
      cands = kickers.some((k) => !k.cpu) ? [] : [{ mid: 0, name: "あなた" }];
    } else {
      const kickMids = new Set(
        entry.team != null && G.teams ? G.teams[entry.team].mids : kickers.filter((k) => !k.cpu).map((k) => k.mid)
      );
      cands = G.members.filter((m) => G.activeMids.has(m.mid) && !kickMids.has(m.mid));
    }
    const want = G.cfg.keepers === 0 ? clamp(cands.length || 1, 1, MAX_KEEPERS) : G.cfg.keepers;
    const n = clamp(want, 1, MAX_KEEPERS);
    const xs = slotXs(n);
    const keepers = [];
    for (let i = 0; i < n; i++) {
      const h = cands[i];
      keepers.push(h
        ? { mid: h.mid, name: h.name, cpu: false, x: xs[i] }
        : { cpu: true, name: "CPU" + (i + 1), x: xs[i] + (Math.random() - 0.5) * 0.5 });
    }
    this.roundNo++;
    net.send({
      t: "round", no: this.roundNo, total: this.order.length,
      kickers, keepers, setDur: G.cfg.setDur, kickLimit: G.cfg.kickLimit,
      team: entry.team != null ? entry.team : null,
    });
    this.after(G.cfg.setDur * 1000, () => {
      net.send({ t: "aim" });
      // CPUキッカーはすこし考えてから蹴る
      kickers.forEach((k, slot) => {
        if (k.cpu) this.after(1200 + Math.random() * 1600, () => this.cpuKick(slot));
      });
      // 制限時間で自動キック
      this.after(G.cfg.kickLimit * 1000, () => {
        kickers.forEach((k, slot) => {
          if (!G.kicks[slot]) net.send({ t: "kick", mid: -1, slot, tx: (Math.random() - 0.5) * 3, ty: 0.7, pow: 0.5, crv: 0 });
        });
      });
    });
  },
  cpuKick(slot) {
    if (G.kicks[slot]) return;
    const lv = CPU_LVS[G.cfg.cpuLevel] || CPU_LVS[1];
    const wild = Math.random() < lv.wild;
    const tx = (Math.random() < 0.5 ? -1 : 1) * (wild ? 3.9 + Math.random() * 0.8 : 1.6 + Math.random() * 1.9);
    const ty = Math.random() < 0.45 ? 0.2 + Math.random() * 0.5 : 1.2 + Math.random() * (wild ? 1.6 : 0.9);
    const crv = Math.random() < 0.4 ? (Math.random() - 0.5) * 2.4 : 0;   // ときどきカーブも蹴る
    net.send({ t: "kick", mid: -1, slot, tx, ty, pow: 0.55 + Math.random() * 0.4, crv });
  },
  onKick() {               // kick配信直後にホストが呼ぶ
    // CPUキーパーの飛びこみ(最初のキックで予約)
    if (!this.cpuDivesArmed) {
      this.cpuDivesArmed = true;
      const lv = CPU_LVS[G.cfg.cpuLevel] || CPU_LVS[1];
      G.keepers.forEach((k, i) => {
        if (!k.cpu) return;
        const delay = RUNUP * 1000 + 100 + Math.random() * 280;
        this.after(delay, () => {
          if (k.dive) return;
          const targets = G.kicks.filter(Boolean);
          if (!targets.length) return;
          const tgt = targets[Math.floor(Math.random() * targets.length)];
          const guess = Math.random() < lv.guess;
          const gx = guess ? tgt.tx + (Math.random() - 0.5) * lv.dive : (Math.random() - 0.5) * 6;
          const gy = guess ? tgt.ty + (Math.random() - 0.5) * lv.dive * 0.7 : Math.random() * 2;
          const dx = gx - k.x, dy = gy - TORSO_Y;
          const L = Math.hypot(dx, dy) || 1;
          net.send({ t: "dive", ki: i, dx: dx / L, dy: clamp(dy / L, -0.25, 1), len: clamp(L, 0.6, DIVE_MAX) });
        });
      });
    }
    // 全ボールが出そろったら、いちばん遅い到着後に判定
    if (G.kicks.length === G.kickers.length && G.kicks.every(Boolean)) {
      const lastArrive = Math.max(...G.kicks.map((c) => c.launchAt + flightT(c.pow) * 1000));
      this.after(Math.max(0, lastArrive - performance.now()) + 250, () => {
        const sim = simulateAll(G.kicks, G.keepers);
        const scores = { ...G.scores };
        sim.results.forEach((r, slot) => {
          if (!r) return;
          if (r.res === "goal") {
            const kk = G.kickers[slot];
            const key = kk.cpu ? "CPU" : kk.name;
            scores[key] = (scores[key] || 0) + 1;
          }
          if (r.res === "save") {
            const kp = G.keepers[r.by];
            const key = kp.cpu ? "CPU" : (G.mode === "solo" ? "あなた" : kp.name);
            scores[key] = (scores[key] || 0) + 1;
          }
        });
        net.send({ t: "verdict", results: sim.results.map((r) => r && { res: r.res, by: r.by }), scores });
        this.after(3000, () => this.startRound());
      });
    }
  },
  // 同点ならサドンデス用の追加ラウンドを作る(force=trueは途中終了)
  finish(force) {
    if (!force && G.cfg.sudden && this.suddenN < 6) {
      const extra = this.suddenChunks();
      if (extra && extra.length) {
        this.suddenN++;
        this.order.push(...extra);
        net.send({ t: "sudden" });
        this.after(1800, () => this.startRound());
        return;
      }
    }
    net.send({ t: "final", scores: G.scores });
  },
  suddenChunks() {
    const kn = clamp(G.cfg.kickersN, 1, MAX_BALLS);
    if (G.mode === "solo") {
      if ((G.scores["あなた"] || 0) !== (G.scores["CPU"] || 0)) return null;
      return this.buildCycleChunks();
    }
    if (G.teams) {
      const totals = G.teams.map((t) => t.mids.reduce((s, mid) => {
        const m = G.members.find((x) => x.mid === mid);
        return s + (m ? (G.scores[m.name] || 0) : 0);
      }, 0));
      const top = Math.max(...totals);
      const tied = G.teams.map((t, ti) => ti).filter((ti) => totals[ti] === top);
      if (tied.length < 2) return null;
      const chunks = [];
      for (const ti of tied) {
        const mids = G.teams[ti].mids.filter((mid) => G.activeMids.has(mid) && G.members.some((m) => m.mid === mid));
        for (let i = 0; i < mids.length; i += kn) chunks.push({ ks: mids.slice(i, i + kn).map((mid) => ({ mid })), team: ti });
      }
      return chunks;
    }
    const active = G.members.filter((m) => G.activeMids.has(m.mid));
    const top = Math.max(...active.map((m) => G.scores[m.name] || 0), 0);
    const tied = active.filter((m) => (G.scores[m.name] || 0) === top);
    if (tied.length < 2) return null;
    const chunks = [];
    for (let i = 0; i < tied.length; i += kn) chunks.push({ ks: tied.slice(i, i + kn).map((m) => ({ mid: m.mid })), team: null });
    return chunks;
  },
  // ゲーム中⚙: 1周ついか
  addCycle() {
    this.order.push(...this.buildCycleChunks());
  },
  // ゲーム中⚙: のこり周(本)数を組みなおす(交代制・なん本勝負の途中変更)
  setRemainingCycles(n) {
    if (G.phase === "lobby" || G.phase === "final") return;
    this.order = this.order.slice(0, this.roundNo);
    for (let i = 0; i < n; i++) this.order.push(...this.buildCycleChunks());
  },
  // ゲーム中⚙: 待機中メンバーを次のラウンドから参加させる
  admit(mid) {
    const m = G.members.find((x) => x.mid === mid);
    if (!m || !G.activeMids || G.activeMids.has(mid)) return;
    let team = null;
    if (G.teams) {
      // ⚙で先にチームを決めてあればそれを優先、なければ人数が少ないチームへ
      const pre = G.teams.findIndex((t) => t.mids.includes(mid));
      if (pre >= 0) team = pre;
      else {
        let best = 0;
        G.teams.forEach((t, ti) => { if (t.mids.length < G.teams[best].mids.length) best = ti; });
        team = best;
      }
    }
    this.order.push({ ks: [{ mid }], team });
    // ※midは中継時に送信者のmidで上書きされるので、参加者は who で送る
    // teams同梱: 途中参加した本人はstartを受けてないのでここでチーム情報をもらう
    net.send({ t: "joined", who: mid, name: m.name, team, scores: G.scores, teams: G.teams });
  },
  // ゲーム中⚙: ボール数やチーム分けが変わった時、まだ蹴ってないラウンドを今の設定で組みなおす
  rebuildRemaining() {
    if (G.phase === "lobby" || G.phase === "final") return;
    const rest = this.order.splice(this.roundNo);
    const kn = clamp(G.cfg.kickersN, 1, MAX_BALLS);
    if (G.mode === "solo") {
      let mine = 0, cpu = 0;
      for (const ch of rest) (ch.ks.some((s) => s.mid === 0) ? mine++ : cpu++);
      const cpus = (n) => Array.from({ length: n }, () => ({ cpu: true }));
      while (mine > 0 || cpu > 0) {
        if (mine > 0) { mine--; this.order.push({ ks: [{ mid: 0 }, ...cpus(kn - 1)], team: null }); }
        if (cpu > 0) { cpu--; this.order.push({ ks: cpus(kn), team: null }); }
      }
      return;
    }
    // 残りのキック回数を数えて、今のチーム構成で組みなおす
    const count = new Map();
    for (const ch of rest) for (const s of ch.ks) if (s.mid != null) count.set(s.mid, (count.get(s.mid) || 0) + 1);
    const pushChunks = (mids, team) => {
      for (let i = 0; i < mids.length; i += kn) this.order.push({ ks: mids.slice(i, i + kn).map((mid) => ({ mid })), team });
    };
    if (G.teams) {
      G.teams.forEach((t, ti) => {
        const mids = [];
        for (const mid of t.mids) {
          const c = count.get(mid) || 0;
          for (let j = 0; j < c; j++) mids.push(mid);
          count.delete(mid);
        }
        pushChunks(mids, ti);
      });
      // どのチームにもいない人の分(保険)
      const rest2 = [];
      for (const [mid, c] of count) for (let j = 0; j < c; j++) rest2.push(mid);
      if (rest2.length) pushChunks(rest2, null);
    } else {
      const mids = [];
      for (const [mid, c] of count) for (let j = 0; j < c; j++) mids.push(mid);
      pushChunks(mids, null);
    }
  },
};

// ────────────────── メッセージ処理(全員共通) ──────────────────
function handleMsg(msg) {
  switch (msg.t) {
    case "members":
      G.members = msg.list;
      renderMembers();
      break;
    case "start":
      G.scores = msg.scores;
      G.teams = msg.teams || null;
      G.activeMids = new Set(msg.active || []);
      showMatch();
      break;
    case "round": startRoundView(msg); break;
    case "aim": startAimView(); break;
    case "pos": {
      // 最初のキックが飛ぶ瞬間までは自由に動ける
      const k = G.keepers.find((x) => !x.cpu && x.mid === msg.mid);
      if (k && (G.phase === "set" || G.phase === "aim")) k.x = clamp(msg.x, -KEEPER_X_MAX, KEEPER_X_MAX);
      break;
    }
    case "kick": {
      const slot = msg.slot | 0;
      if (!G.kickers[slot] || G.kicks[slot]) break;
      G.kicks[slot] = {
        sx: ballSx(slot, G.kickers.length),
        tx: msg.tx, ty: msg.ty, pow: msg.pow, crv: msg.crv || 0,
        launchAt: performance.now() + RUNUP * 1000,
      };
      G.simCache = null;
      if (G.phase === "aim") {
        G.phase = "fly";
        setPhaseMsg("");
        setHint(myKeeper() && !myKeeper().dive ? "来た!スワイプで飛び込め!" : "");
      }
      if (isDirector()) host.onKick();
      break;
    }
    case "dive": {
      const k = msg.ki != null ? G.keepers[msg.ki] : G.keepers.find((x) => !x.cpu && x.mid === msg.mid);
      if (!k || k.dive) break;
      // どんなに強くてもゴールの外へは飛び出さない(距離をつめる)
      const XB = GOAL_W / 2 - 0.25;
      let len = msg.len;
      if (msg.dx > 0.01) len = Math.min(len, (XB - k.x) / msg.dx);
      else if (msg.dx < -0.01) len = Math.min(len, (k.x + XB) / -msg.dx);
      k.dive = { dx: msg.dx, dy: msg.dy, len: Math.max(0.2, len), atMs: performance.now() };
      G.simCache = null;
      break;
    }
    case "joined": {
      if (!G.activeMids) G.activeMids = new Set();
      G.activeMids.add(msg.who);
      if (msg.teams && !G.teams) G.teams = msg.teams;
      if (msg.team != null && G.teams && G.teams[msg.team] && !G.teams[msg.team].mids.includes(msg.who)) {
        G.teams[msg.team].mids.push(msg.who);
      }
      if (msg.scores) G.scores = { ...msg.scores, ...G.scores };
      if (G.scores[msg.name] == null) G.scores[msg.name] = 0;
      updateScoreStrip();
      renderGamePanel();
      if (msg.who === G.myMid) showMatch();   // 途中参加した本人は試合画面へ
      break;
    }
    case "teams": {
      G.teams = msg.teams || null;
      updateScoreStrip();
      break;
    }
    case "sudden": {
      const b = $("bigBanner");
      b.classList.remove("hidden", "goal", "save", "miss");
      b.classList.add("goal");
      b.innerHTML = `サドンデス!!<small>決着がつくまで延長だ!</small>`;
      setTimeout(() => b.classList.add("hidden"), 1700);
      break;
    }
    case "verdict": showVerdict(msg); break;
    case "final": showFinal(msg.scores); break;
    case "abort":
      backToLobby();
      setRoomStatus("ホストが試合を終了したよ", "err");
      break;
  }
}
// ホスト or ソロ(進行役)か
const isDirector = () => G.mode === "solo" || net.isHost;

// ────────────────── ラウンドの表示側 ──────────────────
function myKeeper() {
  return G.keepers.find((k) => !k.cpu && (G.mode === "solo" ? k.mine : k.mid === G.myMid));
}
function mySlot() {
  return G.kickers.findIndex((k) => !k.cpu && (G.mode === "solo" ? k.mine : k.mid === G.myMid));
}

function startRoundView(msg) {
  G.phase = "set";
  G.round = msg.no; G.totalRounds = msg.total;
  G.roundKickLimit = msg.kickLimit || 12;
  G.roundTeam = msg.team != null ? msg.team : null;
  clearAvatars();
  G.kicks = msg.kickers.map(() => null);
  G.simCache = null;
  G.myDove = false; G.myKicked = false;
  G.kickers = msg.kickers.map((k) => ({ ...k }));
  G.keepers = msg.keepers.map((k) => ({ ...k, dive: null }));
  if (G.mode === "solo") {
    for (const k of G.keepers) if (!k.cpu) k.mine = true;
    for (const k of G.kickers) if (!k.cpu) k.mine = true;
  }

  // アバターとボール
  const kn = G.kickers.length;
  G.keepers.forEach((k, i) => {
    k.avatar = makeAvatar(k.cpu ? "🤖" + k.name : k.name, i + kn, true);
    k.avatar.position.set(k.x, 0, KEEPER_Z);
  });
  const mineK = myKeeper();
  if (mineK) mineK.avatar.userData.label.visible = false;   // 自分のラベルは目の前でデカいので消す
  G.kickers.forEach((k, i) => {
    k.avatar = makeAvatar(k.cpu ? "🤖CPU" : k.name, i, false);
    k.avatar.position.set(ballSx(i, kn) + 1.4, 0, SPOT_Z + 1.6);
    if (!k.cpu && ((G.mode === "solo" && k.mine) || k.mid === G.myMid)) k.avatar.userData.label.visible = false;
  });
  balls.forEach((b, i) => {
    const on = i < kn;
    b.visible = on; ballShadows[i].visible = on;
    if (on) {
      b.position.set(ballSx(i, kn), BALL_R + 0.03, SPOT_Z);
      b.rotation.x = 0;
      ballShadows[i].position.set(ballSx(i, kn), 0.013, SPOT_Z);
    }
  });

  const meK = myKeeper();
  const meSlot = mySlot();
  const teamTag = G.roundTeam != null && G.teams && G.teams[G.roundTeam] ? `${G.teams[G.roundTeam].emoji} ` : "";
  const names = G.kickers.map((k) => (k.cpu ? "CPU🤖" : k.name));
  $("roundLabel").textContent = `ラウンド ${G.round}/${G.totalRounds}`;
  setPhaseMsg(meSlot >= 0
    ? (names.length > 1 ? `${teamTag}あなたたちがキッカー!⚽` : "あなたがキッカー!⚽")
    : `${teamTag}キッカーは ${names.join("・")} !`);
  setHint(meK ? "← 左右にドラッグで移動!(蹴る瞬間まで動けるよ) →" : "キーパーが位置についてるよ…");
  refreshViewBtn();
  refreshGearBtn();
  // 配置カウントダウン
  const timerEl = $("setTimer");
  timerEl.classList.remove("hidden", "kick");
  const end = performance.now() + msg.setDur * 1000;
  const tick = () => {
    const left = Math.max(0, (end - performance.now()) / 1000);
    timerEl.textContent = Math.ceil(left);
    if (left > 0 && G.phase === "set") requestAnimationFrame(tick);
    else if (G.phase !== "aim") timerEl.classList.add("hidden");
  };
  tick();
  updateScoreStrip();
}

function startAimView() {
  if (G.phase !== "set") return;
  G.phase = "aim";
  const meK = myKeeper();
  const meSlot = mySlot();
  setPhaseMsg(meSlot >= 0 ? "スワイプでシュート!!" : `${G.kickers.map((k) => (k.cpu ? "CPU🤖" : k.name)).join("・")} が狙ってる…`);
  setHint(meSlot >= 0
    ? "スワイプの向き=コース、長さ=強さ!弧を描くとカーブ!"
    : meK ? "まだ左右に動ける!蹴った瞬間からスワイプで飛び込み(1回だけ)" : "どうなる!?");
  // キック制限時間のカウントダウン(黄色)
  const timerEl = $("setTimer");
  timerEl.classList.remove("hidden");
  timerEl.classList.add("kick");
  const end = performance.now() + G.roundKickLimit * 1000;
  const tick = () => {
    const pending = G.kickers.length && G.kicks.some((c, i) => !c && i < G.kickers.length);
    const left = Math.max(0, (end - performance.now()) / 1000);
    if ((G.phase !== "aim" && G.phase !== "fly") || !pending || left <= 0) {
      timerEl.classList.add("hidden");
      timerEl.classList.remove("kick");
      return;
    }
    timerEl.textContent = "⚽" + Math.ceil(left);
    requestAnimationFrame(tick);
  };
  tick();
}

function showVerdict(msg) {
  G.phase = "verdict";
  G.scores = msg.scores;
  updateScoreStrip();
  const rs = (msg.results || []).map((r, i) => r && { ...r, name: G.kickers[i] ? (G.kickers[i].cpu ? "CPU" : G.kickers[i].name) : "?" }).filter(Boolean);
  const goals = rs.filter((r) => r.res === "goal").length;
  const saves = rs.filter((r) => r.res === "save").length;
  const posts = rs.filter((r) => r.res === "post").length;
  const b = $("bigBanner");
  b.classList.remove("hidden", "goal", "save", "miss");
  const RES_TXT = { goal: "GOAL", save: "SAVE", post: "ポスト", miss: "MISS" };
  const detail = rs.length > 1 ? rs.map((r) => `${esc(r.name)}→${RES_TXT[r.res]}`).join(" / ") : "";
  if (goals > 0 && saves === 0) {
    b.classList.add("goal");
    b.innerHTML = `GOAL!!${goals > 1 ? `×${goals}` : ""}<small>${detail || esc(rs[0].name) + " が決めた!"}</small>`;
    camShake = 0.25;
  } else if (saves > 0 && goals === 0) {
    const byNames = [...new Set(rs.filter((r) => r.res === "save").map((r) => {
      const k = G.keepers[r.by];
      return k ? (k.cpu ? k.name : (G.mode === "solo" ? "あなた" : k.name)) : "キーパー";
    }))];
    b.classList.add("save");
    b.innerHTML = `SAVE!!${saves > 1 ? `×${saves}` : ""}<small>${detail || esc(byNames.join("・")) + " のスーパーセーブ!"}</small>`;
    camShake = 0.2;
  } else if (goals > 0 && saves > 0) {
    b.classList.add("goal");
    b.innerHTML = `GOAL×${goals} / SAVE×${saves}<small>${detail}</small>`;
    camShake = 0.22;
  } else if (posts > 0) {
    b.classList.add("miss");
    b.innerHTML = `ポスト!!<small>${detail || "惜しい!枠に当たった!"}</small>`;
  } else {
    b.classList.add("miss");
    b.innerHTML = `MISS…<small>${detail || "枠の外に飛んでいった…"}</small>`;
  }
  setHint("");
  setTimeout(() => b.classList.add("hidden"), 2600);
}

// チームの合計点
function teamTotals() {
  if (!G.teams) return null;
  return G.teams.map((t) => t.mids.reduce((s, mid) => {
    const m = G.members.find((x) => x.mid === mid);
    return s + (m ? (G.scores[m.name] || 0) : 0);
  }, 0));
}

function showFinal(scores) {
  G.phase = "final";
  G.scores = scores;
  const el = $("finalRanking");
  el.innerHTML = "";
  const medals = ["🥇", "🥈", "🥉"];
  if (G.teams) {
    const totals = teamTotals();
    const order = G.teams.map((t, ti) => ti).sort((a, b) => totals[b] - totals[a]);
    order.forEach((ti, i) => {
      const t = G.teams[ti];
      const memberNames = t.mids.map((mid) => {
        const m = G.members.find((x) => x.mid === mid);
        return m ? `${m.name} ${scores[m.name] || 0}` : null;
      }).filter(Boolean).join(" / ");
      const row = document.createElement("div");
      row.className = "rank-row" + (i === 0 ? " first" : "");
      row.innerHTML = `<span class="medal">${medals[i] || "🎖"}</span><span>${t.emoji} ${esc(t.name)}<small class="rank-sub">${esc(memberNames)}</small></span><span class="pts">${totals[ti]}点</span>`;
      el.appendChild(row);
    });
  } else {
    const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    entries.forEach(([name, pts], i) => {
      const row = document.createElement("div");
      row.className = "rank-row" + (i === 0 ? " first" : "");
      row.innerHTML = `<span class="medal">${medals[i] || "🎖"}</span><span>${esc(name)}</span><span class="pts">${pts}点</span>`;
      el.appendChild(row);
    });
  }
  $("againBtn").classList.toggle("hidden", !isDirector());
  $("gamePanel").classList.add("hidden");
  $("finalOverlay").classList.remove("hidden");
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function setPhaseMsg(s) { $("phaseMsg").textContent = s; }
function setHint(s) { $("hintMsg").textContent = s; }
function updateScoreStrip() {
  const el = $("scoreStrip");
  el.innerHTML = "";
  if (G.teams) {
    const totals = teamTotals();
    G.teams.forEach((t, ti) => {
      const c = document.createElement("span");
      c.className = "score-chip team" + (G.roundTeam === ti ? " kicker" : "");
      c.style.borderColor = TEAMS[ti % TEAMS.length].color;
      c.textContent = `${t.emoji} ${totals[ti]}`;
      el.appendChild(c);
    });
  }
  const kickerNames = new Set(G.kickers.map((k) => (k.cpu ? "CPU" : k.name)));
  for (const [name, pts] of Object.entries(G.scores)) {
    const c = document.createElement("span");
    c.className = "score-chip" + (kickerNames.has(name) ? " kicker" : "");
    c.textContent = `${name} ${pts}`;
    el.appendChild(c);
  }
}

// ────────────────── 画面切り替え ──────────────────
function showMatch() {
  $("lobby").classList.add("hidden");
  $("finalOverlay").classList.add("hidden");
  $("hud").classList.remove("hidden");
  refreshGearBtn();
}
function backToLobby() {
  G.phase = "lobby";
  host.clearTimers();
  clearAvatars();
  G.keepers = []; G.kickers = []; G.kicks = [];
  G.teams = null; G.activeMids = null;
  balls.forEach((b, i) => { b.visible = false; ballShadows[i].visible = false; });
  $("hud").classList.add("hidden");
  $("finalOverlay").classList.add("hidden");
  $("gamePanel").classList.add("hidden");
  $("lobby").classList.remove("hidden");
}

// ────────────────── 入力(スワイプ/ドラッグ) ──────────────────
const ptr = { down: false, role: null, x0: 0, y0: 0, keeperX0: 0 };
let lastPosSend = 0;
const layer = $("touchLayer");

// スワイプの見える化(白猫ふうの起点パッド+軌跡)
const fxCanvas = $("fx"), fxCtx = fxCanvas.getContext("2d");
const swipeFx = { pts: [], active: false, endAt: 0, color: "#ffe066" };
function resizeFx() {
  const d = Math.min(devicePixelRatio, 2);
  fxCanvas.width = innerWidth * d;
  fxCanvas.height = innerHeight * d;
  fxCtx.setTransform(d, 0, 0, d, 0, 0);
}
function drawSwipeFx(now) {
  if (!swipeFx.pts.length) return;
  fxCtx.clearRect(0, 0, innerWidth, innerHeight);
  if (!swipeFx.active && now >= swipeFx.endAt) { swipeFx.pts = []; return; }
  const a = swipeFx.active ? 1 : Math.max(0, (swipeFx.endAt - now) / 450);
  const pts = swipeFx.pts, p0 = pts[0], pe = pts[pts.length - 1];
  fxCtx.save();
  fxCtx.strokeStyle = swipeFx.color;
  fxCtx.shadowColor = swipeFx.color;
  fxCtx.shadowBlur = 16;
  // 起点パッド
  fxCtx.globalAlpha = a * 0.2;
  fxCtx.fillStyle = swipeFx.color;
  fxCtx.beginPath(); fxCtx.arc(p0.x, p0.y, 46, 0, Math.PI * 2); fxCtx.fill();
  fxCtx.globalAlpha = a;
  fxCtx.lineWidth = 3;
  fxCtx.beginPath(); fxCtx.arc(p0.x, p0.y, 46, 0, Math.PI * 2); fxCtx.stroke();
  // 描いた軌跡
  fxCtx.lineWidth = 7;
  fxCtx.lineCap = "round"; fxCtx.lineJoin = "round";
  fxCtx.beginPath();
  fxCtx.moveTo(p0.x, p0.y);
  for (let i = 1; i < pts.length; i++) fxCtx.lineTo(pts[i].x, pts[i].y);
  fxCtx.stroke();
  // 指先
  fxCtx.fillStyle = "#fff";
  fxCtx.beginPath(); fxCtx.arc(pe.x, pe.y, 9, 0, Math.PI * 2); fxCtx.fill();
  fxCtx.restore();
}
// 描いた弧のふくらみ→カーブ量(いちばん膨らんだ1点だけ使うのでS字にはならない)
function swipeCurve(minDim) {
  const pts = swipeFx.pts;
  if (pts.length < 4) return 0;
  const p0 = pts[0], pN = pts[pts.length - 1];
  const chx = pN.x - p0.x, chy = pN.y - p0.y;
  const chL2 = chx * chx + chy * chy;
  if (chL2 < 900) return 0;
  let best = 0;
  for (const p of pts) {
    const u = ((p.x - p0.x) * chx + (p.y - p0.y) * chy) / chL2;
    if (u < 0.05 || u > 0.95) continue;
    const devX = p.x - (p0.x + chx * u);              // 直線からの横ズレ
    if (Math.abs(devX) > Math.abs(best)) best = devX;
  }
  return clamp((best / minDim) * 8, -2.4, 2.4);
}

const canMoveKeeper = () => G.phase === "set" || (G.phase === "aim" && !G.kicks.some(Boolean));
const canKick = () => {
  const s = mySlot();
  return s >= 0 && !G.kicks[s] && !G.myKicked && (G.phase === "aim" || G.phase === "fly");
};

layer.addEventListener("pointerdown", (e) => {
  if (G.phase === "lobby" || G.phase === "final") return;
  const meK = myKeeper();
  ptr.down = true;
  ptr.x0 = e.clientX; ptr.y0 = e.clientY;
  if (canKick()) ptr.role = "kick";
  else if (meK && G.phase === "fly" && !G.myDove) ptr.role = "dive";
  else if (meK && canMoveKeeper()) { ptr.role = "move"; ptr.keeperX0 = meK.x; }
  else ptr.role = null;
  if (ptr.role === "kick" || ptr.role === "dive") {
    swipeFx.pts = [{ x: e.clientX, y: e.clientY }];
    swipeFx.active = true;
    swipeFx.color = ptr.role === "kick" ? "#ffe066" : "#4ffcff";
  }
  try { layer.setPointerCapture(e.pointerId); } catch (_) {}
});
layer.addEventListener("pointermove", (e) => {
  if (!ptr.down) return;
  if (ptr.role === "move") {
    const meK = myKeeper();
    if (!meK || !canMoveKeeper()) return;
    // カメラがゴール裏なので画面右=世界の-x
    const nx = clamp(ptr.keeperX0 - ((e.clientX - ptr.x0) / innerWidth) * 8.5, -KEEPER_X_MAX, KEEPER_X_MAX);
    meK.x = nx;
    const now = performance.now();
    if (now - lastPosSend > 120) { lastPosSend = now; net.send({ t: "pos", x: nx }); }
  } else if (swipeFx.active && swipeFx.pts.length < 300) {
    const last = swipeFx.pts[swipeFx.pts.length - 1];
    const dx = e.clientX - last.x, dy = e.clientY - last.y;
    if (dx * dx + dy * dy > 9) swipeFx.pts.push({ x: e.clientX, y: e.clientY });
  }
});
layer.addEventListener("pointerup", (e) => {
  if (!ptr.down) return;
  ptr.down = false;
  const role = ptr.role;
  ptr.role = null;
  if (swipeFx.active) { swipeFx.active = false; swipeFx.endAt = performance.now() + 450; }
  if (role !== "kick" && role !== "dive") return;
  const dx = e.clientX - ptr.x0, dy = e.clientY - ptr.y0;
  const len = Math.hypot(dx, dy);
  const minDim = Math.min(innerWidth, innerHeight);
  if (len < 24) return;                                 // タップは無視

  if (role === "kick" && canKick()) {
    // キッカー: スワイプ→シュート(描いた弧でカーブ)
    G.myKicked = true;
    const tx = (dx / minDim) * 8;
    const ty = clamp((-dy / minDim) * 4.2, 0.05, 4.5);
    const pow = clamp(len / (0.6 * minDim), 0.3, 1);
    net.send({ t: "kick", slot: mySlot(), tx, ty, pow, crv: swipeCurve(minDim) });
  } else if (role === "dive" && !G.myDove && G.kicks.some(Boolean)) {
    // キーパー: スワイプ→飛びこみ(画面右=世界の-x)。フルスワイプでゴール端から端まで
    G.myDove = true;
    const wx = -dx / len, wy = clamp(-dy / len, -0.25, 1);
    const L = Math.hypot(wx, wy) || 1;
    net.send({ t: "dive", dx: wx / L, dy: wy / L, len: clamp((len / (0.9 * minDim)) * DIVE_MAX, 0.7, DIVE_MAX) });
    setHint("");
  }
});

// ────────────────── メインループ(見た目のアニメ) ──────────────────
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();

  if (G.phase !== "lobby") {
    const sim = getSim();
    // キーパーの位置/飛びこみ
    G.keepers.forEach((k, i) => {
      if (!k.avatar) return;
      let pose = { x: k.x, y: 0, rotZ: 0 };
      if (k.dive) {
        let p = clamp((now - k.dive.atMs) / 1000 / DIVE_DUR, 0, 1);
        const frozenAt = sim ? sim.frozen[i] : Infinity;
        if (frozenAt !== Infinity) {
          p = Math.min(p, clamp((frozenAt - k.dive.atMs) / 1000 / DIVE_DUR, 0, 1));  // ぶつかった所で止まる
        }
        pose = divePose(k.x, k.dive, p);
      }
      k.avatar.position.set(pose.x, pose.y, KEEPER_Z);
      k.avatar.rotation.z = pose.rotZ;
    });

    // キッカーの助走とボール(スロットごと)
    const kn = G.kickers.length;
    G.kickers.forEach((k, i) => {
      const kick = G.kicks[i];
      const sx = ballSx(i, kn);
      if (k.avatar) {
        if (kick) {
          const tFly = (now - kick.launchAt) / 1000;
          if (tFly > -RUNUP && tFly < 0) {
            const p = 1 + tFly / RUNUP;                 // 0→1
            k.avatar.position.set(sx + 1.4 * (1 - p), Math.abs(Math.sin(p * Math.PI * 4)) * 0.09, (SPOT_Z + 1.6) - 1.3 * p);
          } else if (tFly >= 0) {
            k.avatar.position.set(sx, 0, SPOT_Z + 0.3);
          }
        } else {
          k.avatar.position.set(sx + 1.4, 0, SPOT_Z + 1.6);
        }
      }
      const ball = balls[i];
      if (!ball || !ball.visible) return;
      if (kick) {
        const tFly = (now - kick.launchAt) / 1000;
        if (tFly >= 0) {
          const T = flightT(kick.pow);
          const r = sim && sim.results ? sim.results[i] : null;
          const stopT = r && r.res === "save" ? r.hitT : T;
          const bp = ballPos(kick, Math.min(tFly, stopT));
          let bx = bp.x, by = bp.y, bz = bp.z;
          if (tFly > stopT) {
            const over = Math.min(tFly - stopT, 0.9);
            if (r && r.res === "save") {                 // はじかれた!
              bx += Math.sign(bx || 1) * over * 2.2;
              bz += over * 5.5;
              by = Math.max(BALL_R, by + over * 1.6 - over * over * 5);
            } else if (r && r.res === "goal") {          // ネットにつきささる
              bz = -Math.min(0.9, over * 4);
              by = Math.max(BALL_R, by - over * 2.4);
            } else {                                     // 枠外へ
              bx += (kick.tx / (Math.abs(kick.tx) || 1)) * over * 3;
              bz -= over * 7;
              by = Math.max(BALL_R, by + over * 1.2 - over * over * 6);
            }
          }
          ball.position.set(bx, by, bz);
          ball.rotation.x -= 0.28;
        } else {
          ball.position.set(sx, BALL_R + 0.03, SPOT_Z);
        }
      } else {
        ball.position.set(sx, BALL_R + 0.03, SPOT_Z);
        ball.rotation.x = 0;
      }
      ballShadows[i].position.set(ball.position.x, 0.013, ball.position.z);
    });
  }
  drawSwipeFx(now);
  renderer.render(scene, G.phase !== "lobby" ? updateCamera() : camera);
}

// ────────────────── ロビーUI ──────────────────
function chipRow(id, onPick) {
  const row = $(id);
  row.addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    row.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === b));
    onPick(Number(b.dataset.v));
  });
}
chipRow("soloKeepers", (v) => { G.cfg.keepers = v; });
chipRow("soloRounds", (v) => { G.cfg.rounds = v; });
chipRow("roomKeepers", (v) => { G.cfg.keepers = v; });
chipRow("roomCycles", (v) => { G.cfg.cycles = v; });
chipRow("advKickers", (v) => { G.cfg.kickersN = v; });
chipRow("advSetDur", (v) => { G.cfg.setDur = v; });
chipRow("advKickLimit", (v) => { G.cfg.kickLimit = v; });
chipRow("advCpu", (v) => { G.cfg.cpuLevel = v; });
chipRow("advSudden", (v) => { G.cfg.sudden = !!v; });
chipRow("roomMode", (v) => {
  G.cfg.teamMode = !!v;
  $("teamAssign").classList.toggle("hidden", !v);
  renderTeamAssign();
});

// ゲーム中⚙の「細かい設定」(ロビー側のチップ表示とも同期)
function syncChips(id, v) {
  document.querySelectorAll(`#${id} .chip`).forEach((c) => c.classList.toggle("active", Number(c.dataset.v) === Number(v)));
}
function bindGpChip(gpId, lobbyId, apply) {
  chipRow(gpId, (v) => { apply(v); syncChips(lobbyId, v); });
}
bindGpChip("gpKickers", "advKickers", (v) => { G.cfg.kickersN = v; if (isDirector()) host.rebuildRemaining(); });
bindGpChip("gpSetDur", "advSetDur", (v) => { G.cfg.setDur = v; });
bindGpChip("gpKickLimit", "advKickLimit", (v) => { G.cfg.kickLimit = v; });
bindGpChip("gpCpu", "advCpu", (v) => { G.cfg.cpuLevel = v; });
bindGpChip("gpSudden", "advSudden", (v) => { G.cfg.sudden = !!v; });
// ゲーム中⚙: なん本勝負・交代周数の途中変更(ロビーのチップとも同期)
chipRow("gpCycles", (v) => {
  if (!isDirector()) return;
  host.setRemainingCycles(v);
  if (G.mode === "solo") { G.cfg.rounds = v; syncChips("soloRounds", v); }
  else { G.cfg.cycles = v; syncChips("roomCycles", v); }
  $("gpInfo").textContent = `残り ${v}周に組み直したよ!(全部で ${host.order.length} ラウンド)`;
});

// チーム分け(ホストがロビーでタップして振り分け)
const teamOf = new Map();   // mid -> 0..3 | undefined
function renderTeamAssign() {
  const box = $("teamList");
  if (!box) return;
  if (!net.isHost || !G.cfg.teamMode) { box.innerHTML = ""; return; }
  box.innerHTML = "";
  for (const m of G.members) {
    const idx = teamOf.get(m.mid);
    const b = document.createElement("button");
    b.className = "chip team-pick" + (idx != null ? " t" + idx : "");
    b.textContent = (idx != null ? TEAMS[idx].emoji + " " : "❔ ") + m.name;
    b.onclick = () => {
      const cur = teamOf.get(m.mid);
      const next = cur == null ? 0 : cur + 1;
      if (next >= 4) teamOf.delete(m.mid); else teamOf.set(m.mid, next);
      renderTeamAssign();
    };
    box.appendChild(b);
  }
}
// スタート時にチーム構成を確定(未割り当ては小さいチームへ、1チーム以下なら半分こ)
function buildTeams() {
  const buckets = [[], [], [], []];
  const unassigned = [];
  for (const m of G.members) {
    const idx = teamOf.get(m.mid);
    if (idx != null) buckets[idx].push(m.mid); else unassigned.push(m.mid);
  }
  if (buckets.filter((b) => b.length).length < 2) {
    // ふり分けなし → 前後半分こ
    const mids = G.members.map((m) => m.mid);
    return [
      { ...TEAMS[0], mids: mids.slice(0, Math.ceil(mids.length / 2)) },
      { ...TEAMS[1], mids: mids.slice(Math.ceil(mids.length / 2)) },
    ].map((t) => ({ emoji: t.emoji, name: t.name, mids: t.mids }));
  }
  for (const mid of unassigned) {
    let best = -1;
    buckets.forEach((b, i) => { if (b.length && (best === -1 || b.length < buckets[best].length)) best = i; });
    buckets[best].push(mid);
  }
  return buckets.map((mids, i) => ({ emoji: TEAMS[i].emoji, name: TEAMS[i].name, mids })).filter((t) => t.mids.length);
}

$("modeSolo").onclick = () => setMode("solo");
$("modeRoom").onclick = () => setMode("room");
function setMode(m) {
  G.mode = m;
  G.cfg.keepers = m === "solo" ? 1 : 0;
  $("modeSolo").classList.toggle("active", m === "solo");
  $("modeRoom").classList.toggle("active", m === "room");
  $("soloPanel").classList.toggle("hidden", m !== "solo");
  $("roomPanel").classList.toggle("hidden", m !== "room");
  document.querySelectorAll("#soloKeepers .chip").forEach((c) => c.classList.toggle("active", c.dataset.v === "1"));
  document.querySelectorAll("#roomKeepers .chip").forEach((c) => c.classList.toggle("active", c.dataset.v === "0"));
}

$("soloStart").onclick = () => {
  G.mode = "solo";
  G.myMid = 0;
  G.members = [{ mid: 0, name: "あなた" }];
  host.startMatch(null);
};

$("nameInput").value = store.name;
$("roomInput").value = store.lastRoom || randomRoomId();
const saveNameFromInput = () => {
  const v = $("nameInput").value.trim().slice(0, 12);
  if (v) store.name = v;
};
function validRoomId() {
  const v = $("roomInput").value.trim();
  if (!/^\d{4}$/.test(v)) { setRoomStatus("部屋IDは4桁の数字で入れてね(例: 1234)", "err"); return null; }
  return v;
}
$("createRoomBtn").onclick = () => { saveNameFromInput(); const id = validRoomId(); if (id) createRoom(id); };
$("joinRoomBtn").onclick = () => { saveNameFromInput(); const id = validRoomId(); if (id) joinRoom(id); };
$("roomStart").onclick = () => {
  if (!net.isHost) return;
  if (G.members.length < 2) { setRoomStatus("2人以上そろってからスタートしてね!", "err"); return; }
  G.mode = "room";
  host.startMatch(G.cfg.teamMode ? buildTeams() : null);
};

// 視点切りかえ(キーパーのときだけ表示)
function refreshViewBtn() {
  $("viewBtn").classList.toggle("hidden", !(myKeeper() && G.phase !== "lobby"));
  $("viewBtn").textContent = camView === "big" ? "🎥 視点:大" : "🎥 視点:小";
}
$("viewBtn").onclick = () => {
  camView = camView === "big" ? "small" : "big";
  localStorage.setItem("lg_pk_cam", camView);
  refreshViewBtn();
};

// ゲーム中の⚙(ホスト/ソロだけ): 途中終了・1周追加・途中参加
function refreshGearBtn() {
  $("gearBtn").classList.toggle("hidden", !(isDirector() && G.phase !== "lobby"));
}
// ゲーム中⚙: チーム分け(タップで次のチームへ移動、次のラウンドから反映)
function renderGpTeams() {
  const wrap = $("gpTeams");
  const show = G.mode === "room" && net.isHost && !!G.teams;
  wrap.classList.toggle("hidden", !show);
  if (!show) return;
  const box = $("gpTeamList");
  box.innerHTML = "";
  for (const m of G.members) {
    const ti = G.teams.findIndex((t) => t.mids.includes(m.mid));
    const waiting = G.activeMids && !G.activeMids.has(m.mid);
    const b = document.createElement("button");
    b.className = "chip team-pick" + (ti >= 0 ? " t" + ti : "");
    b.textContent = (ti >= 0 ? G.teams[ti].emoji + " " : "❔ ") + m.name + (waiting ? "(待機中)" : "");
    b.onclick = () => {
      const next = ti < 0 ? 0 : (ti + 1) % G.teams.length;
      for (const t of G.teams) t.mids = t.mids.filter((x) => x !== m.mid);
      G.teams[next].mids.push(m.mid);
      teamOf.set(m.mid, next);                    // ロビーの振り分けとも同期
      net.send({ t: "teams", teams: G.teams });
      host.rebuildRemaining();
      renderGamePanel();
    };
    box.appendChild(b);
  }
}

function renderGamePanel() {
  if ($("gamePanel").classList.contains("hidden")) return;
  const total = isDirector() ? host.order.length : G.totalRounds;
  $("gpInfo").textContent = `ラウンド ${G.round}/${total}(残り ${Math.max(0, total - G.round)})`;
  syncChips("gpKickers", G.cfg.kickersN);
  syncChips("gpSetDur", G.cfg.setDur);
  syncChips("gpKickLimit", G.cfg.kickLimit);
  syncChips("gpCpu", G.cfg.cpuLevel);
  syncChips("gpSudden", G.cfg.sudden ? 1 : 0);
  renderGpTeams();
  const box = $("gpWaiting");
  box.innerHTML = "";
  if (G.mode === "room" && net.isHost && G.activeMids) {
    const waiting = G.members.filter((m) => !G.activeMids.has(m.mid));
    if (waiting.length) {
      const label = document.createElement("div");
      label.className = "gp-label";
      label.textContent = "待機中のメンバー(次のラウンドから参加できるよ)";
      box.appendChild(label);
      for (const m of waiting) {
        const row = document.createElement("div");
        row.className = "gp-wait-row";
        const name = document.createElement("span");
        name.textContent = "🙂 " + m.name;
        const btn = document.createElement("button");
        btn.className = "secondary-btn gp-admit";
        btn.textContent = "参加させる";
        btn.onclick = () => { host.admit(m.mid); };
        row.append(name, btn);
        box.appendChild(row);
      }
    } else {
      const label = document.createElement("div");
      label.className = "gp-label";
      label.textContent = "待機中のメンバーはいないよ";
      box.appendChild(label);
    }
  }
}
$("gearBtn").onclick = () => {
  $("gamePanel").classList.remove("hidden");
  renderGamePanel();
};
$("gpClose").onclick = () => $("gamePanel").classList.add("hidden");
$("gpAddCycle").onclick = () => {
  if (!isDirector()) return;
  host.addCycle();
  $("gpInfo").textContent = `1周追加したよ!(全部で ${host.order.length} ラウンド)`;
};
$("gpEnd").onclick = () => {
  if (!isDirector()) return;
  $("gamePanel").classList.add("hidden");
  host.clearTimers();
  host.finish(true);
};

$("quitBtn").onclick = () => {
  if (isDirector() && G.mode === "room") net.send({ t: "abort" });
  backToLobby();
};
$("againBtn").onclick = () => { if (isDirector()) host.startMatch(G.teams); };
$("lobbyBtn").onclick = () => {
  if (isDirector() && G.mode === "room" && G.phase !== "lobby") net.send({ t: "abort" });
  backToLobby();
};
addEventListener("beforeunload", () => destroyPeer());

// デバッグ用(コンソールから状態確認できるように)
window.__npk = { G, handleMsg, host, net, simulateAll, ballPos, ballHitsBody, divePose, slotXs, ballSx, swipeFx, getCamView: () => camView };

resize();
animate();
