#!/usr/bin/env node
// Fills the Notion database 「通過記録」 (one page per character and scenario) from the
// シナリオ lines of the character sheet book, linking each page to its sheet and, when it can
// tell which ones, to the 卓報告 pages of that scenario. The rules live in extension/runs.js,
// which the extension also uses for the sheets it sends.
//
//   NOTION_TOKEN=... node tools/sync-runs.js [--write] [--prune] [--pl] [--only=<name>]
//
// --pl fills PL人数 on pages where it is empty, from the PL欄 of their 卓報告 (with --write);
// it then adds no rows.
//
// Without --write it only prints what it would add. A character and scenario (and HO) already
// in 通過記録 is left alone, so it can be run again after the sheets are fixed.

const { NOTION_DEFAULT_DB, NOTION_GAP_MS, notionDbId, notionRequest, notionSleep, notionScenarioKey } = require("../extension/notion.js");
const { RUNS_SYSTEM: SYSTEM, runsSystemsAgree: systemsAgree, runsPlOf, runsLoad, runsIndex, runsLabel, runsCreate } = require("../extension/runs.js");

async function main() {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN がありません");
  const write = process.argv.includes("--write");
  // --only=<name>: add rows only for sheets whose character name contains it (one sheet just sent).
  const only = (process.argv.find(a => a.startsWith("--only=")) || "").slice(7).trim();
  const sheetDb = notionDbId(process.env.NOTION_DATABASE_ID || NOTION_DEFAULT_DB);

  const { sheets, taku, rows } = await runsLoad(token, sheetDb);
  const idx = runsIndex({ sheets, taku, rows });
  const { runs, takuOfName, existing } = idx;
  console.log(`シート ${sheets.length} 枚、卓報告 ${taku.length} 件、通過記録 ${existing.size} 件`);

  const report = { added: 0, linked: 0, noTaku: [], shared: [], crossSystem: [] };
  for (const r of runs) {
    const p = idx.plan(r);
    if (existing.has(p.key)) continue;
    if (only && !r.sheet.name.includes(only)) continue;
    existing.add(p.key);
    if (!p.all.length) report.noTaku.push(`${r.sheet.name}：${r.base}`);
    else if (!p.links.length && p.mine.length) report.shared.push(`${r.sheet.name}：${p.title}`);
    if (p.crossSystem) { report.crossSystem.push(`${r.sheet.name}（${r.sheet.system}）：${p.title}（${p.system}）`); continue; }
    report.added++; if (p.links.length) report.linked++;
    report.list = report.list || [];
    report.list.push(runsLabel(p) + (p.links.length ? "" : "（卓報告なし）"));
    // --pl only fills PL人数; it adds no rows even with --write.
    if (!write || process.argv.includes("--pl")) continue;
    await runsCreate(token, p);
    await notionSleep(NOTION_GAP_MS);
  }

  console.log(`${write ? "追加" : "追加予定"} ${report.added} 件（うち卓報告とリンク ${report.linked} 件）\n` + (report.list || []).join("\n"));

  // The rows already in 通過記録, as they stand now (after edits by hand).
  const sheetById = new Map(sheets.map(s => [s.id, s]));
  const takuById = new Map(taku.map(t => [t.id, t]));
  const label = r => `${r.chars.map(id => sheetById.get(id)?.name || "?").join("・") || "（キャラなし）"}：${r.title}${r.ho ? " " + r.ho : ""}`;
  const noChar = rows.filter(r => !r.chars.length).map(label);
  const noLink = rows.filter(r => r.chars.length && !r.taku.length).map(label);
  const wrongSys = rows.filter(r => r.chars.some(id => { return !systemsAgree(SYSTEM[sheetById.get(id)?.system], r.system); }))
    .map(r => `${label(r)}（通過記録 ${r.system} / シート ${r.chars.map(id => sheetById.get(id)?.system).join("・")}）`);
  const takuSys = rows.filter(r => r.system && r.taku.some(id => takuById.get(id) && takuById.get(id).system !== r.system))
    .map(r => `${label(r)}（通過記録 ${r.system} / 卓報告 ${[...new Set(r.taku.map(id => takuById.get(id)?.system))].join("・")}）`);
  // A row whose sheet no longer lists that scenario.
  const listed = new Set(runs.map(r => r.sheet.id + "|" + notionScenarioKey(r.base)));
  const goneRows = rows.filter(r => r.chars.length && !r.chars.some(id => listed.has(id + "|" + notionScenarioKey(r.title))) && takuOfName(r.title).every(t => !r.chars.some(id => listed.has(id + "|" + notionScenarioKey(t)))));
  const gone = goneRows.map(label);
  // --prune: a row the sheet no longer lists goes to the trash (restorable in Notion), for sheets
  // whose シナリオ欄 is washed from the source site (いあきゃら, キャラッシュ) and for エモクロア sheets,
  // which take their scenarios only from 残響 and 参加セッション. Hand-kept sheets are left alone.
  const WASHED = new Set(["いあきゃら", "キャラッシュ"]);
  if (process.argv.includes("--prune")) {
    const prune = goneRows.filter(r => r.chars.every(id => { const s = sheetById.get(id); return s && (WASHED.has(s.site) || s.system === "エモクロアTRPG"); }));
    for (const r of prune) {
      await notionRequest(token, `/pages/${r.id}`, { archived: true }, "PATCH");
      await notionSleep(NOTION_GAP_MS);
    }
    console.log(`\nゴミ箱へ移した行 ${prune.length} 件\n` + prune.map(label).join("\n"));
  }
  // --pl: PL人数 from 卓報告's PL欄, only where it is empty (a value set by hand is kept).
  if (process.argv.includes("--pl")) {
    const fill = [], differs = [];
    for (const r of rows) {
      if (r.pl || !r.taku.length) continue;
      const { label: pl, differs: d } = runsPlOf(r.taku.map(id => takuById.get(id)));
      if (!pl) continue;
      fill.push({ r, pl });
      if (d) differs.push(`${label(r)} → ${pl}（${r.taku.map(id => takuById.get(id)).filter(Boolean).map(t => `${t.date} ${t.pls}人`).join("・")}）`);
    }
    const by = {};
    for (const f of fill) by[f.pl] = (by[f.pl] || 0) + 1;
    console.log(`\nPL人数を${write ? "入れた" : "入れる予定の"}行 ${fill.length} 件（${Object.entries(by).sort().map(([k, n]) => `${k} ${n}`).join("・")}）`);
    console.log(`卓報告によって人数が違う行（いちばん新しい卓の人数にする）${differs.length} 件\n` + differs.join("\n"));
    if (process.argv.includes("--pl-list")) console.log(fill.map(f => `${label(f.r)} → ${f.pl}`).join("\n"));
    if (write) for (const f of fill) {
      await notionRequest(token, `/pages/${f.r.id}`, { properties: { "PL人数": { select: { name: f.pl } } } }, "PATCH");
      await notionSleep(NOTION_GAP_MS);
    }
    const noTakuPl = rows.filter(r => !r.pl && !r.taku.length).length;
    console.log(`卓報告がなくてPL人数を入れられない行 ${noTakuPl} 件`);
  }
  console.log(`\n=== 通過記録 ${rows.length} 件の点検 ===`);
  console.log(`\n■ キャラが空の行 ${noChar.length} 件\n` + noChar.join("\n"));
  console.log(`\n■ 卓報告が空の行 ${noLink.length} 件\n` + noLink.join("\n"));
  console.log(`\n■ キャラのシートとシステムが違う行 ${wrongSys.length} 件\n` + wrongSys.join("\n"));
  console.log(`\n■ リンクした卓報告とシステムが違う行 ${takuSys.length} 件\n` + takuSys.join("\n"));
  console.log(`\n■ シートのシナリオ欄にもう無い行 ${gone.length} 件\n` + gone.join("\n"));
  console.log(`\n■ 卓報告に見当たらないシナリオ ${report.noTaku.length} 件\n` + report.noTaku.join("\n"));
  console.log(`\n■ 複数のキャラが通っていて、どの卓か決められないもの ${report.shared.length} 件\n` + report.shared.join("\n"));
  console.log(`\n■ シートと卓報告でシステムが違うもの ${report.crossSystem.length} 件\n` + report.crossSystem.join("\n"));
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
