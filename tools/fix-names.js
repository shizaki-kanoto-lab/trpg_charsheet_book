#!/usr/bin/env node
// Tidies 名前 and ふりがな of every page in the character sheet book by notionNameRuby (extension/notion.js):
// a reading in brackets after the name moves to ふりがな, an English name in brackets becomes the name with
// the katakana as ふりがな, and full-width spaces become half-width ones.
//
//   NOTION_TOKEN=... node tools/fix-names.js [--write]

const { NOTION_DEFAULT_DB, NOTION_GAP_MS, notionDbId, notionNameRuby, notionRequest, notionSleep } = require("../extension/notion.js");

const text = rich => (rich || []).map(t => t.plain_text ?? t.text?.content ?? "").join("");
const rich = s => s ? [{ type: "text", text: { content: s } }] : [];

async function main() {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN がありません");
  const write = process.argv.includes("--write");
  const db = notionDbId(process.env.NOTION_DATABASE_ID || NOTION_DEFAULT_DB);
  const pages = [];
  let cursor;
  do {
    const r = await notionRequest(token, `/databases/${db}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    pages.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
    await notionSleep(NOTION_GAP_MS);
  } while (cursor);

  const changes = [];
  for (const pg of pages) {
    const name = text(pg.properties["名前"]?.title), ruby = text(pg.properties["ふりがな"]?.rich_text);
    const next = notionNameRuby(name, ruby);
    if (next.name === name && next.ruby === ruby) continue;
    const site = pg.properties["サイト"]?.select?.name || "", sys = pg.properties["システム"]?.select?.name || "";
    changes.push(`${site}（${sys}） ${name} / ${ruby || "（空）"} → ${next.name} / ${next.ruby || "（空）"}`);
    if (write) {
      await notionRequest(token, `/pages/${pg.id}`, { properties: { "名前": { title: rich(next.name) }, "ふりがな": { rich_text: rich(next.ruby) } } }, "PATCH");
      await notionSleep(NOTION_GAP_MS);
    }
  }
  console.log(`${write ? "直した" : "直す予定の"}ページ ${changes.length} 件（全 ${pages.length} 件中）\n` + changes.sort().join("\n"));
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
