#!/usr/bin/env node
// Brings the メモ of フタリソウサ sheets in line with their source sheet (the Google Sheets template, or
// キャラクターシート倉庫), read again: the 「パートナー: …」 line (役割・クラス・背景), and the ＜異常な癖＞
// and ＜ゲスト＞ paragraphs, which change between scenarios (癖の洗い替え, ゲストの増減).
//
//   NOTION_TOKEN=... node tools/fix-futari-notes.js [--write]
//
// Other paragraphs of the memo are left alone.

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
  const para = content => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content } }] } });
  for (const page of r.results) {
    const name = text(page.properties["名前"]?.title) || page.id;
    try {
      const item = await sourceItem(page.properties["元シート"]?.url || "");
      if (!item) { report.skipped.push(`${name}: 元シートにこのキャラがいません`); continue; }
      const blocks = (await notionRequest(token, `/blocks/${page.id}/children?page_size=100`)).results;
      await notionSleep(NOTION_GAP_MS);
      // The メモ paragraphs: after the "メモ" heading, up to the next heading.
      const h = blocks.findIndex(b => b.type === "heading_2" && text(b.heading_2.rich_text) === "メモ");
      const memo = [];
      for (const b of blocks.slice(h + 1)) { if (b.type.startsWith("heading")) break; if (b.type === "paragraph") memo.push(b); }
      if (h < 0 || !memo.length) { report.skipped.push(`${name}: メモがありません`); continue; }
      const ops = [], lines = [];
      // 1. The パートナー line of the profile paragraph.
      const want = (String(item.notes || "").match(/^パートナー: .*$/m) || [])[0];
      const pb = memo.find(b => /^パートナー: /m.test(text(b.paragraph.rich_text)));
      if (want && pb) {
        const cur = text(pb.paragraph.rich_text), next = cur.replace(/^パートナー: .*$/m, want);
        if (next !== cur) { lines.push(`  前: ${cur.match(/^パートナー: .*$/m)[0]}\n  後: ${want}`); ops.push(["PATCH", `/blocks/${pb.id}`, { paragraph: para(next).paragraph }]); }
      }
      // 2. The ＜異常な癖＞ and ＜ゲスト＞ paragraphs, as the sheet has them now.
      let anchor = memo[memo.length - 1].id;
      for (const head of ["＜異常な癖＞", "＜ゲスト＞"]) {
        const wantP = String(item.notes || "").split(/\n{2,}/).find(p => p.trim().startsWith(head))?.trim();
        const cb = memo.find(b => text(b.paragraph.rich_text).trim().startsWith(head));
        const cur = cb && text(cb.paragraph.rich_text).trim();
        if (wantP && cb && cur !== wantP) { lines.push(`  ${head} 前:\n${cur.replace(/^/gm, "    ")}\n  ${head} 後:\n${wantP.replace(/^/gm, "    ")}`); ops.push(["PATCH", `/blocks/${cb.id}`, { paragraph: para(wantP).paragraph }]); }
        if (wantP && !cb) { lines.push(`  ${head} 足す:\n${wantP.replace(/^/gm, "    ")}`); ops.push(["PATCH", `/blocks/${page.id}/children`, { children: [para(wantP)], after: anchor }]); }
        if (!wantP && cb) { lines.push(`  ${head} 消す:\n${cur.replace(/^/gm, "    ")}`); ops.push(["DELETE", `/blocks/${cb.id}`]); }
        if (cb) anchor = cb.id;
      }
      if (!ops.length) { report.same.push(name); continue; }
      report.changed.push(`${name}\n` + lines.join("\n"));
      if (write) for (const [method, path, body] of ops) { await notionRequest(token, path, body, method); await notionSleep(NOTION_GAP_MS); }
    } catch (e) { report.skipped.push(`${name}: ${e.message}`); }
    await notionSleep(NOTION_GAP_MS);
  }
  console.log(`\n${write ? "直した" : "直す予定の"}シート ${report.changed.length} 枚\n` + report.changed.join("\n"));
  console.log(`\nもう直っているシート ${report.same.length} 枚\n` + report.same.join("\n"));
  console.log(`\n触らなかったシート ${report.skipped.length} 枚\n` + report.skipped.join("\n"));
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
