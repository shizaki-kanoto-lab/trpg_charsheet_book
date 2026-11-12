#!/usr/bin/env node
// Trims the メモ of vinsanet sheets in the character sheet book to the first メモ欄 of the sheet
// (the character), as extension/vinsanet.js now reads it. The later メモ欄 are usually scenario
// recruiting posts. Each sheet is read again from vinsanet's public API.
//
//   NOTION_TOKEN=... node tools/fix-vinsanet-notes.js [--write]
//
// Only a page whose メモ paragraphs start with exactly the new memo is changed, by removing the
// paragraphs after it; a memo edited by hand in Notion is only reported.

const { NOTION_DEFAULT_DB, NOTION_GAP_MS, notionDbId, notionRequest, notionSleep } = require("../extension/notion.js");
const { vinsanetToItem } = require("../extension/vinsanet.js");

const text = rich => (rich || []).map(t => t.plain_text ?? t.text?.content ?? "").join("");
// The 「ルール:」 line was added to the profile later; older pages don't have it, which is not a hand edit.
const paras = s => String(s || "").split(/\n{2,}/).map(p => p.trim().replace(/^ルール: .*\n/, "")).filter(Boolean);

async function children(token, id) {
  const out = [];
  let cursor;
  do {
    const r = await notionRequest(token, `/blocks/${id}/children?page_size=100${cursor ? "&start_cursor=" + cursor : ""}`);
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
    await notionSleep(NOTION_GAP_MS);
  } while (cursor);
  return out;
}

async function main() {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN がありません");
  const write = process.argv.includes("--write");
  const db = notionDbId(process.env.NOTION_DATABASE_ID || NOTION_DEFAULT_DB);

  const pages = [];
  let cursor;
  do {
    const r = await notionRequest(token, `/databases/${db}/query`, {
      page_size: 100, filter: { property: "サイト", select: { equals: "vinsanet" } }, ...(cursor ? { start_cursor: cursor } : {}),
    });
    pages.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
    await notionSleep(NOTION_GAP_MS);
  } while (cursor);
  console.log(`vinsanet のシート ${pages.length} 枚`);

  const report = { trimmed: [], same: [], manual: [], failed: [] };
  for (const page of pages) {
    const name = text(page.properties["名前"]?.title) || page.id;
    const url = page.properties["元シート"]?.url || "";
    const id = (url.match(/\/characters\/([A-Za-z0-9_-]{21})/) || [])[1];
    try {
      if (!id) throw new Error("元シートのURLがありません");
      const r = await fetch(`https://vinsanet.com/api/v1/characters/${id}`);
      if (!r.ok) throw new Error(`vinsanet ${r.status}`);
      const want = paras(vinsanetToItem({ id, data: await r.json() }).notes);
      const blocks = await children(token, page.id);
      const h = blocks.findIndex(b => b.type.startsWith("heading_") && text(b[b.type].rich_text).trim() === "メモ");
      if (h < 0) throw new Error("メモの見出しがありません");
      const memo = [];
      for (const b of blocks.slice(h + 1)) { if (b.type.startsWith("heading_")) break; if (b.type === "paragraph") memo.push(b); }
      const cur = memo.map(b => text(b.paragraph.rich_text).trim());
      if (cur.length === want.length && cur.every((p, i) => p === want[i])) { report.same.push(name); continue; }
      if (cur.length < want.length || !want.every((p, i) => cur[i] === p)) { report.manual.push(name); continue; }
      const extra = memo.slice(want.length);
      report.trimmed.push(`${name}（${extra.length} 段落を消す：${cur.slice(want.length).join(" ").replace(/\s+/g, " ").slice(0, 40)}…）`);
      if (!write) continue;
      for (const b of extra) { await notionRequest(token, `/blocks/${b.id}`, undefined, "DELETE"); await notionSleep(NOTION_GAP_MS); }
    } catch (e) { report.failed.push(`${name}: ${e.message}`); }
    await notionSleep(NOTION_GAP_MS);
  }
  console.log(`\n${write ? "メモを最初の1つにした" : "メモを最初の1つにする予定の"}シート ${report.trimmed.length} 枚\n` + report.trimmed.join("\n"));
  console.log(`\nもう最初の1つだけのシート ${report.same.length} 枚`);
  console.log(`\nNotionで手を入れたらしく、触らなかったシート ${report.manual.length} 枚\n` + report.manual.join("\n"));
  console.log(`\n読めなかったシート ${report.failed.length} 枚\n` + report.failed.join("\n"));
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
