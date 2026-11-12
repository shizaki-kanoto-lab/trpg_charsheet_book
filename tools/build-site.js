#!/usr/bin/env node
// Builds the GitHub Pages site: reads every sheet in the Notion database and writes
// site/index.html (the viewer page), site/gallery.html (the character introduction page)
// and site/data.json (the sheets).
//
//   NOTION_TOKEN=... node tools/build-site.js [--previous https://<user>.github.io/<repo>/data.json]
//
// With --previous, a sheet whose Notion page has not changed since that build reuses its
// memo and chat palette instead of reading the page body again.

const fs = require("fs");
const path = require("path");
const { gsImageFor } = require("../extension/gsheet.js");
const { NOTION_DEFAULT_DB, NOTION_GAP_MS, notionDbId, notionRequest, notionSleep, notionSplitHo, notionScenarioKey, notionSameScenario } = require("../extension/notion.js");
const { RUNS_DB } = require("../extension/runs.js");

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
    case "relation": return p.relation.map(r => r.id.replace(/-/g, ""));
    case "date": return p.date?.start ?? null;
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
    galleryHidden: get("ギャラリー非表示") === "非表示",   // left out of gallery.html
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
// same-site) and their URLs expire, so each build reads them fresh from the sheet and the
// site carries its own copy under img/.
const SHEET = /^https:\/\/docs\.google\.com\/spreadsheets\//;
async function copyBlockedImages(chars) {
  const dir = path.join(OUT, "img");
  let copied = 0;
  for (const c of chars) {
    if (!SHEET.test(c.sourceUrl)) continue;
    const name = require("crypto").createHash("sha1").update(c.sourceUrl).digest("hex").slice(0, 16);
    try {
      const url = await gsImageFor(c.sourceUrl);
      if (!url) { c.image = ""; continue; }
      const r = await fetch(url);
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

// ケダモノオペラ characters live in their own Notion database ("ケダモノオペラCS"): one page per
// ケダモノ, with 設定・メモ as notes. From the page body only the first picture (the 擬似餌; the cover
// when there is none) and the links to 卓報告 pages, as the scenarios played, are read. They are added to the
// sheet book as system "ケダモノオペラ". Notion file URLs expire, so the picture is copied under img/.
const KEDAMONO_DB = "20c1b663c48f8089b06ec8b31f89f6c6";
const KEDAMONO_FIELDS = ["ケダモノ種", "亜種", "権能", "欲望", "伝説", "疑似餌の姿", "住処", "群れ"];
// Session logs (卓報告) linked from a ケダモノ page body (@-mentions or page links) are the scenarios it played.
// Only links to pages in the 卓報告 database count; their title (シナリオ) is the scenario name.
const TAKU_DB = "1351b663c48f803db061e20fee803137", TAKU_DS = "1351b663c48f8178bd49000b5c5cdd72";
const bare = id => String(id || "").replace(/-/g, "");
async function kedamonoBody(token, pageId) {
  const ids = [];
  let picture = "";
  let cursor;
  do {
    const r = await notionRequest(token, `/blocks/${pageId}/children?page_size=100${cursor ? "&start_cursor=" + cursor : ""}`);
    for (const b of r.results) {
      // The first picture in the body is the 擬似餌 (the cover is the ケダモノ itself).
      if (!picture && b.type === "image") picture = b.image.type === "external" ? b.image.external.url : b.image.file?.url || "";
      if (b.type === "link_to_page" && b.link_to_page.page_id && !ids.includes(b.link_to_page.page_id)) ids.push(b.link_to_page.page_id);
      for (const t of b[b.type]?.rich_text || [])
        if (t.type === "mention" && t.mention?.type === "page" && !ids.includes(t.mention.page.id)) ids.push(t.mention.page.id);
    }
    cursor = r.has_more ? r.next_cursor : null;
    await notionSleep(NOTION_GAP_MS);
  } while (cursor);
  const names = [];
  for (const id of ids) {
    try {
      const page = await notionRequest(token, `/pages/${id}`);
      await notionSleep(NOTION_GAP_MS);
      const parent = page.parent || {};
      if (bare(parent.database_id) !== TAKU_DB && bare(parent.data_source_id) !== TAKU_DS) continue;
      const title = Object.values(page.properties || {}).find(p => p.type === "title");
      const name = text(title?.title).trim();
      if (name && !names.includes(name)) names.push(name);
    } catch (e) { console.log(`リンク先の卓報告を読めませんでした: ${id} (${e.message})`); }
  }
  return { scenarios: names, picture };
}

// ほうかご探報 characters live in their own Notion database ("ほうかご探報"): one page per PC,
// with only 名前 as a property. The body is written by hand:
//   PC：真砂 宙継（まさご そらつぐ） / PL：…
//   【キャラ背景】 学年：２年生 / 特徴：… / …   -> the profile
//   【人間関係】 …                               -> the notes (any other 【…】 section too)
//   a picture                                    -> the face (copied under img/, the URL expires)
// The scenarios are the 卓報告 pages linked from the body; with none linked, a database of one PC
// takes every ほうかご探報 session in 卓報告 (who else could have played them).
const HOUKAGO_DB = "2d91b663c48f8023bc3af3ce0b9e5b1c";
async function houkagoBody(token, pageId) {
  const paras = [], ids = [];
  let picture = "", cursor;
  do {
    const r = await notionRequest(token, `/blocks/${pageId}/children?page_size=100${cursor ? "&start_cursor=" + cursor : ""}`);
    for (const b of r.results) {
      if (!picture && b.type === "image") picture = b.image.type === "external" ? b.image.external.url : b.image.file?.url || "";
      if (b.type === "link_to_page" && b.link_to_page.page_id) ids.push(b.link_to_page.page_id);
      const rich = b[b.type]?.rich_text || [];
      for (const t of rich) if (t.type === "mention" && t.mention?.type === "page") ids.push(t.mention.page.id);
      const t = text(rich).trim();
      if (t && ["paragraph", "quote", "callout", "bulleted_list_item", "numbered_list_item"].includes(b.type)) paras.push(t);
    }
    cursor = r.has_more ? r.next_cursor : null;
    await notionSleep(NOTION_GAP_MS);
  } while (cursor);
  return { paras, ids: [...new Set(ids)], picture };
}
async function houkagoChars(token) {
  const db = notionDbId(process.env.NOTION_HOUKAGO_DB_ID) || HOUKAGO_DB;
  let pages;
  try { pages = await allPages(token, db); }
  catch (e) { console.log(`ほうかご探報を読めませんでした (${e.message})。インテグレーションをこのデータベースにつないでください。`); return []; }
  // Every ほうかご探報 session in 卓報告, for a body that links none.
  let sessions = [];
  try {
    const r = await notionRequest(token, `/databases/${TAKU_DB}/query`, { page_size: 100, filter: { property: "システム", select: { equals: "ほうかご探報" } } });
    sessions = r.results.map(pg => ({ id: bare(pg.id), name: text(Object.values(pg.properties).find(p => p.type === "title")?.title).trim(), date: prop(pg.properties["日付"]) || "", role: prop(pg.properties["PL/GM"]) || "" }))
      .filter(t => t.name && t.role === "PL");
    await notionSleep(NOTION_GAP_MS);
  } catch (e) { console.log(`卓報告のほうかご探報を読めませんでした (${e.message})`); }
  const out = [];
  for (const page of pages) {
    const name = text(Object.values(page.properties).find(p => p.type === "title")?.title).trim();
    if (!name) continue;
    const body = await houkagoBody(token, page.id);
    let ruby = "", summary = "";
    const profile = [], notes = [];
    for (const para of body.paras) {
      const lines = para.split("\n").map(l => l.trim()).filter(Boolean);
      const pc = lines.find(l => /^PC[：:]/.test(l));
      if (pc) { ruby = (pc.match(/[（(]([^（）()]+)[）)]\s*$/) || [])[1] || ruby; continue; }
      const head = (lines[0].match(/^【([^】]+)】$/) || [])[1];
      if (head === "キャラ背景") {
        for (const l of lines.slice(1)) {
          const m = l.match(/^([^：:]{1,12})[：:]\s*(.+)$/);
          if (m) profile.push({ label: m[1].trim(), value: m[2].trim() });
        }
        continue;
      }
      if (lines.every(l => /^P[CL][：:]/.test(l))) continue;
      notes.push(lines.join("\n"));
    }
    summary = profile.find(x => x.label === "学年")?.value || "";
    // Scenarios: the linked 卓報告 pages, else (one PC) all ほうかご探報 sessions.
    const linked = [];
    for (const id of body.ids) {
      try {
        const pg = await notionRequest(token, `/pages/${id}`);
        await notionSleep(NOTION_GAP_MS);
        if (bare(pg.parent?.database_id) !== TAKU_DB && bare(pg.parent?.data_source_id) !== TAKU_DS) continue;
        linked.push({ name: text(Object.values(pg.properties).find(p => p.type === "title")?.title).trim(), date: prop(pg.properties["日付"]) || "" });
      } catch (e) { console.log(`リンク先の卓報告を読めませんでした: ${id} (${e.message})`); }
    }
    const played = (linked.length ? linked : pages.length === 1 ? sessions : []).filter(t => t.name)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const tags = [...new Set(played.map(t => t.name))];
    const dates = {};
    for (const t of played) if (t.date && !dates[t.name]) dates[t.name] = t.date;
    let image = "";
    if (body.picture) {
      try { image = await copyNotionImage(body.picture, page.id); }
      catch (e) { console.log(`立ち絵をコピーできませんでした: ${name} (${e.message})`); }
    }
    out.push({
      id: page.url, name, ruby, system: "ほうかご探報", sourceSite: "Notion", sourceUrl: "",
      image, summary, tags, ...(Object.keys(dates).length ? { dates } : {}), resources: [], stats: [], skills: [], profile,
      updatedAt: Date.parse(page.last_edited_time) || 0, galleryHidden: false,
      notes: notes.join("\n\n"), palette: "", piece: null,
    });
  }
  console.log(`ほうかご探報 ${out.length}人を読みました`);
  return out;
}

async function copyNotionImage(url, key) {
  const r = await fetch(url);
  const type = r.headers.get("content-type") || "";
  if (!r.ok || !type.startsWith("image/")) throw new Error(`${r.status} ${type}`);
  const ext = { "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" }[type] || ".png";
  const name = require("crypto").createHash("sha1").update(key).digest("hex").slice(0, 16);
  fs.mkdirSync(path.join(OUT, "img"), { recursive: true });
  fs.writeFileSync(path.join(OUT, "img", name + ext), Buffer.from(await r.arrayBuffer()));
  return `img/${name}${ext}`;
}

async function kedamonoChars(token) {
  const db = notionDbId(process.env.NOTION_KEDAMONO_DB_ID) || KEDAMONO_DB;
  let pages;
  try { pages = await allPages(token, db); }
  catch (e) { console.log(`ケダモノオペラCSを読めませんでした (${e.message})。インテグレーションをこのデータベースにつないでください。`); return []; }
  const out = [];
  for (const page of pages) {
    const p = page.properties;
    const get = name => prop(p[name]);
    const fileUrl = f => f?.type === "external" ? f.external.url : f?.file?.url;
    const body = await kedamonoBody(token, page.id);
    const picture = body.picture || fileUrl(page.cover);
    let image = "";
    if (picture) {
      try { image = await copyNotionImage(picture, page.id); }
      catch (e) { console.log(`立ち絵をコピーできませんでした: ${get("ケダモノ名")} (${e.message})`); }
    }
    const profile = KEDAMONO_FIELDS.map(k => { const v = get(k); return [k, Array.isArray(v) ? v.join("・") : String(v || "").trim()]; })
      .filter(([, v]) => v).map(([label, value]) => ({ label, value }));
    out.push({
      id: page.url, name: get("ケダモノ名") || "", ruby: "", system: "ケダモノオペラ", sourceSite: "Notion", sourceUrl: "",
      image, summary: get("ケダモノ種") || "", tags: body.scenarios, resources: [], stats: [], skills: [], profile,
      updatedAt: Date.parse(page.last_edited_time) || 0, galleryHidden: false,
      notes: String(get("設定・メモ") || "").trim(), palette: "", piece: null,
    });
  }
  console.log(`ケダモノオペラCS ${out.length}体を読みました`);
  return out;
}

// When each character played each scenario: 通過記録 rows and the date of their 卓報告. Only a row
// tied to one 卓報告 has a date: a row tied to several (すごろくしないと出られない部屋, played
// five times with different characters) can't tell which session was this character's.
// Map of sheet page id -> [{title, date}]. Empty when they can't be read.
async function runDates(token) {
  const out = new Map();
  try {
    const taku = new Map((await allPages(token, TAKU_DB)).map(pg => [pg.id.replace(/-/g, ""), prop(pg.properties["日付"])]));
    for (const pg of await allPages(token, RUNS_DB)) {
      const dates = (prop(pg.properties["卓報告"]) || []).map(id => taku.get(id));
      if (dates.length !== 1 || !dates[0]) continue;
      const title = prop(pg.properties["シナリオ"]) || "";
      for (const id of prop(pg.properties["キャラ"]) || []) {
        if (!out.has(id)) out.set(id, []);
        out.get(id).push({ title, date: dates[0] });
      }
    }
  } catch (e) { console.log(`通過記録・卓報告を読めませんでした (${e.message})。ギャラリーの最初のシナリオはシートの順になります。`); }
  return out;
}
// The date of each of a sheet's シナリオ lines, from its 通過記録 rows ({line: "YYYY-MM-DD"}).
function linesDated(page, runs) {
  const out = {};
  for (const line of String(prop(page.properties["シナリオ"]) || "").split("\n").map(s => s.trim()).filter(Boolean)) {
    const base = notionSplitHo(line.replace(/\s*(?:KPC|NPC)$/i, ""))[0].trim(), k = notionScenarioKey(base);
    const hit = runs.filter(r => { const t = notionScenarioKey(r.title); return notionSameScenario(r.title, base) || t.length >= 4 && k.length >= 4 && (k.includes(t) || t.includes(k)); })
      .map(r => r.date).sort()[0];
    if (hit) out[line] = hit;
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const prevAt = args.indexOf("--previous");
  const token = process.env.NOTION_TOKEN;
  if (!token) { console.error("NOTION_TOKEN がありません。"); process.exit(2); }
  const db = notionDbId(process.env.NOTION_DATABASE_ID) || NOTION_DEFAULT_DB;

  const prev = await previousBuild(prevAt >= 0 ? args[prevAt + 1] : "");
  const pages = await allPages(token, db);
  const runs = await runDates(token);
  const chars = [];
  let reused = 0;
  for (const page of pages) {
    const old = prev.get(page.url);
    const same = old && old.updatedAt === (Date.parse(page.last_edited_time) || 0);
    const body = same ? { notes: old.notes, palette: old.palette, piece: old.piece } : await pageBody(token, page.id);
    if (same) reused++;
    const c = toChar(page, body);
    const dated = linesDated(page, runs.get(page.id.replace(/-/g, "")) || []);
    if (Object.keys(dated).length) c.dates = dated;
    chars.push(c);
  }

  fs.mkdirSync(OUT, { recursive: true });
  await copyBlockedImages(chars);
  chars.push(...await kedamonoChars(token));
  chars.push(...await houkagoChars(token));
  fs.writeFileSync(path.join(OUT, "data.json"), JSON.stringify({ generatedAt: new Date().toISOString(), chars }));
  for (const f of ["favicon.svg", "banner.svg", "gallery.html", "crowla-light.png", "crowla-dark.png"]) fs.copyFileSync(path.join(ROOT, "web", f), path.join(OUT, f));
  const page = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
  fs.writeFileSync(path.join(OUT, "index.html"),
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow,noarchive,noimageindex"><link rel="icon" href="favicon.svg" type="image/svg+xml"></head><body>\n${page}\n</body></html>\n`);
  console.log(`${chars.length}枚を書き出しました（本文を読み直し ${chars.length - reused}枚・前回分を再利用 ${reused}枚）`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
