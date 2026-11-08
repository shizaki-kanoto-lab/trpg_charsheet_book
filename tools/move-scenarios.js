#!/usr/bin/env node
// Moves scenario names and HO out of the タグ multi-select into the シナリオ text (one per line),
// leaving only the edition and similar marks (NOTION_META_TAG) as タグ. Run it once after adding
// the シナリオ (text) property; the extension writes new sheets this way already.
//
//   node tools/move-scenarios.js [--dry-run]
//
// It asks for the Notion token when it starts. NOTION_DATABASE_ID overrides the database.

const readline = require("readline");
const { NOTION_DEFAULT_DB, NOTION_GAP_MS, NOTION_META_TAG, notionCleanTag, notionDbId, notionRequest, notionSleep } = require("../extension/notion.js");

function askHidden(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = () => {};
    process.stdout.write(question + "\n");
    rl.question("", answer => { resolve(answer.trim()); rl.close(); });
    rl.on("close", () => resolve(""));
  });
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
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
  if (pages.length && !("シナリオ" in pages[0].properties)) {
    console.error("データベースに「シナリオ」（テキスト）のプロパティがありません。先に追加してください。"); process.exit(2);
  }

  const changes = [];
  for (const page of pages) {
    const tags = (page.properties["タグ"]?.multi_select || []).map(o => o.name);
    const moving = tags.filter(t => !NOTION_META_TAG.test(t));
    if (!moving.length) continue;
    const have = (page.properties["シナリオ"]?.rich_text || []).map(t => t.plain_text).join("").split("\n").map(s => s.trim()).filter(Boolean);
    const lines = [...new Set([...have, ...moving.map(notionCleanTag)])];
    const name = (page.properties["名前"]?.title || []).map(t => t.plain_text).join("");
    changes.push({ page, name, keep: tags.filter(t => NOTION_META_TAG.test(t)), lines });
  }
  console.log(`${pages.length}枚のうち ${changes.length}枚のシナリオ名をタグから「シナリオ」へ移します${dryRun ? "（--dry-run のため書き込みません）" : ""}`);
  for (const c of changes.slice(0, 10)) console.log(`  ${c.name}: タグ [${c.keep.join(", ")}] / シナリオ ${c.lines.join(" | ")}`);
  if (changes.length > 10) console.log(`  …ほか ${changes.length - 10}枚`);
  if (dryRun) return;

  let failed = 0, done = 0;
  for (const c of changes) {
    const content = c.lines.join("\n");
    try {
      await notionRequest(token, `/pages/${c.page.id}`, { properties: {
        "シナリオ": { rich_text: [{ type: "text", text: { content: content.slice(0, 2000) } }] },
        "タグ": { multi_select: c.keep.map(name => ({ name })) },
      } }, "PATCH");
      done++;
      if (done % 20 === 0) console.log(`  ${done} / ${changes.length}`);
    } catch (e) {
      failed++;
      console.log(`  失敗: ${c.name}: ${e.message}`);
      if (e.fatal) break;
    }
    await notionSleep(NOTION_GAP_MS);
  }
  console.log(`移した ${done}枚・失敗 ${failed}枚`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
