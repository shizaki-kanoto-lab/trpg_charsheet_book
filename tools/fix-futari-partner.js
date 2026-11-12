#!/usr/bin/env node
// Rewrites the 「パートナー: …」 line in the メモ of フタリソウサ sheets so it carries the partner's
// 役割, クラス and 背景, as extension/gsheet.js and extension/appspot.js now write it. Each sheet is
// read again from its source (the Google Sheets template, or キャラクターシート倉庫).
//
//   NOTION_TOKEN=... node tools/fix-futari-partner.js [--write]
//
// Only that one line of the memo paragraph changes.

const { NOTION_DEFAULT_DB, NOTION_GAP_MS, notionDbId, notionRequest, notionSleep } = require("../extension/notion.js");
const { gsheetToItems } = require("../extension/gsheet.js");
const { appspotToItem } = require("../extension/appspot.js");

const text = rich => (rich || []).map(t => t.plain_text ?? t.text?.content ?? "").join("");
const get = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 60)}`); return r.text(); };

// The same reads as gsheetFetchSheets / appspotFetchSheets, from Node.
async function sourceItem(url) {
  let m = url.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  if (m) {
    const base = `https://docs.google.com/spreadsheets/d/${m[1]}`;
    const tabs = {};
    for (const t of (await get(`${base}/htmlview`)).matchAll(/\{name: "([^"]+)", pageUrl: "[^"]*?gid=(\d+)/g)) tabs[t[1]] = t[2];
    const main = await get(`${base}/export?format=csv&gid=${tabs["キャラシ"] ?? "0"}`);
    const ccf = tabs["ココフォリアコピペ用"] ? await get(`${base}/export?format=csv&gid=${tabs["ココフォリアコピペ用"]}`).catch(() => "") : "";
    const items = gsheetToItems({ id: m[1], title: "", main, ccf, html: "" });
    const role = decodeURIComponent((url.match(/#(.+)$/) || [])[1] || "");
    return items.find(i => decodeURIComponent((i.url.match(/#(.+)$/) || [])[1] || "") === role);
  }
  m = url.match(/^https:\/\/character-sheets\.appspot\.com\/([^/]+)\/edit\.html\?key=([^&#]+)/);
  if (m) {
    const data = JSON.parse(await get(`https://character-sheets.appspot.com/${m[1]}/display?ajax=1&key=${m[2]}`));
    return appspotToItem({ key: m[2], system: m[1], systemName: "フタリソウサ", data });
  }
  throw new Error("元シートを読めない形式です");
}

async function main() {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN がありません");
  const write = process.argv.includes("--write");
  const db = notionDbId(process.env.NOTION_DATABASE_ID || NOTION_DEFAULT_DB);
  const r = await notionRequest(token, `/databases/${db}/query`, { page_size: 100, filter: { property: "システム", select: { equals: "フタリソウサ" } } });
  console.log(`フタリソウサのシート ${r.results.length} 枚`);
  const report = { changed: [], same: [], skipped: [] };
  for (const page of r.results) {
    const name = text(page.properties["名前"]?.title) || page.id;
    try {
      const item = await sourceItem(page.properties["元シート"]?.url || "");
      const want = (String(item?.notes || "").match(/^パートナー: .*$/m) || [])[0];
      if (!want) { report.skipped.push(`${name}: 元シートにパートナーがいません`); continue; }
      const blocks = (await notionRequest(token, `/blocks/${page.id}/children?page_size=100`)).results;
      await notionSleep(NOTION_GAP_MS);
      const b = blocks.find(b => b.type === "paragraph" && /^パートナー: /m.test(text(b.paragraph.rich_text)));
      if (!b) { report.skipped.push(`${name}: メモにパートナーの行がありません`); continue; }
      const cur = text(b.paragraph.rich_text);
      const next = cur.replace(/^パートナー: .*$/m, want);
      if (next === cur) { report.same.push(name); continue; }
      report.changed.push(`${name}\n  前: ${cur.match(/^パートナー: .*$/m)[0]}\n  後: ${want}`);
      if (write) await notionRequest(token, `/blocks/${b.id}`, { paragraph: { rich_text: [{ type: "text", text: { content: next } }] } }, "PATCH");
    } catch (e) { report.skipped.push(`${name}: ${e.message}`); }
    await notionSleep(NOTION_GAP_MS);
  }
  console.log(`\n${write ? "直した" : "直す予定の"}シート ${report.changed.length} 枚\n` + report.changed.join("\n"));
  console.log(`\nもう直っているシート ${report.same.length} 枚\n` + report.same.join("\n"));
  console.log(`\n触らなかったシート ${report.skipped.length} 枚\n` + report.skipped.join("\n"));
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
