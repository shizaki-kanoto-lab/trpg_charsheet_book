#!/usr/bin/env node
// Fills the Notion database 「通過記録」 (one page per character and scenario) from the
// シナリオ lines of the character sheet book, linking each page to its sheet and, when it can
// tell which ones, to the 卓報告 pages of that scenario.
//
//   NOTION_TOKEN=... node tools/sync-runs.js [--write]
//
// Without --write it only prints what it would add. A character and scenario (and HO) already
// in 通過記録 is left alone, so it can be run again after the sheets are fixed.

const { NOTION_DEFAULT_DB, NOTION_GAP_MS, notionDbId, notionRequest, notionSleep, notionSplitHo, notionScenarioKey, notionSameScenario } = require("../extension/notion.js");

const RUNS_DB = "ad4ce7ad957d4f28ab6a94f427beec56";
const TAKU_DB = "1351b663c48f803db061e20fee803137";

const text = rich => (rich || []).map(t => t.plain_text ?? t.text?.content ?? "").join("");
function prop(p) {
  if (!p) return null;
  switch (p.type) {
    case "title": return text(p.title);
    case "rich_text": return text(p.rich_text);
    case "select": return p.select?.name ?? null;
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
const bare = id => String(id).replace(/-/g, "");

// The sheet's system as 卓報告 names it.
const SYSTEM = {
  "クトゥルフ神話TRPG 6版": "CoC", "クトゥルフ神話TRPG 7版": "CoC", "エモクロアTRPG": "emoklore", "Kutulu": "Kutulu",
  "ガイアケアTRPG": "gaiacare", "ダブルクロス The 3rd Edition": "dx3rd", "キズナバレット": "キズナバレット",
  "フタリソウサ": "フタリソウサ", "トーキョーN◎VA THE AXLERATION": "トーキョーNOVA",
};
const RUN_SYSTEMS = new Set(["CoC", "emoklore", "Kutulu", "gaiacare", "dx3rd", "フタリソウサ", "キズナバレット", "トーキョーNOVA", "ケダモノオペラ", "マダミス", "シノビガミ", "他システム"]);
// A sheet and a run whose systems differ but go together: ガイアケア and エモクロア share one character
// sheet, and a 「他システム」 session can be played with any sheet (both confirmed 2026-11-10).
const SAME_SHEET = [["gaiacare", "emoklore"]];
const systemsAgree = (sheetSys, runSys) => !sheetSys || !runSys || sheetSys === runSys || runSys === "他システム"
  || SAME_SHEET.some(g => g.includes(sheetSys) && g.includes(runSys));
// The same person across sheets (a CoC sheet and its エモクロア conversion).
const personKey = name => String(name || "").normalize("NFKC").replace(/[(（][^()（）]*[)）]\s*$/, "").replace(/[\s　・]+/g, "").toLowerCase();
// 卓報告's PL/GM for each 立場: a PC played as a PL, or the KP's own character.
const ROLE_OF = { PL: ["PL"], KPC: ["KP", "DL", "GM", "SKP"] };

// Scenario names the user confirmed (2026-11-10) where the sheet is right and only part matches 卓報告:
// 卓報告's session under a fuller name (TRASH1 of TRASH1 / TRASH2; 探索者：Uの証言), which keeps
// the sheet's name and still links to 卓報告. Scenarios of their own, not part of a 卓報告 name, go in OWN_SCENARIO.
const OWN_SCENARIO = new Set([].map(notionScenarioKey));
const KEEP_NAME = new Set(["TRASH1", "探索者：Uの証言"].map(notionScenarioKey));

// "シナリオ名HO2" / "シナリオ名KPC" / "シナリオ名NPC" -> { base, ho, role }
function parseLine(line) {
  let t = String(line).trim(), role = "PL";
  if (/KPC$/i.test(t)) { role = "KPC"; t = t.replace(/\s*KPC$/i, ""); }
  else if (/NPC$/.test(t)) { role = "NPC"; t = t.replace(/\s*NPC$/, ""); }
  const [base, ho] = notionSplitHo(t);
  return { base: base.trim(), ho: ho.trim(), role };
}

async function main() {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN がありません");
  const write = process.argv.includes("--write");
  const sheetDb = notionDbId(process.env.NOTION_DATABASE_ID || NOTION_DEFAULT_DB);

  const sheets = (await allPages(token, sheetDb)).map(pg => ({
    id: bare(pg.id), name: prop(pg.properties["名前"]) || "", system: prop(pg.properties["システム"]) || "",
    site: prop(pg.properties["サイト"]) || "",
    lines: String(prop(pg.properties["シナリオ"]) || "").split("\n").map(s => s.trim()).filter(Boolean),
  }));
  const taku = (await allPages(token, TAKU_DB)).map(pg => ({
    id: bare(pg.id), name: prop(pg.properties["シナリオ"]) || "", system: prop(pg.properties["システム"]) || "",
    date: prop(pg.properties["日付"]) || "", role: prop(pg.properties["PL/GM"]) || "",
  })).filter(r => r.name);
  const rows = (await allPages(token, RUNS_DB)).map(pg => {
    const p = pg.properties;
    return { id: bare(pg.id), chars: prop(p["キャラ"]) || [], title: prop(p["シナリオ"]) || "", ho: prop(p["HO"]) || "",
      system: prop(p["システム"]) || "", taku: prop(p["卓報告"]) || [], role: prop(p["立場"]) || "" };
  });
  const existing = new Set(rows.map(r => `${r.chars[0]}|${notionScenarioKey(r.title)}|${notionScenarioKey(r.ho)}`));
  console.log(`シート ${sheets.length} 枚、卓報告 ${taku.length} 件、通過記録 ${existing.size} 件`);

  // Who has each scenario (and 立場): only a scenario one person played can be tied to its 卓報告 pages.
  const runs = [];
  for (const s of sheets) for (const line of s.lines) runs.push({ sheet: s, ...parseLine(line) });
  // A sheet line that only partly matches a 卓報告 name takes that name: "Paranormal Crime Episode 1：…"
  // and "TRASH1" are 卓報告's "Paranormal Crime" and "TRASH", "公演型まれびとこぞりて" is "まれびとこぞりて",
  // and "ヤドリギあやかし探偵社" is its episodes when only one of them fits. The rest after
  // the 卓報告 name becomes the HO when it is one ("トナリ美術館の5つの問PC3" -> PC3).
  const takuOf = r => {
    const same = taku.filter(t => notionSameScenario(t.name, r.base));
    if (same.length) return same;
    const k = notionScenarioKey(r.base);
    if (OWN_SCENARIO.has(k)) return [];
    const part = taku.filter(t => { const tk = notionScenarioKey(t.name); return tk.length >= 4 && (k.includes(tk) || tk.includes(k) && k.length >= 4); });
    const names = [...new Set(part.map(t => notionScenarioKey(t.name)))];
    if (names.length !== 1) return [];
    const rest = r.base.normalize("NFKC").slice(r.base.normalize("NFKC").indexOf(part[0].name.normalize("NFKC").trim()) + part[0].name.normalize("NFKC").trim().length).trim();
    if (!r.ho && /^(PC|HO)\S{1,8}$/i.test(rest)) r.ho = rest;
    return part;
  };
  // The sheet-side names a 通過記録 title can stand for (itself, or the sheet lines that took this 卓報告 name).
  const basesOf = new Map();   // 卓報告 name key -> the sheet names that took it
  for (const base of new Set(runs.map(r => r.base))) {
    const t = takuOf({ base, ho: "" });
    if (!t.length) continue;
    const k = notionScenarioKey(t[0].name);
    if (!basesOf.has(k)) basesOf.set(k, []);
    basesOf.get(k).push(base);
  }
  const takuOfName = title => basesOf.get(notionScenarioKey(title)) || [];
  const playersOf = new Map();
  for (const r of runs) {
    const k = r.role + "|" + notionScenarioKey(r.base);
    if (!playersOf.has(k)) playersOf.set(k, new Set());
    playersOf.get(k).add(personKey(r.sheet.name));
  }

  const report = { added: 0, linked: 0, noTaku: [], shared: [], crossSystem: [] };
  for (const r of runs) {
    const all = takuOf(r);
    const title = all.length && !KEEP_NAME.has(notionScenarioKey(r.base)) ? all[0].name : r.base;
    const key = `${r.sheet.id}|${notionScenarioKey(title)}|${notionScenarioKey(r.ho)}`;
    if (existing.has(key)) continue;
    existing.add(key);
    const mine = all.filter(t => !ROLE_OF[r.role] || ROLE_OF[r.role].includes(t.role));
    const alone = playersOf.get(r.role + "|" + notionScenarioKey(r.base)).size === 1;
    const links = alone ? mine : [];
    const system = links[0]?.system || all[0]?.system || SYSTEM[r.sheet.system] || "";
    if (!all.length) report.noTaku.push(`${r.sheet.name}：${r.base}`);
    else if (!links.length && mine.length) report.shared.push(`${r.sheet.name}：${title}`);
    if (all.length && !systemsAgree(SYSTEM[r.sheet.system], system)) report.crossSystem.push(`${r.sheet.name}（${r.sheet.system}）：${title}（${system}）`);
    report.added++; if (links.length) report.linked++;
    report.list = report.list || [];
    report.list.push(`${r.sheet.name}（${r.sheet.system}）：${title}${r.ho ? " " + r.ho : ""}${r.role !== "PL" ? " " + r.role : ""}${links.length ? "" : "（卓報告なし）"}`);
    if (!write) continue;
    await notionRequest(token, "/pages", {
      parent: { database_id: RUNS_DB },
      properties: {
        "シナリオ": { title: [{ text: { content: title } }] },
        "キャラ": { relation: [{ id: r.sheet.id }] },
        "卓報告": { relation: links.slice(0, 100).map(t => ({ id: t.id })) },
        ...(RUN_SYSTEMS.has(system) ? { "システム": { select: { name: system } } } : {}),
        "HO": { rich_text: r.ho ? [{ text: { content: r.ho } }] : [] },
        "立場": { select: { name: r.role } },
      },
    });
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
