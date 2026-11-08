#!/usr/bin/env node
// Fills the 立ち絵 (sheet image URL) of sheets in the Notion database that have none, by reading
// each sheet's public page on its site:
//   いあきゃら      the sheet's share image (og:image), the first image on the sheet
//   キャラッシュ    /api/sheets/<token>/image, when the sheet has an image
//   vinsanet        the character image, as its unsigned Firebase Storage URL
//   ゆとシート      imageURL in the sheet's JSON output
//   Googleスプレッドシート (フタリソウサ)  the picture in the 探偵's or 助手's columns of "キャラシ"
//   キャラクターシート倉庫  /<system>/image?key=…, when it answers with an image
// Sheets that are private, or on sites without sheet images, are left empty.
//
//   node tools/fill-images.js [--dry-run]
//   node tools/fill-images.js --check <data.json>   (only looks the images up, for the sheets in a site build)
//
// It asks for the Notion token when it starts. NOTION_DATABASE_ID overrides the database.

const fs = require("fs");
const readline = require("readline");
const { gsImageFor } = require("../extension/gsheet.js");
const { NOTION_DEFAULT_DB, NOTION_GAP_MS, notionDbId, notionRequest, notionSleep } = require("../extension/notion.js");

const SITE_GAP_MS = 400;   // between requests to the sheet sites
// いあきゃら renders its share tags (og:image) only for link-preview crawlers.
const PREVIEW_UA = "Mozilla/5.0 (compatible; Twitterbot/1.0; charsheet-book image fill)";

function askHidden(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = () => {};
    process.stdout.write(question + "\n");
    rl.question("", answer => { resolve(answer.trim()); rl.close(); });
    rl.on("close", () => resolve(""));
  });
}

async function text(url, headers = {}) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}
const ogImage = html => (html.match(/<meta[^>]+(?:property|name)="og:image"[^>]+content="([^"]+)"/) ||
                         html.match(/<meta[^>]+content="([^"]+)"[^>]+(?:property|name)="og:image"/) || [])[1] || "";

// Source sheet URL -> image URL, or "" when there is none.
async function imageFor(sourceUrl) {
  let m;
  if ((m = sourceUrl.match(/^https:\/\/iachara\.com\/(?:view|edit)\/(\d+)/))) {
    const img = ogImage(await text(`https://iachara.com/view/${m[1]}`, { "User-Agent": PREVIEW_UA }));
    return /^https:\/\/image\.iaproject\.app\//.test(img) ? img : "";
  }
  if ((m = sourceUrl.match(/^https:\/\/charash\.jp\/(?:view|edit)\/([A-Za-z0-9_-]{12})/))) {
    const html = await text(`https://charash.jp/view/${m[1]}`);
    return new RegExp(`/api/sheets/${m[1]}/image`).test(html) ? `https://charash.jp/api/sheets/${m[1]}/image` : "";
  }
  if ((m = sourceUrl.match(/^https:\/\/vinsanet\.com\/characters\/([A-Za-z0-9_-]{21})/))) {
    const img = ogImage(await text(`https://vinsanet.com/characters/${m[1]}/view`));
    const s = img.match(/^https:\/\/storage\.googleapis\.com\/([^/]+)\/(characters\/[^?]+)/);
    return s ? `https://firebasestorage.googleapis.com/v0/b/${s[1]}/o/${encodeURIComponent(s[2])}?alt=media` : "";
  }
  if ((m = sourceUrl.match(/^(https:\/\/yutorize\.(?:work|2-d\.jp)\/[^?#]*)\?(?:.*&)?id=([A-Za-z0-9_-]+)/))) {
    const d = JSON.parse(await text(`${m[1]}?id=${m[2]}&mode=json`));
    return d.image && d.imageURL ? String(d.imageURL) : "";
  }
  if (/^https:\/\/docs\.google\.com\/spreadsheets\//.test(sourceUrl)) return gsImageFor(sourceUrl);
  if ((m = sourceUrl.match(/^https:\/\/character-sheets\.appspot\.com\/([a-z0-9]+)\/edit\.html\?key=([A-Za-z0-9_-]+)/))) {
    const url = `https://character-sheets.appspot.com/${m[1]}/image?key=${m[2]}`;
    const r = await fetch(url);
    const b = new Uint8Array(await r.arrayBuffer()).slice(0, 4);
    const isImage = (b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0xFF && b[1] === 0xD8) || (b[0] === 0x47 && b[1] === 0x49) || (b[0] === 0x52 && b[1] === 0x49);
    return r.ok && isImage ? url : "";
  }
  return "";
}

async function lookAll(list) {
  const found = [];
  for (const it of list) {
    let image = "", error = "";
    try { image = await imageFor(it.url); } catch (e) { error = e.message; }
    found.push({ ...it, image, error });
    process.stdout.write(image ? "o" : error ? "x" : ".");
    await notionSleep(SITE_GAP_MS);
  }
  process.stdout.write("\n");
  return found;
}

function report(found) {
  const by = {};
  for (const f of found) {
    const b = by[f.site || "?"] ||= { all: 0, image: 0, error: 0 };
    b.all++; if (f.image) b.image++; if (f.error) b.error++;
  }
  for (const [site, b] of Object.entries(by)) console.log(`  ${site}: ${b.all}枚中 立ち絵あり ${b.image}枚${b.error ? `・読めなかった ${b.error}枚` : ""}`);
  for (const f of found.filter(f => f.error)) console.log(`  読めなかった: ${f.name} (${f.error})`);
}

async function main() {
  const args = process.argv.slice(2);
  const checkAt = args.indexOf("--check");
  if (checkAt >= 0) {
    const data = JSON.parse(fs.readFileSync(args[checkAt + 1], "utf8"));
    const list = data.chars.filter(c => !c.image && c.sourceUrl).map(c => ({ name: c.name, site: c.sourceSite, url: c.sourceUrl }));
    console.log(`${list.length}枚を調べます`);
    report(await lookAll(list));
    return;
  }
  const dryRun = args.includes("--dry-run");

  const token = process.env.NOTION_TOKEN || await askHidden("Notionのトークンを貼り付けて Enter を押してください（入力は表示されません）");
  if (!token) { console.error("トークンが入力されませんでした。"); process.exit(2); }
  const db = notionDbId(process.env.NOTION_DATABASE_ID) || NOTION_DEFAULT_DB;

  const pages = [];
  let cursor;
  do {
    const r = await notionRequest(token, `/databases/${db}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    pages.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
    await notionSleep(NOTION_GAP_MS);
  } while (cursor);
  if (pages.length && !("立ち絵" in pages[0].properties)) {
    console.error("データベースに「立ち絵」（URL）のプロパティがありません。先に追加してください。"); process.exit(2);
  }

  const list = pages.filter(p => !p.properties["立ち絵"]?.url && p.properties["元シート"]?.url).map(p => ({
    page: p,
    name: (p.properties["名前"]?.title || []).map(t => t.plain_text).join(""),
    site: p.properties["サイト"]?.select?.name || "",
    url: p.properties["元シート"].url,
  }));
  console.log(`${pages.length}枚のうち 立ち絵が空の ${list.length}枚を調べます${dryRun ? "（--dry-run のため書き込みません）" : ""}`);
  const found = await lookAll(list);
  report(found);
  if (dryRun) return;

  const todo = found.filter(f => f.image);
  let failed = 0;
  for (const f of todo) {
    try {
      await notionRequest(token, `/pages/${f.page.id}`, { properties: { "立ち絵": { url: f.image } } }, "PATCH");
    } catch (e) {
      failed++;
      console.log(`  失敗: ${f.name}: ${e.message}`);
      if (e.fatal) break;
    }
    await notionSleep(NOTION_GAP_MS);
  }
  console.log(`立ち絵を入れた ${todo.length - failed}枚・失敗 ${failed}枚`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
