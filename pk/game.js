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
const SET_DUR = 6;                       // 配置タイム秒数
const KICK_TIMEOUT = 12000;              // キッカーが蹴らない時の自動キック
const KEEPER_X_MAX = GOAL_W / 2 - 0.45;  // スタート位置の左右かぎり
const MAX_KEEPERS = 9, MAX_MEMBERS = 10; // 最大10人(キッカー1+キーパー9)
const slotXs = (n) => {                  // n人ぶんの初期位置をゴール幅に均等配置
  if (n <= 1) return [0];
  const span = 5.7 * (n - 1) / n;
  return Array.from({ length: n }, (_, i) => -span / 2 + (span * i) / (n - 1));
};

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
  cfg: { keepers: 1, rounds: 5, cycles: 1 },
  round: 0, totalRounds: 0,
  members: [],             // room: [{mid, name}] / solo: [{mid:0, name:あなた}]
  myMid: 0,
  kicker: null,            // {mid|null, name, cpu}
  keepers: [],             // [{mid|null, name, cpu, x, dive:null|{dx,dy,len,t}, avatar}]
  kick: null,              // {tx, ty, pow, launchAt(perfMs)}
  scores: {},              // name -> pts
  myDove: false, myKicked: false,
  verdictShown: false,
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

// ボール
const ball = new THREE.Mesh(
  new THREE.SphereGeometry(BALL_R + 0.03, 20, 20),
  new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x222233, roughness: 0.3 })
);
scene.add(ball);
const ballShadow = new THREE.Mesh(new THREE.CircleGeometry(0.16, 16), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }));
ballShadow.rotation.x = -Math.PI / 2;
scene.add(ballShadow);

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
let kickerAvatar = null;
function clearAvatars() {
  if (kickerAvatar) { scene.remove(kickerAvatar); kickerAvatar = null; }
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
// ボールの位置(カーブは横方向のふくらみ crv で表現、着地点は tx のまま)
function ballPos(kick, t) {
  const T = flightT(kick.pow), H = arcH(kick.pow);
  const s = clamp(t / T, 0, 1);
  return new THREE.Vector3(
    kick.tx * s + (kick.crv || 0) * 4 * s * (1 - s),
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

// kick: {tx,ty,pow,crv} / keepers: [{x, dive:{dx,dy,len,t}|null}] (tはボール発射=0とした秒)
function simulate(kick, keepers) {
  const T = flightT(kick.pow);
  const dt = 1 / 120;
  const ks = keepers.map((k) => ({ x0: k.x, dive: k.dive, frozenAt: Infinity }));
  const ballP = (t) => ballPos(kick, t);
  const poseOf = (k, t) => {
    if (!k.dive) return { x: k.x0, y: 0, rotZ: 0 };
    const p = clamp((Math.min(t, k.frozenAt) - k.dive.t) / DIVE_DUR, 0, 1);
    return divePose(k.x0, k.dive, p);
  };
  // キーパー同士の衝突(強い=長いスワイプが勝ち、負けた方はぶつかった所で止まる)
  // ※移動中(飛ぶ前)の重なりはOK。飛んだ後だけ力関係が働く
  const t0 = Math.min(0, ...ks.filter((k) => k.dive).map((k) => k.dive.t));
  const wasApart = new Map();            // ペアが一度はなれてから当たった時だけ衝突あつかい
  let firstTick = true;
  const centers = ks.map(() => ({ x: 0, y: 0 }));
  for (let t = t0; t <= T + DIVE_DUR; t += dt) {
    for (let i = 0; i < ks.length; i++) {
      const c = bodyPoint(poseOf(ks[i], t), 0.75);
      centers[i].x = c.x; centers[i].y = c.y;
    }
    for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) {
      const a = ks[i], b = ks[j];
      const key = i * 16 + j;
      const near = Math.hypot(centers[i].x - centers[j].x, centers[i].y - centers[j].y) < COLLIDE_D;
      if (near && wasApart.get(key) && !firstTick) {
        const movingA = a.dive && t > a.dive.t && t < a.dive.t + DIVE_DUR && a.frozenAt === Infinity;
        const movingB = b.dive && t > b.dive.t && t < b.dive.t + DIVE_DUR && b.frozenAt === Infinity;
        if (movingA && movingB && Math.abs(a.dive.len - b.dive.len) > 0.45) {
          if (a.dive.len > b.dive.len) b.frozenAt = t; else a.frozenAt = t;
        } else {
          if (movingA) a.frozenAt = t;
          if (movingB) b.frozenAt = t;
        }
        if (movingA || movingB) wasApart.set(key, false);
      }
      if (!near) wasApart.set(key, true);
    }
    firstTick = false;
  }
  // セーブ判定(体にちゃんと当たった時だけ弾く)
  for (let t = 0; t <= T; t += dt) {
    const bp = ballP(t);
    for (let i = 0; i < ks.length; i++) {
      if (ballHitsBody(poseOf(ks[i], t), bp)) {
        return { res: "save", by: i, hitT: t, hitPos: bp, frozen: ks.map((k) => k.frozenAt) };
      }
    }
  }
  // ゴールかミスか
  const inX = Math.abs(kick.tx) <= GOAL_W / 2 - 0.08;
  const inY = kick.ty >= 0 && kick.ty <= GOAL_H - 0.08;
  const nearPostX = Math.abs(Math.abs(kick.tx) - GOAL_W / 2) < 0.18 && kick.ty < GOAL_H;
  const nearBarY = Math.abs(kick.ty - GOAL_H) < 0.18 && Math.abs(kick.tx) < GOAL_W / 2;
  let res = inX && inY ? "goal" : "miss";
  if (res === "miss" && (nearPostX || nearBarY)) res = "post";
  return { res, by: -1, hitT: T, hitPos: ballP(T), frozen: ks.map((k) => k.frozenAt) };
}

function getSim() {
  const key = JSON.stringify([G.kick && [G.kick.tx, G.kick.ty, G.kick.pow], G.keepers.map((k) => [k.x, k.dive])]);
  if (!G.simCache || G.simCache.key !== key) {
    G.simCache = { key, sim: G.kick ? simulate(G.kick, G.keepers) : null };
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
    setRoomStatus(`部屋 ${id} を作ったよ!みんなに伝えて「部屋に入る」してもらってね`, "ok");
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
        // 配置タイム中のキックは受けつけない(ホストが門番)
        if (msg.t === "kick" && (G.phase !== "aim" || G.kick)) return;
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
  order: [], roundNo: 0, timers: [],
  kickAt: 0,               // ボール発射のperformance.now()
  clearTimers() { for (const t of this.timers) clearTimeout(t); this.timers = []; },
  after(ms, fn) { this.timers.push(setTimeout(fn, ms)); },

  startMatch() {
    this.clearTimers();
    const scores = {};
    if (G.mode === "solo") {
      this.order = [];
      for (let i = 0; i < G.cfg.rounds; i++) { this.order.push({ mid: 0 }); this.order.push({ cpu: true }); }
      scores["あなた"] = 0; scores["CPU"] = 0;
    } else {
      this.order = [];
      for (let c = 0; c < G.cfg.cycles; c++) for (const m of G.members) this.order.push({ mid: m.mid });
      for (const m of G.members) scores[m.name] = 0;
      if (this.needsCpu()) scores["CPU"] = 0;
    }
    this.roundNo = 0;
    net.send({ t: "start", scores });
    this.after(600, () => this.startRound());
  },
  needsCpu() {
    const humans = G.members.length - 1;
    const want = G.cfg.keepers === 0 ? clamp(humans, 1, MAX_KEEPERS) : G.cfg.keepers;
    return want > humans;
  },
  startRound() {
    this.clearTimers();
    if (this.roundNo >= this.order.length) { this.finish(); return; }
    const slot = this.order[this.roundNo];
    let kicker, humansForKeep;
    if (G.mode === "solo") {
      kicker = slot.cpu ? { cpu: true, name: "CPU" } : { mid: 0, name: "あなた" };
      humansForKeep = slot.cpu ? [{ mid: 0, name: "あなた" }] : [];
    } else {
      const m = G.members.find((x) => x.mid === slot.mid);
      if (!m) { this.roundNo++; this.startRound(); return; }   // 抜けた人はスキップ
      kicker = { mid: m.mid, name: m.name };
      humansForKeep = G.members.filter((x) => x.mid !== m.mid);
    }
    const want = G.mode === "solo"
      ? G.cfg.keepers
      : (G.cfg.keepers === 0 ? clamp(G.members.length - 1, 1, MAX_KEEPERS) : G.cfg.keepers);
    const keepers = [];
    const n = clamp(want, 1, MAX_KEEPERS);
    const xs = slotXs(n);
    for (let i = 0; i < n; i++) {
      const h = humansForKeep[i];
      keepers.push(h
        ? { mid: h.mid, name: h.name, cpu: false, x: xs[i] }
        : { cpu: true, name: "CPU" + (i + 1), x: xs[i] + (Math.random() - 0.5) * 0.5 });
    }
    this.roundNo++;
    net.send({ t: "round", no: this.roundNo, total: this.order.length, kicker, keepers, setDur: SET_DUR });
    this.after(SET_DUR * 1000, () => {
      net.send({ t: "aim" });
      // CPUキッカーはすこし考えてから蹴る
      if (kicker.cpu) this.after(1200 + Math.random() * 1600, () => this.cpuKick());
      // キッカーがずっと蹴らなければ自動キック
      this.after(KICK_TIMEOUT, () => { if (!G.kick) net.send({ t: "kick", mid: -1, tx: (Math.random() - 0.5) * 3, ty: 0.7, pow: 0.5 }); });
    });
  },
  cpuKick() {
    if (G.kick) return;
    const wild = Math.random() < 0.1;
    const tx = (Math.random() < 0.5 ? -1 : 1) * (wild ? 3.9 + Math.random() * 0.8 : 1.6 + Math.random() * 1.9);
    const ty = Math.random() < 0.45 ? 0.2 + Math.random() * 0.5 : 1.2 + Math.random() * (wild ? 1.6 : 0.9);
    const crv = Math.random() < 0.4 ? (Math.random() - 0.5) * 2.4 : 0;   // ときどきカーブも蹴る
    net.send({ t: "kick", mid: -1, tx, ty, pow: 0.55 + Math.random() * 0.4, crv });
  },
  onKick() {               // kick配信直後にホストが呼ぶ
    this.kickAt = performance.now() + RUNUP * 1000;
    // CPUキーパーの飛びこみ
    G.keepers.forEach((k, i) => {
      if (!k.cpu) return;
      const delay = RUNUP * 1000 + 100 + Math.random() * 280;
      this.after(delay, () => {
        if (k.dive) return;
        // 判定がピンポイントになったぶん、当たりを読めた時の精度は少し上げる
        const guess = Math.random() < 0.68;
        const gx = guess ? G.kick.tx + (Math.random() - 0.5) * 0.7 : (Math.random() - 0.5) * 6;
        const gy = guess ? G.kick.ty + (Math.random() - 0.5) * 0.5 : Math.random() * 2;
        const dx = gx - k.x, dy = gy - TORSO_Y;
        const L = Math.hypot(dx, dy) || 1;
        net.send({ t: "dive", ki: i, dx: dx / L, dy: clamp(dy / L, -0.25, 1), len: clamp(L, 0.6, DIVE_MAX) });
      });
    });
    // 判定はボール到着後に確定(とんちゅうの飛びこみも入れるため)
    const T = flightT(G.kick.pow);
    this.after(RUNUP * 1000 + T * 1000 + 200, () => {
      const sim = simulate(G.kick, G.keepers);
      const scores = { ...G.scores };
      if (sim.res === "goal") scores[G.kicker.cpu ? "CPU" : G.kicker.name] = (scores[G.kicker.cpu ? "CPU" : G.kicker.name] || 0) + 1;
      if (sim.res === "save") {
        const k = G.keepers[sim.by];
        const key = k.cpu ? "CPU" : (G.mode === "solo" ? "あなた" : k.name);
        scores[key] = (scores[key] || 0) + 1;
      }
      net.send({ t: "verdict", res: sim.res, by: sim.by, scores });
      this.after(3000, () => this.startRound());
    });
  },
  finish() {
    net.send({ t: "final", scores: G.scores });
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
      showMatch();
      break;
    case "round": startRoundView(msg); break;
    case "aim": startAimView(); break;
    case "pos": {
      // 蹴る瞬間(kick受信)までは自由に動ける
      const k = G.keepers.find((x) => !x.cpu && x.mid === msg.mid);
      if (k && (G.phase === "set" || (G.phase === "aim" && !G.kick))) k.x = clamp(msg.x, -KEEPER_X_MAX, KEEPER_X_MAX);
      break;
    }
    case "kick": {
      if (G.kick) break;
      G.kick = { tx: msg.tx, ty: msg.ty, pow: msg.pow, crv: msg.crv || 0, launchAt: performance.now() + RUNUP * 1000 };
      // 先に飛んじゃった人の飛びこみ時刻を発射基準に直す
      for (const k of G.keepers) {
        if (k.dive && k.dive.t == null) k.dive.t = clamp((k.diveAtMs - G.kick.launchAt) / 1000, -6, 0);
      }
      G.simCache = null;
      G.phase = "fly";
      setPhaseMsg("");
      setHint(myKeeper() && !myKeeper().dive ? "きた!スワイプで飛びこめ!" : "");
      if (isDirector()) host.onKick();
      break;
    }
    case "dive": {
      const k = msg.ki != null ? G.keepers[msg.ki] : G.keepers.find((x) => !x.cpu && x.mid === msg.mid);
      if (!k || k.dive) break;
      k.diveAtMs = performance.now();
      const t = G.kick ? (k.diveAtMs - G.kick.launchAt) / 1000 : null;   // 発射前はキック時に確定
      // どんなに強くてもゴールの外へは飛び出さない(距離をつめる)
      const XB = GOAL_W / 2 - 0.25;
      let len = msg.len;
      if (msg.dx > 0.01) len = Math.min(len, (XB - k.x) / msg.dx);
      else if (msg.dx < -0.01) len = Math.min(len, (k.x + XB) / -msg.dx);
      k.dive = { dx: msg.dx, dy: msg.dy, len: Math.max(0.2, len), t };
      G.simCache = null;
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
function myKeeper() { return G.keepers.find((k) => !k.cpu && k.mid === G.myMid && G.mode !== "solo") || G.keepers.find((k) => !k.cpu && G.mode === "solo" && k.mine); }

function startRoundView(msg) {
  G.phase = "set";
  G.round = msg.no; G.totalRounds = msg.total;
  G.kicker = msg.kicker;
  G.kick = null; G.simCache = null;
  G.myDove = false; G.myKicked = false;
  G.verdictShown = false;
  clearAvatars();
  G.keepers = msg.keepers.map((k) => ({ ...k, dive: null }));
  if (G.mode === "solo") for (const k of G.keepers) if (!k.cpu) k.mine = true;

  // アバター生成
  G.keepers.forEach((k, i) => {
    k.avatar = makeAvatar(k.cpu ? "🤖" + k.name : k.name, i + 1, true);
    k.avatar.position.set(k.x, 0, KEEPER_Z);
  });
  const mineK = myKeeper();
  if (mineK) mineK.avatar.userData.label.visible = false;   // 自分のラベルは目の前でデカいので消す
  kickerAvatar = makeAvatar(G.kicker.cpu ? "🤖CPU" : G.kicker.name, 0, false);
  kickerAvatar.position.set(1.4, 0, SPOT_Z + 1.6);
  // 自分がキッカーのときは自分の名前ラベルを消す(目の前でデカくなるので)
  if (!G.kicker.cpu && G.kicker.mid === G.myMid) kickerAvatar.userData.label.visible = false;
  ball.position.set(0, BALL_R + 0.03, SPOT_Z);

  const meK = myKeeper();
  const iAmKicker = !G.kicker.cpu && G.kicker.mid === G.myMid && (G.mode !== "solo" || !G.kicker.cpu);
  $("roundLabel").textContent = `ラウンド ${G.round}/${G.totalRounds}`;
  setPhaseMsg(iAmKicker ? "あなたがキッカー!⚽" : `キッカーは ${G.kicker.cpu ? "CPU🤖" : G.kicker.name} !`);
  setHint(meK ? "← 左右にドラッグで移動!(蹴る瞬間まで動けるよ) →" : "キーパーが位置についてるよ…");
  refreshViewBtn();
  // 配置カウントダウン
  const timerEl = $("setTimer");
  timerEl.classList.remove("hidden");
  const end = performance.now() + msg.setDur * 1000;
  const tick = () => {
    const left = Math.max(0, (end - performance.now()) / 1000);
    timerEl.textContent = Math.ceil(left);
    if (left > 0 && G.phase === "set") requestAnimationFrame(tick);
    else timerEl.classList.add("hidden");
  };
  tick();
  updateScoreStrip();
}

function startAimView() {
  if (G.phase !== "set") return;
  G.phase = "aim";
  $("setTimer").classList.add("hidden");
  const meK = myKeeper();
  const iAmKicker = !G.kicker.cpu && G.kicker.mid === G.myMid;
  setPhaseMsg(iAmKicker ? "スワイプでシュート!!" : `${G.kicker.cpu ? "CPU🤖" : G.kicker.name} がねらってる…`);
  setHint(iAmKicker
    ? "スワイプの向き=コース、長さ=つよさ!弧を描くとカーブ!"
    : meK ? "まだ左右に動ける!蹴った瞬間からスワイプで飛びこみ(1回だけ)" : "どうなる!?");
}

function showVerdict(msg) {
  G.phase = "verdict";
  G.scores = msg.scores;
  G.verdictShown = true;
  updateScoreStrip();
  const b = $("bigBanner");
  b.classList.remove("hidden", "goal", "save", "miss");
  if (msg.res === "goal") {
    b.classList.add("goal");
    b.innerHTML = `GOAL!!<small>${esc(G.kicker.cpu ? "CPU" : G.kicker.name)} が決めた!</small>`;
    camShake = 0.25;
  } else if (msg.res === "save") {
    const k = G.keepers[msg.by];
    b.classList.add("save");
    b.innerHTML = `SAVE!!<small>${esc(k ? (k.cpu ? k.name : (G.mode === "solo" ? "あなた" : k.name)) : "キーパー")} のスーパーセーブ!</small>`;
    camShake = 0.2;
  } else if (msg.res === "post") {
    b.classList.add("miss");
    b.innerHTML = `ポスト!!<small>おしい!わくに当たった!</small>`;
  } else {
    b.classList.add("miss");
    b.innerHTML = `MISS…<small>わくの外にとんでいった…</small>`;
  }
  setHint("");
  setTimeout(() => b.classList.add("hidden"), 2600);
}

function showFinal(scores) {
  G.phase = "final";
  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const medals = ["🥇", "🥈", "🥉"];
  const el = $("finalRanking");
  el.innerHTML = "";
  entries.forEach(([name, pts], i) => {
    const row = document.createElement("div");
    row.className = "rank-row" + (i === 0 ? " first" : "");
    row.innerHTML = `<span class="medal">${medals[i] || "🎖"}</span><span>${esc(name)}</span><span class="pts">${pts}てん</span>`;
    el.appendChild(row);
  });
  $("againBtn").classList.toggle("hidden", !isDirector());
  $("finalOverlay").classList.remove("hidden");
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function setPhaseMsg(s) { $("phaseMsg").textContent = s; }
function setHint(s) { $("hintMsg").textContent = s; }
function updateScoreStrip() {
  const el = $("scoreStrip");
  el.innerHTML = "";
  for (const [name, pts] of Object.entries(G.scores)) {
    const c = document.createElement("span");
    c.className = "score-chip" + (G.kicker && name === (G.kicker.cpu ? "CPU" : G.kicker.name) ? " kicker" : "");
    c.textContent = `${name} ${pts}`;
    el.appendChild(c);
  }
}

// ────────────────── 画面切り替え ──────────────────
function showMatch() {
  $("lobby").classList.add("hidden");
  $("finalOverlay").classList.add("hidden");
  $("hud").classList.remove("hidden");
}
function backToLobby() {
  G.phase = "lobby";
  host.clearTimers();
  clearAvatars();
  G.keepers = [];
  $("hud").classList.add("hidden");
  $("finalOverlay").classList.add("hidden");
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

const canMoveKeeper = () => G.phase === "set" || (G.phase === "aim" && !G.kick);

layer.addEventListener("pointerdown", (e) => {
  if (G.phase === "lobby" || G.phase === "final") return;
  const meK = myKeeper();
  const iAmKicker = G.kicker && !G.kicker.cpu && G.kicker.mid === G.myMid;
  ptr.down = true;
  ptr.x0 = e.clientX; ptr.y0 = e.clientY;
  if (iAmKicker && G.phase === "aim" && !G.myKicked) ptr.role = "kick";
  else if (meK && G.phase === "fly" && G.kick && !G.myDove) ptr.role = "dive";
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

  if (role === "kick" && G.phase === "aim" && !G.kick && !G.myKicked) {
    // キッカー: スワイプ→シュート(描いた弧でカーブ)
    G.myKicked = true;
    const tx = (dx / minDim) * 8;
    const ty = clamp((-dy / minDim) * 4.2, 0.05, 4.5);
    const pow = clamp(len / (0.6 * minDim), 0.3, 1);
    net.send({ t: "kick", tx, ty, pow, crv: swipeCurve(minDim) });
  } else if (role === "dive" && G.kick && !G.myDove) {
    // キーパー: スワイプ→飛びこみ(画面右=世界の-x)。フルスワイプでゴール端から端まで
    G.myDove = true;
    const wx = -dx / len, wy = clamp(-dy / len, -0.25, 1);
    const L = Math.hypot(wx, wy) || 1;
    net.send({ t: "dive", dx: wx / L, dy: wy / L, len: clamp((len / (0.9 * minDim)) * DIVE_MAX, 0.7, DIVE_MAX) });
    setHint("");
  }
});

// ────────────────── メインループ(見た目のアニメ) ──────────────────
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();

  if (G.phase !== "lobby") {
    // キーパーの位置/飛びこみ
    const sim = G.kick ? getSim() : null;
    const tFly = G.kick ? (now - G.kick.launchAt) / 1000 : -99;
    G.keepers.forEach((k, i) => {
      if (!k.avatar) return;
      let pose = { x: k.x, y: 0, rotZ: 0 };
      if (k.dive) {
        // アニメは受信時刻ベース(蹴る前に飛んでもちゃんと飛ぶ)。判定と同じdivePoseを使う
        let p = clamp((now - k.diveAtMs) / 1000 / DIVE_DUR, 0, 1);
        const frozenAt = sim ? sim.frozen[i] : Infinity;
        if (frozenAt !== Infinity && k.dive.t != null) {
          p = Math.min(p, clamp((frozenAt - k.dive.t) / DIVE_DUR, 0, 1));  // ぶつかった所で止まる
        }
        pose = divePose(k.x, k.dive, p);
      }
      k.avatar.position.set(pose.x, pose.y, KEEPER_Z);
      k.avatar.rotation.z = pose.rotZ;
    });

    // キッカーの助走
    if (kickerAvatar) {
      if (G.kick && tFly > -RUNUP && tFly < 0) {
        const p = 1 + tFly / RUNUP;                     // 0→1
        kickerAvatar.position.set(1.4 * (1 - p), Math.abs(Math.sin(p * Math.PI * 4)) * 0.09, (SPOT_Z + 1.6) - 1.3 * p);
      } else if (G.kick && tFly >= 0) {
        kickerAvatar.position.set(0, 0, SPOT_Z + 0.3);
      }
    }

    // ボール
    if (G.kick && tFly >= 0) {
      const T = flightT(G.kick.pow);
      const stopT = sim && sim.res === "save" ? sim.hitT : T;
      const bp = ballPos(G.kick, Math.min(tFly, stopT));
      let bx = bp.x, by = bp.y, bz = bp.z;
      if (tFly > stopT) {
        const over = Math.min(tFly - stopT, 0.9);
        if (sim && sim.res === "save") {                // はじかれた!
          bx += Math.sign(bx || 1) * over * 2.2;
          bz += over * 5.5;
          by = Math.max(BALL_R, by + over * 1.6 - over * over * 5);
        } else if (sim && sim.res === "goal") {          // ネットにつきささる
          bz = -Math.min(0.9, over * 4);
          by = Math.max(BALL_R, by - over * 2.4);
        } else {                                         // 枠外へ
          bx += (G.kick.tx / (Math.abs(G.kick.tx) || 1)) * over * 3;
          bz -= over * 7;
          by = Math.max(BALL_R, by + over * 1.2 - over * over * 6);
        }
      }
      ball.position.set(bx, by, bz);
      ball.rotation.x -= 0.28;
    } else if (!G.kick) {
      ball.position.set(0, BALL_R + 0.03, SPOT_Z);
      ball.rotation.x = 0;
    }
    ballShadow.position.set(ball.position.x, 0.013, ball.position.z);
  }
  drawSwipeFx(now);
  renderer.render(scene, G.phase !== "lobby" ? updateCamera() : camera);
}
resize();
animate();

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
  host.startMatch();
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
  host.startMatch();
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

$("quitBtn").onclick = () => {
  if (isDirector() && G.mode === "room") net.send({ t: "abort" });
  backToLobby();
};
$("againBtn").onclick = () => { if (isDirector()) host.startMatch(); };
$("lobbyBtn").onclick = () => {
  if (isDirector() && G.mode === "room" && G.phase !== "lobby") net.send({ t: "abort" });
  backToLobby();
};
addEventListener("beforeunload", () => destroyPeer());

// デバッグ用(コンソールから状態確認できるように)
window.__npk = { G, handleMsg, host, net, simulate, ballPos, ballHitsBody, divePose, slotXs, swipeFx, getCamView: () => camView };
