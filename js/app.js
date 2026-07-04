/* LOTSGAME — ゲーム一覧 + 部屋機能(PeerJSによるP2P、サーバー不要) */

// ────────────────────────── 状態 ──────────────────────────
const store = {
  get name() { return localStorage.getItem("lg_name") || ""; },
  set name(v) { localStorage.setItem("lg_name", v); },
  get lastRoom() { return localStorage.getItem("lg_room") || ""; },
  set lastRoom(v) { localStorage.setItem("lg_room", v); },
};

const room = {
  peer: null,        // 自分のPeer
  isHost: false,
  hostConn: null,    // ゲスト時: ホストへの接続
  conns: new Map(),  // ホスト時: ゲスト接続 (peerId -> conn)
  id: "",            // 接続中の部屋ID
  members: [],       // [{name}] 全員分(ホストが配信)
  connected: false,
};

const PEER_PREFIX = "lotsgame-r";
const randomRoomId = () => String(Math.floor(1000 + Math.random() * 9000));
let candidateRoomId = store.lastRoom || randomRoomId();

// ────────────────────────── DOM ──────────────────────────
const $ = (id) => document.getElementById(id);
const grid = $("grid"), catFilter = $("catFilter");
const roomBadge = $("roomBadge"), roomDot = $("roomDot"), roomLabel = $("roomLabel");
const memberBar = $("memberBar");
const overlay = $("modalOverlay"), nameInput = $("nameInput"), roomInput = $("roomInput");
const roomStatus = $("roomStatus"), leaveBtn = $("leaveRoomBtn");

// ────────────────────────── 一覧表示 ──────────────────────────
let activeCat = "all";

function faviconUrl(gameUrl) {
  const host = new URL(gameUrl, location.href).hostname;
  if (host === location.hostname) return null; // サイト内の自作ゲームはファビコン不要
  return `https://www.google.com/s2/favicons?domain=${host}&sz=128`;
}

function renderFilter() {
  const cats = [["all", { label: "ぜんぶ", color: "#ffcf4d" }], ...Object.entries(CATS)];
  catFilter.innerHTML = "";
  for (const [key, c] of cats) {
    const b = document.createElement("button");
    b.className = "cat-chip" + (key === activeCat ? " active" : "");
    b.textContent = c.label;
    if (key === activeCat) b.style.background = c.color;
    b.onclick = () => { activeCat = key; renderFilter(); renderGrid(); };
    catFilter.appendChild(b);
  }
}

// 「みんなで遊ぶ神ゲー」の中のジャンル絞りこみ
let bestSub = "all";
function renderSubFilter() {
  const bar = $("subFilter");
  bar.classList.toggle("hidden", activeCat !== "best");
  if (activeCat !== "best") return;
  bar.innerHTML = "";
  const subs = [["all", { label: "ぜんぶ", color: "#ffcf4d" }],
    ...Object.entries(CATS).filter(([k]) => GAMES.some((g) => g.best && g.cat === k))];
  for (const [key, c] of subs) {
    const b = document.createElement("button");
    b.className = "cat-chip" + (key === bestSub ? " active" : "");
    b.textContent = c.label;
    if (key === bestSub) b.style.background = c.color;
    b.onclick = () => { bestSub = key; renderSubFilter(); renderGrid(); };
    bar.appendChild(b);
  }
}

function renderGrid() {
  grid.innerHTML = "";
  renderSubFilter();
  let list = GAMES.filter((g) => activeCat === "all" ||
    (activeCat === "best" ? g.best && (bestSub === "all" || g.cat === bestSub) : g.cat === activeCat));
  if (activeCat === "best") list = list.slice().sort((a, b) => a.best - b.best);
  list.forEach((g, idx) => {
    const cat = CATS[g.cat];
    const a = document.createElement("a");
    a.className = "card";
    a.href = g.url;
    a.target = "_blank";
    a.rel = "noopener";

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    thumb.style.background = `linear-gradient(135deg, ${cat.color}55, ${cat.color}22)`;
    const emoji = document.createElement("span");
    emoji.className = "emoji-fallback";
    emoji.textContent = g.emoji;
    thumb.appendChild(emoji);

    // 画像: 自作サムネ/OGPサムネ → ファビコン → 絵文字カード
    const og = g.img || (typeof THUMBS !== "undefined" && THUMBS[g.id]) || "";
    const fav = faviconUrl(g.url);
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "";
    img.onerror = () => {
      if (fav && img.src !== fav) {
        img.style.objectFit = "contain";
        img.style.inset = "18%";
        img.style.width = "64%";
        img.style.height = "64%";
        img.src = fav;
      } else {
        img.remove();
      }
    };
    if (og || fav) {
      img.src = og || fav;
      if (!og) { img.style.objectFit = "contain"; img.style.inset = "18%"; img.style.width = "64%"; img.style.height = "64%"; }
      thumb.appendChild(img);
    }
    if (activeCat === "best") {
      const rk = document.createElement("span");
      rk.className = "card-badge";
      rk.style.background = "#ffcf4d";
      rk.style.color = "#222";
      rk.textContent = ["🥇", "🥈", "🥉"][g.best - 1] || `${g.best}位`;
      thumb.appendChild(rk);
    } else if (g.badge) {
      const bd = document.createElement("span");
      bd.className = "card-badge";
      bd.textContent = g.badge;
      thumb.appendChild(bd);
    }

    const body = document.createElement("div");
    body.className = "card-body";
    const nm = document.createElement("div");
    nm.className = "card-name";
    nm.textContent = g.name;
    const ds = document.createElement("div");
    ds.className = "card-desc";
    ds.textContent = g.desc;
    const pl = document.createElement("span");
    pl.className = "card-players";
    pl.style.background = cat.color;
    pl.textContent = g.players;
    body.append(nm, ds, pl);

    a.append(thumb, body);
    a.addEventListener("click", () => broadcastPick(g));
    grid.appendChild(a);
  });
}

// ────────────────────────── トースト ──────────────────────────
function toast(html, ms = 6000) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = html;
  $("toastArea").appendChild(el);
  setTimeout(() => el.remove(), ms);
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ────────────────────────── 部屋UI ──────────────────────────
function myName() { return store.name || "ななしさん"; }

function updateRoomUI() {
  if (room.connected) {
    roomDot.className = "dot on";
    roomLabel.textContent = `部屋 ${room.id}・${room.members.length}人`;
    memberBar.classList.remove("hidden");
    memberBar.innerHTML = "";
    room.members.forEach((m, i) => {
      const c = document.createElement("span");
      c.className = "member-chip" + (m.self ? " me" : "");
      c.textContent = (i === 0 ? "👑 " : "🙂 ") + m.name;
      memberBar.appendChild(c);
    });
    leaveBtn.classList.remove("hidden");
  } else {
    roomDot.className = "dot";
    roomLabel.textContent = "部屋なし";
    memberBar.classList.add("hidden");
    leaveBtn.classList.add("hidden");
  }
}

function setStatus(msg, cls = "") {
  roomStatus.textContent = msg;
  roomStatus.className = "room-status " + cls;
}

// ────────────────────────── 部屋ロジック(PeerJS) ──────────────────────────
function destroyPeer() {
  if (room.peer) { try { room.peer.destroy(); } catch (_) {} }
  room.peer = null;
  room.hostConn = null;
  room.conns.clear();
  room.isHost = false;
  room.connected = false;
  room.members = [];
  room.id = "";
}

function leaveRoom(silent) {
  destroyPeer();
  updateRoomUI();
  if (!silent) setStatus("部屋から出たよ");
}

// ホスト: 全ゲストへ送信
function hostBroadcast(msg) {
  for (const conn of room.conns.values()) {
    if (conn.open) conn.send(msg);
  }
}

// ホスト: メンバー一覧を配って自分のUIも更新
function hostSyncMembers() {
  const names = [myName(), ...[...room.conns.values()].map((c) => c._lgName || "ななしさん")];
  hostBroadcast({ t: "members", names });
  room.members = names.map((n, i) => ({ name: n, self: i === 0 }));
  updateRoomUI();
}

function createRoom(id) {
  destroyPeer();
  setStatus("部屋を作成中…", "");
  roomDot.className = "dot wait";
  const peer = new Peer(PEER_PREFIX + id, { debug: 1 });
  room.peer = peer;

  peer.on("open", () => {
    room.isHost = true;
    room.connected = true;
    room.id = id;
    store.lastRoom = id;
    room.members = [{ name: myName(), self: true }];
    updateRoomUI();
    setStatus(`部屋 ${id} を作ったよ!\nみんなに「部屋ID ${id}」と伝えて、設定画面から「部屋に入る」してもらってね`, "ok");
  });

  peer.on("connection", (conn) => {
    conn.on("data", (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.t === "hello") {
        conn._lgName = String(msg.name || "ななしさん").slice(0, 12);
        room.conns.set(conn.peer, conn);
        hostSyncMembers();
        toast(`🙌 <b>${esc(conn._lgName)}</b> さんが部屋に入ったよ!`);
      } else if (msg.t === "pick") {
        const relayed = { t: "pick", name: conn._lgName || "ななしさん", gameId: msg.gameId };
        hostBroadcast(relayed);
        showPick(relayed);
      }
    });
    conn.on("close", () => {
      const left = conn._lgName;
      room.conns.delete(conn.peer);
      hostSyncMembers();
      if (left) toast(`👋 <b>${esc(left)}</b> さんが退出したよ`);
    });
  });

  peer.on("error", (err) => {
    if (err.type === "unavailable-id") {
      destroyPeer();
      updateRoomUI();
      setStatus(`部屋 ${id} はもう存在するみたい。「部屋に入る」で参加してみて!`, "err");
    } else {
      handlePeerError(err);
    }
  });
  peer.on("disconnected", () => { if (room.peer === peer && !peer.destroyed) peer.reconnect(); });
}

function joinRoom(id) {
  destroyPeer();
  setStatus(`部屋 ${id} に参加中…`, "");
  roomDot.className = "dot wait";
  const peer = new Peer({ debug: 1 });
  room.peer = peer;

  peer.on("open", () => {
    const conn = peer.connect(PEER_PREFIX + id, { reliable: true });
    room.hostConn = conn;
    let opened = false;

    conn.on("open", () => {
      opened = true;
      room.connected = true;
      room.id = id;
      store.lastRoom = id;
      conn.send({ t: "hello", name: myName() });
      setStatus(`部屋 ${id} に入ったよ!`, "ok");
      updateRoomUI();
    });
    conn.on("data", (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.t === "members") {
        room.members = msg.names.map((n) => ({ name: n, self: n === myName() }));
        updateRoomUI();
      } else if (msg.t === "pick") {
        showPick(msg);
      }
    });
    conn.on("close", () => {
      if (!opened) return;
      leaveRoom(true);
      setStatus("部屋が閉じられたみたい(ホストが退出したかも)", "err");
      toast("😢 部屋が閉じられたよ(ホストが退出したかも)");
    });
    // 一定時間つながらなければ諦める
    setTimeout(() => {
      if (!opened && room.peer === peer) {
        destroyPeer();
        updateRoomUI();
        setStatus(`部屋 ${id} が見つからない…。IDが合ってるか、部屋を作った人がページを開いたままか確認してね`, "err");
      }
    }, 12000);
  });

  peer.on("error", (err) => {
    if (err.type === "peer-unavailable") {
      destroyPeer();
      updateRoomUI();
      setStatus(`部屋 ${id} が見つからないよ。先に誰かが「部屋を作る」必要があるよ`, "err");
    } else {
      handlePeerError(err);
    }
  });
}

function handlePeerError(err) {
  console.warn("Peer error:", err.type, err);
  if (["network", "server-error", "socket-error", "socket-closed"].includes(err.type)) {
    destroyPeer();
    updateRoomUI();
    setStatus("通信サーバーにつながらない…。電波のいい場所でもう一度ためしてね", "err");
  }
}

// ゲームを選んだことをみんなに伝える
function broadcastPick(game) {
  if (!room.connected) return;
  if (room.isHost) {
    hostBroadcast({ t: "pick", name: myName(), gameId: game.id });
  } else if (room.hostConn && room.hostConn.open) {
    room.hostConn.send({ t: "pick", gameId: game.id });
  }
}

function showPick(msg) {
  if (msg.name === myName()) return; // 自分の分は表示しない
  const g = GAMES.find((x) => x.id === msg.gameId);
  if (!g) return;
  toast(`🎮 <b>${esc(msg.name)}</b> さんが「<b>${esc(g.name)}</b>」をえらんだよ!<a href="${g.url}" target="_blank" rel="noopener">ひらく ▶</a>`, 12000);
}

// ────────────────────────── 設定モーダル ──────────────────────────
function openModal() {
  nameInput.value = store.name;
  roomInput.value = room.connected ? room.id : candidateRoomId;
  setStatus(room.connected
    ? `いま部屋 ${room.id} に入ってるよ(${room.members.length}人)`
    : "「部屋を作る」→ 出てきたIDをみんなに伝える\n「部屋に入る」→ 聞いたIDを入れて参加!");
  roomStatus.className = "room-status" + (room.connected ? " ok" : "");
  overlay.classList.remove("hidden");
}
function closeModal() { overlay.classList.add("hidden"); }

function saveName() {
  const v = nameInput.value.trim().slice(0, 12);
  if (v) store.name = v;
}

function validRoomId() {
  const v = roomInput.value.trim();
  if (!/^\d{4}$/.test(v)) {
    setStatus("部屋IDは4桁の数字で入れてね(例: 1234)", "err");
    return null;
  }
  candidateRoomId = v;
  return v;
}

$("settingsBtn").onclick = openModal;
roomBadge.onclick = openModal;
$("modalClose").onclick = closeModal;
overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
$("saveBtn").onclick = () => { saveName(); closeModal(); };
$("createRoomBtn").onclick = () => {
  saveName();
  const id = validRoomId();
  if (id) createRoom(id);
};
$("joinRoomBtn").onclick = () => {
  saveName();
  const id = validRoomId();
  if (id) joinRoom(id);
};
leaveBtn.onclick = () => { leaveRoom(); updateRoomUI(); };

window.addEventListener("beforeunload", () => destroyPeer());

// ────────────────────────── 起動 ──────────────────────────
renderFilter();
renderGrid();
updateRoomUI();
// はじめての人には名前入力をうながす
if (!store.name) {
  setTimeout(() => toast("⚙️ 左上の設定から <b>なまえ</b> を決めて、部屋機能を使ってみてね!", 8000), 800);
}
