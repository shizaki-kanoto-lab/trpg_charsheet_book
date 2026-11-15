#!/usr/bin/env node
// Fills the 「🕵️ フタリソウサ」 database with one row per pair (探偵 × 助手), read from the フタリソウサ
// sheets in the sheet book: the source sheet (Google Sheets template or キャラクターシート倉庫) is read
// again for both characters, the たまり場, the 異常な癖, the ゲスト (名前（技能） only) and the 思い出の品;
// 通過シナリオ are the 卓報告 pages of the sheets' 通過記録 rows. A row is found again by its 元シート.
//
//   NOTION_TOKEN=... node tools/sync-futari.js [--write]
//
// The integration must be connected to the フタリソウサ database, as well as to the sheet book and 通過記録.

const { NOTION_DEFAULT_DB, NOTION_GAP_MS, notionDbId, notionRequest, notionSleep } = require("../extension/notion.js");
const { gsFutari } = require("../extension/gsheet.js");
const { asFutari } = require("../extension/appspot.js");
const { RUNS_DB } = require("../extension/runs.js");

const FUTARI_DB = "3991b663c48f80f88516d4efe3c9c200";

const plain = rich => (rich || []).map(t => t.plain_text ?? t.text?.content ?? "").join("");
const bare = id => String(id || "").replace(/-/g, "");
const get = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 60)}`); return r.text(); };
// "四藤傑（しどう すぐる）" -> "四藤傑"
const shortName = s => String(s || "").replace(/\s*[（(][^）)]*[）)]\s*$/, "").trim();
const who = p => p.name ? p.name + ([p.cls, p.bg].filter(Boolean).length ? `（${[p.cls, p.bg].filter(Boolean).join("・")}）` : "") : "";

async function allPages(token, db, filter) {
  const out = [];
  let cursor;
  do {
    const r = await notionRequest(token, `/databases/${db}/query`, { page_size: 100, ...(filter ? { filter } : {}), ...(cursor ? { start_cursor: cursor } : {}) });
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
    await notionSleep(NOTION_GAP_MS);
  } while (cursor);
  return out;
}

// One pair from a sheet book page's 元シート: { key, pair }.
async function readPair(url) {
  let m = url.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  if (m) {
    const base = `https://docs.google.com/spreadsheets/d/${m[1]}`;
    const tabs = {};
    for (const t of (await get(`${base}/htmlview`)).matchAll(/\{name: "([^"]+)", pageUrl: "[^"]*?gid=(\d+)/g)) tabs[t[1]] = t[2];
    const main = await get(`${base}/export?format=csv&gid=${tabs["キャラシ"] ?? "0"}`);
    return { key: `${base}/edit`, pair: gsFutari({ main }) };
  }
  m = url.match(/^https:\/\/character-sheets\.appspot\.com\/2s\/edit\.html\?key=([^&#]+)/);
  if (m) {
    const data = JSON.parse(await get(`https://character-sheets.appspot.com/2s/display?ajax=1&key=${m[1]}`));
    const pair = asFutari(data);
    // The partner's PL is on the partner's own sheet.
    const pk = (pair.partnerUrl.match(/key=([^&#]+)/) || [])[1];
    if (pk) {
      try {
        const pd = JSON.parse(await get(`https://character-sheets.appspot.com/2s/display?ajax=1&key=${pk}`));
        const side = pair.detective.url ? pair.detective : pair.assistant;
        side.pl = String(pd.base?.player || "").trim();
        // The ゲスト are kept on either sheet (or both): take the partner's too.
        for (const g of asFutari(pd).guests) {
          const name = g.replace(/（[^（）]*）$/, "");
          if (!pair.guests.some(x => x.replace(/（[^（）]*）$/, "") === name)) pair.guests.push(g);
        }
      } catch { /* the partner's sheet is not public */ }
    }
    // Both sheets of a pair give the same key.
    const key = [url.replace(/#.*$/, ""), pair.partnerUrl].filter(Boolean).sort()[0];
    return { key, pair };
  }
  throw new Error("元シートを読めない形式です");
}

function properties(key, pair, sheetIds, takuIds) {
  const text = s => ({ rich_text: s ? [{ type: "text", text: { content: String(s).slice(0, 2000) } }] : [] });
  const d = pair.detective, a = pair.assistant;
  return {
    "名前": { title: [{ type: "text", text: { content: `${shortName(d.name) || "?"} × ${shortName(a.name) || "?"}` } }] },
    "探偵": text(who(d)), "探偵PL": text(d.pl), "助手": text(who(a)), "助手PL": text(a.pl),
    "たまり場": text(pair.base),
    "異常な癖": text(pair.quirks.map((q, i) => `${i + 1}：${q}`).join("\n")),
    "ゲスト": text(pair.guests.map(g => g.replace(/^・/, "")).join("\n")),
    "思い出の品": text(pair.memories.map(x => x.item + (x.scenario ? `（${x.scenario}）` : "")).join("\n")),
    "シート帳": { relation: [...sheetIds].map(id => ({ id })) },
    "通過シナリオ": { relation: [...takuIds].map(id => ({ id })) },
    "元シート": { url: key },
  };
}

// The same values as text, to compare with a row already in the database.
function shown(props) {
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    out[k] = v.title ? plain(v.title) : v.rich_text ? plain(v.rich_text) : v.relation ? v.relation.map(r => bare(r.id)).sort().join(",") : v.url ?? "";
  }
  return out;
}

async function main() {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN がありません");
  const write = process.argv.includes("--write");
  const sheetDb = notionDbId(process.env.NOTION_DATABASE_ID || NOTION_DEFAULT_DB);

  const sheets = await allPages(token, sheetDb, { property: "システム", select: { equals: "フタリソウサ" } });
  const runs = await allPages(token, RUNS_DB);
  const takuOf = new Map();   // sheet page id -> 卓報告 ids
  for (const r of runs) {
    const chars = (r.properties["キャラ"]?.relation || []).map(x => bare(x.id));
    const taku = (r.properties["卓報告"]?.relation || []).map(x => bare(x.id));
    for (const c of chars) { if (!takuOf.has(c)) takuOf.set(c, new Set()); for (const t of taku) takuOf.get(c).add(t); }
  }
  let existing;
  try { existing = await allPages(token, FUTARI_DB); }
  catch (e) { throw new Error(`フタリソウサのデータベースを読めませんでした (${e.message})。Notionで「…」→「コネクト」からインテグレーションをつないでください。`); }
  const rowOf = new Map(existing.map(p => [p.properties["元シート"]?.url || "", p]));

  const pairs = new Map();   // key -> { pair, sheetIds, takuIds, names }
  const skipped = [];
  for (const page of sheets) {
    const name = plain(page.properties["名前"]?.title) || page.id;
    try {
      const { key, pair } = await readPair(page.properties["元シート"]?.url || "");
      const g = pairs.get(key) || { pair, sheetIds: new Set(), takuIds: new Set(), names: [] };
      g.sheetIds.add(bare(page.id)); g.names.push(name);
      for (const t of takuOf.get(bare(page.id)) || []) g.takuIds.add(t);
      pairs.set(key, g);
    } catch (e) { skipped.push(`${name}: ${e.message}`); }
  }

  const report = { add: [], update: [], same: [] };
  for (const [key, g] of pairs) {
    const props = properties(key, g.pair, g.sheetIds, g.takuIds);
    const want = shown(props);
    const row = rowOf.get(key);
    const title = want["名前"];
    if (row) {
      const have = shown(Object.fromEntries(Object.keys(props).map(k => [k, row.properties[k]?.relation ? { relation: row.properties[k].relation } : row.properties[k] || {}])));
      // What the sheet leaves empty (no たまり場 on キャラクターシート倉庫, say) may be filled in by hand in
      // Notion: never clear it.
      const diff = Object.keys(want).filter(k => want[k] !== (have[k] ?? "") && (want[k] || !have[k]));
      if (!diff.length) { report.same.push(title); continue; }
      report.update.push(`${title}\n` + diff.map(k => `  ${k}: ${(have[k] || "（空）").replace(/\n/g, " / ")} → ${want[k].replace(/\n/g, " / ")}`).join("\n"));
      if (write) { await notionRequest(token, `/pages/${row.id}`, { properties: Object.fromEntries(diff.map(k => [k, props[k]])) }, "PATCH"); await notionSleep(NOTION_GAP_MS); }
    } else {
      report.add.push([title, ...Object.entries(want).filter(([k, v]) => k !== "名前" && v).map(([k, v]) =>
        `  ${k}: ${k === "シート帳" || k === "通過シナリオ" ? `${v.split(",").length}件` : v.replace(/\n/g, " / ")}`)].join("\n"));
      if (write) { await notionRequest(token, "/pages", { parent: { database_id: FUTARI_DB }, properties: props }); await notionSleep(NOTION_GAP_MS); }
    }
  }
  console.log(`フタリソウサのシート ${sheets.length} 枚 → コンビ ${pairs.size} 組`);
  console.log(`\n${write ? "足した" : "足す予定の"}コンビ ${report.add.length} 組\n` + report.add.join("\n"));
  console.log(`\n${write ? "更新した" : "更新する予定の"}コンビ ${report.update.length} 組\n` + report.update.join("\n"));
  console.log(`\n変わらないコンビ ${report.same.length} 組\n` + report.same.join("\n"));
  console.log(`\n読めなかったシート ${skipped.length} 枚\n` + skipped.join("\n"));
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
