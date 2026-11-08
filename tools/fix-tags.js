#!/usr/bin/env node
// Fixes tags in the Notion database: joins scenario names that were split at spaces
// and renames misspelt tags. The rules are in a JSON file such as tools/tag-fixes.json:
//   {"join": [["All", "or", "Nothing"], ...], "rename": {"old": "new", ...}}
// "join" replaces the consecutive tags with one tag, the parts separated by a space.
//
//   node tools/fix-tags.js tools/tag-fixes.json [--dry-run]
//
// It asks for the Notion token when it starts. NOTION_DATABASE_ID overrides the database.

const fs = require("fs");
const readline = require("readline");
const { NOTION_DEFAULT_DB, NOTION_GAP_MS, notionDbId, notionRequest, notionSleep } = require("../extension/notion.js");

function askHidden(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = () => {};
    process.stdout.write(question + "\n");
    rl.question("", answer => { resolve(answer.trim()); rl.close(); });
    rl.on("close", () => resolve(""));
  });
}

function fixTags(tags, rules) {
  let t = [...tags];
  for (const parts of rules.join || []) {
    for (let i = t.indexOf(parts[0]); i >= 0; i = t.indexOf(parts[0], i + 1)) {
      if (parts.every((p, k) => t[i + k] === p)) t.splice(i, parts.length, parts.join(" "));
    }
  }
  t = t.map(x => (rules.rename || {})[x] || x);
  return [...new Set(t)];
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const file = args.find(a => !a.startsWith("--"));
  if (!file) { console.error("使い方: node tools/fix-tags.js <rules.json> [--dry-run]"); process.exit(2); }
  const rules = JSON.parse(fs.readFileSync(file, "utf8"));

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

  const changes = [];
  for (const page of pages) {
    const tags = (page.properties["タグ"]?.multi_select || []).map(o => o.name);
    const fixed = fixTags(tags, rules);
    if (JSON.stringify(fixed) !== JSON.stringify(tags)) {
      const name = (page.properties["名前"]?.title || []).map(t => t.plain_text).join("");
      changes.push({ page, name, tags, fixed });
    }
  }
  console.log(`${pages.length}枚のうち ${changes.length}枚のタグを直します${dryRun ? "（--dry-run のため書き込みません）" : ""}`);
  for (const c of changes) console.log(`  ${c.name}: ${c.tags.join(", ")}\n    → ${c.fixed.join(", ")}`);
  if (dryRun) return;

  let failed = 0;
  for (const c of changes) {
    try {
      await notionRequest(token, `/pages/${c.page.id}`, { properties: { "タグ": { multi_select: c.fixed.map(name => ({ name })) } } }, "PATCH");
    } catch (e) {
      failed++;
      console.log(`  失敗: ${c.name}: ${e.message}`);
      if (e.fatal) break;
    }
    await notionSleep(NOTION_GAP_MS);
  }
  console.log(`直した ${changes.length - failed}枚・失敗 ${failed}枚`);
  if (failed) process.exit(1);
}

main().catch(e => { console.error(e.message); process.exit(1); });
