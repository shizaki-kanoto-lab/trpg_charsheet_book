// The Notion database 「通過記録」: one page per character and scenario, linked to its sheet in the
// character sheet book and, when it can tell which ones, to the 卓報告 pages of that scenario.
// Shared by the extension (rows for the sheets just sent) and tools/sync-runs.js (all sheets, checks).
// Needs notion.js loaded first (a <script> before this one, or require in Node).

if (typeof module !== "undefined" && typeof notionRequest === "undefined") {
  // Node: bring notion.js's helpers into this file's scope.
  // eslint-disable-next-line no-global-assign
  ({ NOTION_GAP_MS, notionRequest, notionSleep, notionSplitHo, notionScenarioKey, notionSameScenario } = require("./notion.js"));
}

const RUNS_DB = "ad4ce7ad957d4f28ab6a94f427beec56";
const TAKU_DB = "1351b663c48f803db061e20fee803137";

// The sheet's system as 卓報告 names it.
const RUNS_SYSTEM = {
  "クトゥルフ神話TRPG 6版": "CoC", "クトゥルフ神話TRPG 7版": "CoC", "エモクロアTRPG": "emoklore", "Kutulu": "Kutulu",
  "ガイアケアTRPG": "gaiacare", "ダブルクロス The 3rd Edition": "dx3rd", "キズナバレット": "キズナバレット",
  "フタリソウサ": "フタリソウサ", "トーキョーN◎VA THE AXLERATION": "トーキョーNOVA",
};
const RUN_SYSTEMS = new Set(["CoC", "emoklore", "Kutulu", "gaiacare", "dx3rd", "フタリソウサ", "キズナバレット", "トーキョーNOVA", "ケダモノオペラ", "マダミス", "シノビガミ", "他システム"]);
// A sheet and a run whose systems differ but go together: ガイアケア and エモクロア share one character
// sheet, and a 「他システム」 session can be played with any sheet (both confirmed 2026-11-10).
const RUNS_SAME_SHEET = [["gaiacare", "emoklore"]];
const runsSystemsAgree = (sheetSys, runSys) => !sheetSys || !runSys || sheetSys === runSys || runSys === "他システム"
  || RUNS_SAME_SHEET.some(g => g.includes(sheetSys) && g.includes(runSys));
// The same person across sheets (a CoC sheet and its エモクロア conversion).
const runsPersonKey = name => String(name || "").normalize("NFKC").replace(/[(（][^()（）]*[)）]\s*$/, "").replace(/[\s　・]+/g, "").toLowerCase();
// 卓報告's PL/GM for each 立場: a PC played as a PL, or the KP's own character.
// GMレス (KPレス, 技能成長シナリオ): no 卓報告 at all.
const RUNS_ROLE_OF = { PL: ["PL"], KPC: ["KP", "DL", "GM", "SKP"], "GMレス": [] };

// Scenario names the user confirmed (2026-11-10) where the sheet is right and only part matches 卓報告:
// 卓報告's session under a fuller name (TRASH1 of TRASH1 / TRASH2; 探索者：Uの証言), which keeps
// the sheet's name and still links to 卓報告. Scenarios of their own, not part of a 卓報告 name, go in OWN_SCENARIO.
const RUNS_OWN_SCENARIO = new Set([].map(t => notionScenarioKey(t)));
const RUNS_KEEP_NAME = new Set(["TRASH1", "探索者：Uの証言"].map(t => notionScenarioKey(t)));

const runsText = rich => (rich || []).map(t => t.plain_text ?? t.text?.content ?? "").join("");
function runsProp(p) {
  if (!p) return null;
  switch (p.type) {
    case "title": return runsText(p.title);
    case "rich_text": return runsText(p.rich_text);
    case "select": return p.select?.name ?? null;
    case "relation": return p.relation.map(r => r.id.replace(/-/g, ""));
    case "date": return p.date?.start ?? null;
    case "url": return p.url ?? null;
    default: return null;
  }
}
async function runsAllPages(token, db) {
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
// 卓報告's PL欄 lists the players' names split by 「、」 ("ずし、しざき" = 2).
const runsPlCount = text => String(text || "").split(/[、，,]/).map(s => s.trim()).filter(Boolean).length;
const runsPlLabel = n => n >= 5 ? "5PL以上" : n >= 1 ? `${n}PL` : "";
// The PL人数 of a 通過記録 page from its 卓報告 pages: the latest session's count (an earlier table
// of the same scenario may have stopped part way, as 台風の目 did). differs: the sessions disagree.
function runsPlOf(takuPages) {
  const ps = takuPages.filter(t => t && t.pls);
  if (!ps.length) return { label: "", differs: false };
  const latest = [...ps].sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  return { label: runsPlLabel(latest.pls), differs: new Set(ps.map(t => runsPlLabel(t.pls))).size > 1 };
}
const runsBare = id => String(id).replace(/-/g, "");

// A scenario told in episodes, one session each: the series name the 通過記録's シリーズ欄 gets, so the
// sheet book shows them as one ("ヤドリギあやかし探偵社 第一話 〈春〉…", "Paranormal Crime Episode 1：…",
// "奇々怪々同好会 Chapter1「心霊プリ」"). "" for anything else. The column can be changed by hand.
const RUNS_EPISODE = /^(.+?)[\s\u3000]*(?:(?:Episode|EP\.?|Chapter|Case|File)[\s\u3000]*[0-9０-９]+|第[0-9０-９一二三四五六七八九十]+[話章幕夜])/i;
function runsSeriesOf(title) {
  const m = String(title || "").trim().match(RUNS_EPISODE);
  return m && m[1].trim().length >= 2 ? m[1].trim() : "";
}

// "シナリオ名HO2" / "シナリオ名KPC" / "シナリオ名NPC" / "シナリオ名KPレス" -> { base, ho, role }
function runsParseLine(line) {
  let t = String(line).trim(), role = "PL";
  if (/(?:[KG]P|GM)レス$/i.test(t)) { role = "GMレス"; t = t.replace(/\s*(?:[KG]P|GM)レス$/i, ""); }
  else if (/KPC$/i.test(t)) { role = "KPC"; t = t.replace(/\s*KPC$/i, ""); }
  else if (/NPC$/.test(t)) { role = "NPC"; t = t.replace(/\s*NPC$/, ""); }
  const [base, ho] = notionSplitHo(t);
  return { base: base.trim(), ho: ho.trim(), role };
}

// The sheet book, 卓報告 and 通過記録 as they stand in Notion.
async function runsLoad(token, sheetDb) {
  const sheets = (await runsAllPages(token, sheetDb)).map(pg => ({
    id: runsBare(pg.id), name: runsProp(pg.properties["名前"]) || "", system: runsProp(pg.properties["システム"]) || "",
    site: runsProp(pg.properties["サイト"]) || "", url: runsProp(pg.properties["元シート"]) || "",
    lines: String(runsProp(pg.properties["シナリオ"]) || "").split("\n").map(s => s.trim()).filter(Boolean),
  }));
  const taku = (await runsAllPages(token, TAKU_DB)).map(pg => ({
    id: runsBare(pg.id), name: runsProp(pg.properties["シナリオ"]) || "", system: runsProp(pg.properties["システム"]) || "",
    date: runsProp(pg.properties["日付"]) || "", role: runsProp(pg.properties["PL/GM"]) || "",
    pls: runsPlCount(runsProp(pg.properties["PL"])), plText: String(runsProp(pg.properties["PL"]) || ""),
  })).filter(r => r.name);
  const rows = (await runsAllPages(token, RUNS_DB)).map(pg => {
    const p = pg.properties;
    return { id: runsBare(pg.id), chars: runsProp(p["キャラ"]) || [], title: runsProp(p["シナリオ"]) || "", ho: runsProp(p["HO"]) || "",
      system: runsProp(p["システム"]) || "", taku: runsProp(p["卓報告"]) || [], role: runsProp(p["立場"]) || "",
      pl: runsProp(p["PL人数"]) || "", series: runsProp(p["シリーズ"]) || "" };
  });
  return { sheets, taku, rows };
}

// Every sheet line with its 卓報告 pages, and the 通過記録 page it would make. soloOf: 元シート URL ->
// the scenarios that sheet played without a KP (the source sheet says so; the sheet book keeps only the name).
function runsIndex({ sheets, taku, rows }, soloOf = {}) {
  const runs = [];
  for (const s of sheets) for (const line of s.lines) {
    const r = runsParseLine(line);
    if (r.role === "PL" && (soloOf[s.url] || []).some(x => notionSameScenario(x, line))) r.role = "GMレス";
    runs.push({ sheet: s, line, ...r });
  }
  // A sheet line that only partly matches a 卓報告 name takes that name: "Paranormal Crime Episode 1：…"
  // and "TRASH1" are 卓報告's "Paranormal Crime" and "TRASH", "公演型まれびとこぞりて" is "まれびとこぞりて",
  // and "ヤドリギあやかし探偵社" is its episodes when only one of them fits. The rest after
  // the 卓報告 name becomes the HO when it is one ("トナリ美術館の5つの問PC3" -> PC3).
  const takuOf = r => {
    const same = taku.filter(t => notionSameScenario(t.name, r.base));
    if (same.length) return same;
    const k = notionScenarioKey(r.base);
    if (RUNS_OWN_SCENARIO.has(k)) return [];
    const part = taku.filter(t => { const tk = notionScenarioKey(t.name); return tk.length >= 4 && (k.includes(tk) || tk.includes(k) && k.length >= 4); });
    const names = [...new Set(part.map(t => notionScenarioKey(t.name)))];
    if (names.length !== 1) return [];
    const rest = r.base.normalize("NFKC").slice(r.base.normalize("NFKC").indexOf(part[0].name.normalize("NFKC").trim()) + part[0].name.normalize("NFKC").trim().length).trim();
    if (!r.ho && /^(PC|HO)\S{1,8}$/i.test(rest)) r.ho = rest;
    return part;
  };
  // The sheet-side names a 通過記録 title can stand for (itself, or the sheet lines that took this 卓報告 name).
  const basesOf = new Map();
  for (const base of new Set(runs.map(r => r.base))) {
    const t = takuOf({ base, ho: "" });
    if (!t.length) continue;
    const k = notionScenarioKey(t[0].name);
    if (!basesOf.has(k)) basesOf.set(k, []);
    basesOf.get(k).push(base);
  }
  // Who has each scenario (and 立場): only a scenario one person played can be tied to its 卓報告 pages.
  const playersOf = new Map();
  for (const r of runs) {
    const k = r.role + "|" + notionScenarioKey(r.base);
    if (!playersOf.has(k)) playersOf.set(k, new Set());
    playersOf.get(k).add(runsPersonKey(r.sheet.name));
  }
  const existing = new Set(rows.map(r => `${r.chars[0]}|${notionScenarioKey(r.title)}|${notionScenarioKey(r.ho)}`));
  // One sheet line -> the page it makes: its title (卓報告's name), 卓報告 links and system.
  const plan = r => {
    const all = takuOf(r);
    // An episode keeps its own name even when 卓報告 has the series' name only (Paranormal Crime, three
    // episodes in one session): one 通過記録 page per episode, tied together by シリーズ.
    const series = runsSeriesOf(r.base);
    const episode = series && all.length && !notionSameScenario(all[0].name, r.base);
    const title = all.length && r.role !== "GMレス" && !episode && !RUNS_KEEP_NAME.has(notionScenarioKey(r.base)) ? all[0].name : r.base;
    const key = `${r.sheet.id}|${notionScenarioKey(title)}|${notionScenarioKey(r.ho)}`;
    const mine = all.filter(t => !RUNS_ROLE_OF[r.role] || RUNS_ROLE_OF[r.role].includes(t.role));
    const alone = playersOf.get(r.role + "|" + notionScenarioKey(r.base)).size === 1;
    const links = alone ? mine : [];
    const system = links[0]?.system || all[0]?.system || RUNS_SYSTEM[r.sheet.system] || "";
    // A line whose 卓報告 is in another system (an エモクロア session copied onto the CoC original)
    // makes no page: the run belongs on the sheet of the system it was played in.
    const crossSystem = all.length > 0 && !runsSystemsAgree(RUNS_SYSTEM[r.sheet.system], system);
    return { ...r, all, title, key, mine, links, system, crossSystem, series: runsSeriesOf(title), exists: existing.has(key) };
  };
  return { runs, takuOf, basesOf, takuOfName: title => basesOf.get(notionScenarioKey(title)) || [], plan, existing };
}

const runsLabel = p => `${p.sheet.name}（${p.sheet.system}）：${p.title}${p.ho ? " " + p.ho : ""}${p.role !== "PL" ? " " + p.role : ""}`;

async function runsCreate(token, p) {
  await notionRequest(token, "/pages", {
    parent: { database_id: RUNS_DB },
    properties: {
      "シナリオ": { title: [{ text: { content: p.title } }] },
      "キャラ": { relation: [{ id: p.sheet.id }] },
      "卓報告": { relation: p.links.slice(0, 100).map(t => ({ id: t.id })) },
      ...(RUN_SYSTEMS.has(p.system) ? { "システム": { select: { name: p.system } } } : {}),
      "HO": { rich_text: p.ho ? [{ text: { content: p.ho } }] : [] },
      ...(p.series ? { "シリーズ": { select: { name: p.series } } } : {}),
      "立場": { select: { name: p.role } },
      ...(p.role === "GMレス" ? { "PL人数": { select: { name: "1PL" } } }
        : runsPlOf(p.links).label ? { "PL人数": { select: { name: runsPlOf(p.links).label } } } : {}),
    },
  });
}

// The extension, after sending sheets to the sheet book: adds the 通過記録 pages of those sheets
// (by 元シート URL) that tie to 卓報告, and those the source sheet marks as played without a KP (立場
// GMレス, 1PL). Another line with no 卓報告 to link is only reported, so rows deleted by hand (no 卓報告
// for them) are not made again.
async function runsAddForSheets(token, sheetDb, urls, soloOf = {}) {
  const want = new Set(urls.filter(Boolean));
  const data = await runsLoad(token, sheetDb);
  const idx = runsIndex(data, soloOf);
  const result = { added: [], unlinked: [] };
  for (const r of idx.runs) {
    if (!want.has(r.sheet.url)) continue;
    const p = idx.plan(r);
    if (p.exists || idx.existing.has(p.key) || p.crossSystem) continue;
    if (!p.links.length && p.role !== "GMレス") { result.unlinked.push(runsLabel(p)); continue; }
    idx.existing.add(p.key);
    await runsCreate(token, p);
    result.added.push(runsLabel(p));
    await notionSleep(NOTION_GAP_MS);
  }
  return result;
}

// 取り直し: look again at the 通過記録 pages already made for these sheets (urls; null = every
// sheet) and bring them up to date with the sheet book and 卓報告 as they stand now. Only fills in or
// moves forward, so what was set by hand stays:
//   卓報告  only when empty: the 卓報告 pages it ties to now, when it can tell (links narrowed or
//          chosen by hand, one session of several, stay as they are)
//   立場    KPC / NPC / GMレス when the sheet says so (a bare line says nothing: PL never replaces)
//   PL人数  1PL for GMレス, else from the 卓報告 when those changed or it is empty
//   HO・システム・シリーズ  only when empty
// Returns the changes ({ id, label, props, what }) without writing; runsApplyRefresh writes them.
async function runsPlanRefresh(token, sheetDb, urls, soloOf = {}) {
  const want = urls ? new Set(urls.filter(Boolean)) : null;
  const data = await runsLoad(token, sheetDb);
  const idx = runsIndex(data, soloOf);
  const takuById = new Map(data.taku.map(t => [t.id, t]));
  const rowOf = new Map(data.rows.map(r => [`${r.chars[0]}|${notionScenarioKey(r.title)}|${notionScenarioKey(r.ho)}`, r]));
  const out = [], seen = new Set();
  for (const r of idx.runs) {
    if (want && !want.has(r.sheet.url)) continue;
    const p = idx.plan(r);
    const row = rowOf.get(p.key);
    if (!row || seen.has(row.id) || p.crossSystem) continue;
    seen.add(row.id);
    const props = {}, what = [];
    const name = id => { const t = takuById.get(id); return t ? `${t.date || "日付なし"}` : "?"; };
    let taku = row.taku;
    const links = p.links.slice(0, 100).map(t => t.id);
    if (links.length && !row.taku.length) {
      props["卓報告"] = { relation: links.map(id => ({ id })) };
      what.push(`卓報告: （空） → ${links.map(name).join("・")}`);
      taku = links;
    }
    if (p.role !== "PL" && p.role !== row.role) {
      props["立場"] = { select: { name: p.role } };
      what.push(`立場: ${row.role || "（空）"} → ${p.role}`);
    }
    const role = props["立場"] ? p.role : row.role;
    const pl = role === "GMレス" ? "1PL" : (taku !== row.taku || !row.pl) ? runsPlOf(taku.map(id => takuById.get(id))).label : "";
    if (pl && pl !== row.pl) { props["PL人数"] = { select: { name: pl } }; what.push(`PL人数: ${row.pl || "（空）"} → ${pl}`); }
    if (!row.ho && p.ho) { props["HO"] = { rich_text: [{ text: { content: p.ho } }] }; what.push(`HO: （空） → ${p.ho}`); }
    if (!row.system && RUN_SYSTEMS.has(p.system)) { props["システム"] = { select: { name: p.system } }; what.push(`システム: （空） → ${p.system}`); }
    if (!row.series && p.series) { props["シリーズ"] = { select: { name: p.series } }; what.push(`シリーズ: （空） → ${p.series}`); }
    if (what.length) out.push({ id: row.id, label: `${r.sheet.name}（${r.sheet.system}）：${row.title}${row.ho ? " " + row.ho : ""}`, props, what });
  }
  return out;
}
async function runsApplyRefresh(token, changes, onEach) {
  let done = 0;
  for (const c of changes) {
    await notionRequest(token, `/pages/${c.id}`, { properties: c.props }, "PATCH");
    await notionSleep(NOTION_GAP_MS);
    if (onEach) onEach(++done, changes.length);
  }
  return done;
}

if (typeof module !== "undefined") {
  module.exports = { RUNS_DB, TAKU_DB, RUNS_SYSTEM, RUN_SYSTEMS, runsSystemsAgree, runsPlOf, runsSeriesOf, runsLoad, runsIndex, runsLabel, runsCreate, runsAddForSheets, runsPlanRefresh, runsApplyRefresh };
}
