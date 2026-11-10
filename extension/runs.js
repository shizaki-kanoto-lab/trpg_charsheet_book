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
const RUNS_ROLE_OF = { PL: ["PL"], KPC: ["KP", "DL", "GM", "SKP"] };

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
const runsBare = id => String(id).replace(/-/g, "");

// "シナリオ名HO2" / "シナリオ名KPC" / "シナリオ名NPC" -> { base, ho, role }
function runsParseLine(line) {
  let t = String(line).trim(), role = "PL";
  if (/KPC$/i.test(t)) { role = "KPC"; t = t.replace(/\s*KPC$/i, ""); }
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
  })).filter(r => r.name);
  const rows = (await runsAllPages(token, RUNS_DB)).map(pg => {
    const p = pg.properties;
    return { id: runsBare(pg.id), chars: runsProp(p["キャラ"]) || [], title: runsProp(p["シナリオ"]) || "", ho: runsProp(p["HO"]) || "",
      system: runsProp(p["システム"]) || "", taku: runsProp(p["卓報告"]) || [], role: runsProp(p["立場"]) || "" };
  });
  return { sheets, taku, rows };
}

// Every sheet line with its 卓報告 pages, and the 通過記録 page it would make.
function runsIndex({ sheets, taku, rows }) {
  const runs = [];
  for (const s of sheets) for (const line of s.lines) runs.push({ sheet: s, ...runsParseLine(line) });
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
    const title = all.length && !RUNS_KEEP_NAME.has(notionScenarioKey(r.base)) ? all[0].name : r.base;
    const key = `${r.sheet.id}|${notionScenarioKey(title)}|${notionScenarioKey(r.ho)}`;
    const mine = all.filter(t => !RUNS_ROLE_OF[r.role] || RUNS_ROLE_OF[r.role].includes(t.role));
    const alone = playersOf.get(r.role + "|" + notionScenarioKey(r.base)).size === 1;
    const links = alone ? mine : [];
    const system = links[0]?.system || all[0]?.system || RUNS_SYSTEM[r.sheet.system] || "";
    // A line whose 卓報告 is in another system (an エモクロア session copied onto the CoC original)
    // makes no page: the run belongs on the sheet of the system it was played in.
    const crossSystem = all.length > 0 && !runsSystemsAgree(RUNS_SYSTEM[r.sheet.system], system);
    return { ...r, all, title, key, mine, links, system, crossSystem, exists: existing.has(key) };
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
      "立場": { select: { name: p.role } },
    },
  });
}

// The extension, after sending sheets to the sheet book: adds the 通過記録 pages of those sheets
// (by 元シート URL) that tie to 卓報告. A line with no 卓報告 to link is only reported, so rows
// deleted by hand (no 卓報告 for them) are not made again.
async function runsAddForSheets(token, sheetDb, urls) {
  const want = new Set(urls.filter(Boolean));
  const data = await runsLoad(token, sheetDb);
  const idx = runsIndex(data);
  const result = { added: [], unlinked: [] };
  for (const r of idx.runs) {
    if (!want.has(r.sheet.url)) continue;
    const p = idx.plan(r);
    if (p.exists || idx.existing.has(p.key) || p.crossSystem) continue;
    if (!p.links.length) { result.unlinked.push(runsLabel(p)); continue; }
    idx.existing.add(p.key);
    await runsCreate(token, p);
    result.added.push(runsLabel(p));
    await notionSleep(NOTION_GAP_MS);
  }
  return result;
}

if (typeof module !== "undefined") {
  module.exports = { RUNS_DB, TAKU_DB, RUNS_SYSTEM, RUN_SYSTEMS, runsSystemsAgree, runsLoad, runsIndex, runsLabel, runsCreate, runsAddForSheets };
}
