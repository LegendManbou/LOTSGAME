// 各ゲームサイトの OGP 画像URLを取得して js/thumbs.js を生成する。
// 使い方: node tools/fetch-thumbs.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "js", "games.js"), "utf8");
const ctx = {};
vm.createContext(ctx);
vm.runInContext(src + "\n;__games = GAMES;", ctx);
const games = ctx.__games;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function ogImage(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html" },
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 300000);
    const meta =
      html.match(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i) ||
      html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
    if (!meta) return null;
    let img = meta[1].replace(/&amp;/g, "&").trim();
    if (!img || img.startsWith("data:")) return null;
    img = new URL(img, res.url).href; // 相対URL対応
    if (!/^https:/.test(img)) return null; // httpは混在コンテンツになるので除外
    return img;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const results = {};
let done = 0;
const queue = [...games];
async function worker() {
  while (queue.length) {
    const g = queue.shift();
    const img = await ogImage(g.url);
    done++;
    if (img) results[g.id] = img;
    console.log(`[${String(done).padStart(2)}/${games.length}] ${img ? "OK " : "-- "} ${g.name}`);
  }
}
await Promise.all(Array.from({ length: 10 }, worker));

const ordered = {};
for (const g of games) if (results[g.id]) ordered[g.id] = results[g.id];

const out =
  "// 自動生成: node tools/fetch-thumbs.mjs (公式OGP画像のURL)\n" +
  "// ここに無いゲームはファビコン → 絵文字カードでフォールバック表示。\n" +
  "const THUMBS = " + JSON.stringify(ordered, null, 2) + ";\n";
writeFileSync(join(root, "js", "thumbs.js"), out);
console.log(`\n${Object.keys(ordered).length}/${games.length} 件のサムネイルを取得 → js/thumbs.js`);
