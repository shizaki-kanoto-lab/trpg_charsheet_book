#!/usr/bin/env node
// Copies an export of the old sheet book (one JSON file per character) into the Notion database.
// Sheets already in Notion are skipped, so it can be run again after an interruption.
//
//   node tools/migrate-to-notion.js <folder> [--limit N] [--dry-run]
//
// It asks for the Notion token when it starts. NOTION_DATABASE_ID overrides the database.

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { NOTION_DEFAULT_DB, notionDbId, notionRecordFromDoc, notionProperties, notionBlocks, notionAddNew } = require("../extension/notion.js");

function askHidden(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = () => {};
    process.stdout.write(question + "\n");   // on its own line: readline clears the line it starts on
    rl.question("", answer => { resolve(answer.trim()); rl.close(); });
    rl.on("close", () => resolve(""));   // Ctrl-C or Ctrl-D: report it instead of exiting silently
  });
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitAt = args.indexOf("--limit");
  const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : Infinity;
  const folder = args.find((a, i) => !a.startsWith("--") && (limitAt < 0 || i !== limitAt + 1));
  if (!folder) { console.error("使い方: node tools/migrate-to-notion.js <folder> [--limit N] [--dry-run]"); process.exit(2); }

  const files = fs.readdirSync(folder).filter(f => f.endsWith(".json")).sort();
  const records = files.map(f => notionRecordFromDoc(JSON.parse(fs.readFileSync(path.join(folder, f), "utf8"))))
    .sort((a, b) => a.url.localeCompare(b.url)).slice(0, limit);

  if (dryRun) {
    let maxBlocks = 0;
    for (const r of records) { notionProperties(r); maxBlocks = Math.max(maxBlocks, notionBlocks(r).length); }
    console.log(`${records.length}枚を確認しました（1枚あたり最大${maxBlocks}ブロック）。Notionには書き込んでいません。`);
    return;
  }

  const token = process.env.NOTION_TOKEN || await askHidden("Notionのトークンを貼り付けて Enter を押してください（入力は表示されません）");
  if (!token) { console.error("トークンが入力されませんでした。"); process.exit(2); }
  const db = notionDbId(process.env.NOTION_DATABASE_ID) || NOTION_DEFAULT_DB;

  const r = await notionAddNew(token, db, records, (done, total) => process.stdout.write(`\r${done} / ${total} 枚を保存しました`));
  process.stdout.write("\n");
  console.log(`追加 ${r.added}枚・追加済みのためスキップ ${r.skipped}枚・失敗 ${r.failed.length}枚`);
  for (const f of r.failed) console.log(`  失敗: ${f.name} (${f.url}): ${f.message}`);
  if (r.stopped) { console.error(r.stopped); process.exit(1); }
  if (r.failed.length) process.exit(1);
}

main().catch(e => { console.error(e.message); process.exit(1); });
