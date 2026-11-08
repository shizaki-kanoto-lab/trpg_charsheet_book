// フタリソウサ character sheets made from the official Google Sheets template ("キャラシ" and
// "ココフォリアコピペ用" tabs). One spreadsheet holds two characters, the 探偵 and the 助手;
// gsheetToItems returns both and the popup adds the one the visitor plays.

// Runs inside the Google Sheets page (MAIN world): reads the two tabs as CSV.
async function gsheetFetchSheets() {
  const id = (location.pathname.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/) || [])[1];
  if (!id) return { error: "open-sheet" };
  const base = `${location.origin}/spreadsheets/d/${id}`;
  // The tab names and gids are listed in the HTML view.
  const tabs = {};
  try {
    const h = await (await fetch(`${base}/htmlview`)).text();
    for (const m of h.matchAll(/\{name: "([^"]+)", pageUrl: "[^"]*?gid=(\d+)/g)) tabs[m[1]] = m[2];
  } catch { /* fall back to the first tab */ }
  const csv = async gid => {
    const r = await fetch(`${base}/export?format=csv&gid=${gid}`);
    if (!r.ok) throw new Error("sheet-" + r.status);
    return r.text();
  };
  try {
    const main = await csv(tabs["キャラシ"] ?? "0");
    const ccf = tabs["ココフォリアコピペ用"] ? await csv(tabs["ココフォリアコピペ用"]).catch(() => "") : "";
    return { sheets: [{ id, title: document.title.replace(/\s*-\s*Google\s*(スプレッドシート|Sheets)\s*$/i, "").trim(), main, ccf }] };
  } catch (e) { return { error: e.message }; }
}

// RFC 4180 CSV -> rows of cells.
function gsCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const GS_FIELDS = ["PL名", "PC名", "クラス", "背景", "性別", "年齢", "体重", "身長", "職業", "設定", "呼び名", "ファッション特徴", "好きなもの", "嫌いなもの"];

// "キャラシ": each label appears twice in its row, once for the 探偵 and once for the 助手.
function gsSides(rows) {
  const sides = [{ role: "探偵" }, { role: "助手" }];
  for (const r of rows) {
    const cells = r.map(c => c.trim());
    for (const f of GS_FIELDS) {
      const at = cells.reduce((a, c, i) => (c === f ? [...a, i] : a), []);
      if (at.length < 2) continue;
      const width = at[1] - at[0];
      at.slice(0, 2).forEach((start, side) => {
        for (let i = start + 1; i < start + width && i < cells.length; i++) {
          if (cells[i]) { sides[side][f] = cells[i]; break; }
        }
      });
    }
  }
  // 思い出の品 rows: the シナリオ名 column names the scenarios the pair played.
  const scenarios = [];
  const head = rows.findIndex(r => r.some(c => c.trim() === "シナリオ名") && r.some(c => c.trim() === "アイテム名"));
  if (head >= 0) {
    const col = rows[head].findIndex(c => c.trim() === "シナリオ名");
    for (const r of rows.slice(head + 1)) {
      if (!/^\d+$/.test((r[1] || "").trim())) break;
      const s = (r[col] || "").trim();
      if (s && s !== "-" && !scenarios.includes(s)) scenarios.push(s);
    }
  }
  return { sides, scenarios };
}

// "ココフォリアコピペ用": the piece JSON is split over the rows of one column per side.
function gsPieces(rows) {
  const pieces = [];
  const start = rows.findIndex(r => r.some(c => c.trim().startsWith('{ "kind"')));
  if (start < 0) return pieces;
  rows[start].forEach((c, col) => {
    if (!c.trim().startsWith('{ "kind"')) return;
    let text = "";
    for (const r of rows.slice(start)) {
      text += r[col] || "";
      try { const o = JSON.parse(text); if (o?.kind === "character") pieces.push(o); return; } catch { /* keep adding rows */ }
    }
  });
  return pieces;
}

// "四藤傑（しどう すぐる）" -> name and reading.
function gsName(s) {
  const m = String(s || "").match(/^(.*?)[（(]([^）)]+)[）)]\s*$/);
  return m ? { name: m[1].trim(), ruby: m[2].trim() } : { name: String(s || "").trim(), ruby: "" };
}

function gsheetToItems(sheet) {
  const { sides, scenarios } = gsSides(gsCsv(sheet.main || ""));
  const pieces = gsPieces(gsCsv(sheet.ccf || ""));
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheet.id}/edit`;
  return sides.filter(s => s["PC名"]).map((s, i) => {
    const other = sides[1 - i];
    const { name, ruby } = gsName(s["PC名"]);
    const url = `${sheetUrl}#${s.role}`;
    const piece = pieces[i]?.data || {};
    const memo = String(piece.memo || "").trim();
    // ＜技能＞ lines in the piece memo: "洞察：嘘／現場"
    const skillBlock = (memo.match(/＜技能＞\n([\s\S]*?)(?:\n\n|$)/) || [])[1] || "";
    const skills = skillBlock.split("\n").map(l => l.trim()).filter(Boolean).map(label => ({ label, value: "" }));
    const profile = [
      ["PL", s["PL名"]], ["役割", s.role], ["呼び名", s["呼び名"]], ["職業", s["職業"]], ["性別", s["性別"]], ["年齢", s["年齢"]],
      ["身長", s["身長"]], ["体重", s["体重"]], ["ファッション", s["ファッション特徴"]], ["好きなもの", s["好きなもの"]], ["嫌いなもの", s["嫌いなもの"]],
      ["パートナー", other["PC名"] && `${other["PC名"]}（${other.role}・PL ${other["PL名"] || "?"}）`],
    ].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
    const notes = [profile.join("\n"), s["設定"] || "", memo.replace(/^【PC】.*\n(【呼び】.*\n)?\n?/, "")].map(t => t.trim()).filter(Boolean).join("\n\n");
    const cls = String(s["クラス"] || "").replace(/[\s　]*[（(]p\.[^）)]*[）)]\s*$/, "").replace(/^\p{Extended_Pictographic}️?/u, "").trim();
    return {
      url, site: "Googleスプレッドシート", plName: s["PL名"] || "", role: s.role,
      name, ruby,
      system: "フタリソウサ",
      summary: [s.role, cls, s["背景"]].filter(Boolean).join("・"),
      tags: [...scenarios], notes, skills,
      stats: [],    // the 異常な癖 (params) are text; they stay in the piece and the memo
      ccfolia: {
        kind: "character",
        data: {
          name, memo, initiative: 0, externalUrl: url,
          status: [], params: Array.isArray(piece.params) ? piece.params : [], commands: piece.commands || "",
        },
      },
    };
  });
}

if (typeof module !== "undefined") module.exports = { gsheetToItems, gsCsv };
