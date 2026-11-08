#!/usr/bin/env node
// Builds the GitHub Pages site: reads every sheet in the Notion database and writes
// site/index.html (the viewer page) and site/data.json (the sheets).
//
//   NOTION_TOKEN=... node tools/build-site.js [--previous https://<user>.github.io/<repo>/data.json]
//
// With --previous, a sheet whose Notion page has not changed since that build reuses its
// memo and chat palette instead of reading the page body again.

const fs = require("fs");
const path = require("path");
const { NOTION_DEFAULT_DB, NOTION_GAP_MS, notionDbId, notionRequest, notionSleep } = require("../extension/notion.js");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "site");

const text = rich => (rich || []).map(t => t.plain_text ?? t.text?.content ?? "").join("");
function prop(p) {
  if (!p) return null;
  switch (p.type) {
    case "title": return text(p.title);
    case "rich_text": return text(p.rich_text);
    case "number": return p.number;
    case "select": return p.select?.name ?? null;
    case "multi_select": return p.multi_select.map(o => o.name);
    case "url": return p.url;
    case "last_edited_time": return p.last_edited_time;
    default: return null;
  }
}

async function allPages(token, db) {
  const pages = [];
  let cursor;
  do {
    const r = await notionRequest(token, `/databases/${db}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    pages.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
    await notionSleep(NOTION_GAP_MS);
  } while (cursor);
  return pages;
}

// The page body as written by notionBlocks(): "メモ" paragraphs, "チャットパレット" and "ココフォリア駒" code blocks.
async function pageBody(token, id) {
  const blocks = [];
  let cursor;
  do {
    const r = await notionRequest(token, `/blocks/${id}/children?page_size=100${cursor ? "&start_cursor=" + cursor : ""}`);
    blocks.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
    await notionSleep(NOTION_GAP_MS);
  } while (cursor);
  const out = { notes: [], palette: "", piece: null };
  let heading = "";
  for (const b of blocks) {
    const v = b[b.type] || {};
    if (b.type.startsWith("heading_")) { heading = text(v.rich_text); continue; }
    const t = text(v.rich_text);
    if (heading === "メモ") { if (t.trim()) out.notes.push(t); }
    else if (heading === "チャットパレット" && b.type === "code") out.palette = t;
    else if (heading.startsWith("ココフォリア駒") && b.type === "code") { try { out.piece = JSON.parse(t); } catch {} }
  }
  return { notes: out.notes.join("\n\n"), palette: out.palette, piece: out.piece };
}

function toChar(page, body) {
  const p = page.properties;
  const get = name => prop(p[name]);
  // タグ holds the edition and similar marks; シナリオ holds scenario names and HO, one per line.
  const tags = [...(get("タグ") || []), ...String(get("シナリオ") || "").split("\n").map(s => s.trim()).filter(Boolean)];
  if (get("状態") === "ロスト") tags.push("ロスト");
  const resources = ["HP", "MP", "SAN"].filter(k => get(k) != null || get(k + "最大") != null)
    .map(k => ({ label: k, cur: get(k) ?? 0, max: get(k + "最大") ?? 0 }));
  const split = s => String(s || "").split(" / ").map(x => x.trim()).filter(Boolean);
  return {
    id: page.url, name: get("名前") || "", ruby: get("ふりがな") || "", system: get("システム") || "", sourceSite: get("サイト") || "",
    sourceUrl: get("元シート") || "", image: get("立ち絵") || "", summary: get("概要") || "", tags, resources,
    stats: split(get("能力値")).map(s => { const m = s.match(/^(.*\S)\s+(-?\d+)$/); return m ? { label: m[1], value: m[2] } : { label: s, value: "" }; }),
    skills: split(get("技能")).map(s => { const m = s.match(/^(.*?)(-?\d+)$/); return m ? { label: m[1], value: m[2] } : { label: s, value: "" }; }),
    updatedAt: Date.parse(page.last_edited_time) || 0,
    ...body,
  };
}

async function previousBuild(url) {
  if (!url) return new Map();
  try {
    const r = await fetch(url);
    if (!r.ok) return new Map();
    const data = await r.json();
    return new Map((data.chars || []).map(c => [c.id, c]));
  } catch { return new Map(); }
}

// Pictures from Google Sheets refuse to show on other sites (Cross-Origin-Resource-Policy:
// same-site), so the site carries its own copy under img/.
const COPY_IMAGE = /^https:\/\/docs\.google\.com\/sheets-images-rt\//;
async function copyBlockedImages(chars) {
  const dir = path.join(OUT, "img");
  let copied = 0;
  for (const c of chars) {
    if (!COPY_IMAGE.test(c.image)) continue;
    const name = require("crypto").createHash("sha1").update(c.image).digest("hex").slice(0, 16);
    try {
      const r = await fetch(c.image);
      const type = r.headers.get("content-type") || "";
      if (!r.ok || !type.startsWith("image/")) throw new Error(`${r.status} ${type}`);
      const ext = { "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" }[type] || ".png";
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name + ext), Buffer.from(await r.arrayBuffer()));
      c.image = `img/${name}${ext}`;
      copied++;
    } catch (e) {
      console.log(`立ち絵をコピーできませんでした: ${c.name} (${e.message})`);
      c.image = "";
    }
  }
  if (copied) console.log(`立ち絵 ${copied}枚をサイトにコピーしました`);
}

async function main() {
  const args = process.argv.slice(2);
  const prevAt = args.indexOf("--previous");
  const token = process.env.NOTION_TOKEN;
  if (!token) { console.error("NOTION_TOKEN がありません。"); process.exit(2); }
  const db = notionDbId(process.env.NOTION_DATABASE_ID) || NOTION_DEFAULT_DB;

  const prev = await previousBuild(prevAt >= 0 ? args[prevAt + 1] : "");
  const pages = await allPages(token, db);
  const chars = [];
  let reused = 0;
  for (const page of pages) {
    const old = prev.get(page.url);
    const same = old && old.updatedAt === (Date.parse(page.last_edited_time) || 0);
    const body = same ? { notes: old.notes, palette: old.palette, piece: old.piece } : await pageBody(token, page.id);
    if (same) reused++;
    chars.push(toChar(page, body));
  }

  fs.mkdirSync(OUT, { recursive: true });
  await copyBlockedImages(chars);
  fs.writeFileSync(path.join(OUT, "data.json"), JSON.stringify({ generatedAt: new Date().toISOString(), chars }));
  for (const f of ["favicon.svg", "banner.svg"]) fs.copyFileSync(path.join(ROOT, "web", f), path.join(OUT, f));
  const page = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
  fs.writeFileSync(path.join(OUT, "index.html"),
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex"><link rel="icon" href="favicon.svg" type="image/svg+xml"></head><body>\n${page}\n</body></html>\n`);
  console.log(`${chars.length}枚を書き出しました（本文を読み直し ${chars.length - reused}枚・前回分を再利用 ${reused}枚）`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
