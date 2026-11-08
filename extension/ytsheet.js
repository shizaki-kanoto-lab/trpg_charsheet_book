// ゆとシート (yutorize.work / yutorize.2-d.jp): reads a sheet through the site's own JSON output
// (?id=…&mode=json) and its chat palette (&mode=palette&tool=bcdice), for any system the site hosts.

// Runs inside the ゆとシート page (MAIN world).
async function ytsheetFetchSheets(onlyId) {
  const id = onlyId || new URLSearchParams(location.search).get("id");
  if (!id) return { error: "open-sheet" };
  const base = location.origin + location.pathname;
  const r = await fetch(`${base}?id=${encodeURIComponent(id)}&mode=json`);
  if (!r.ok) return { error: "sheet-" + r.status };
  const data = await r.json();
  if (data.result && data.result !== "OK") return { error: "sheet-" + data.result };
  let palette = "";
  try {
    const p = await fetch(`${base}?id=${encodeURIComponent(id)}&mode=palette&tool=bcdice`);
    if (p.ok) palette = (await p.text()).trim();
  } catch { /* the palette is optional */ }
  const system = location.pathname.split("/").filter(Boolean).pop() || "";
  return { sheets: [{ id, base, system, data, palette }] };
}

const YT_SYSTEMS = {
  "kiz": "キズナバレット",
  "dx3rd": "ダブルクロス The 3rd Edition",
  "sw2.5": "ソード・ワールド2.5",
  "sw2": "ソード・ワールド2.0",
  "ar2e": "アリアンロッドRPG 2E",
  "gs": "ゴブリンスレイヤーTRPG",
};   // other systems show the site's own code (the folder name in the URL)

// ゆとシート stores text HTML-escaped, with <br> for line breaks.
function ytText(s) {
  return String(s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "")
    .replace(/[｜|]([^｜|《\n]+)《([^》\n]+)》/g, "$1（$2）")   // ruby: ｜漢字《よみ》
    .trim();
}

// unitStatus: [{"HP": "35/35"}, {"侵蝕": "34"}, …] -> [{label, value, max}]
function ytStatus(d) {
  let list = d.unitStatus;
  if (typeof list === "string") { try { list = JSON.parse(list); } catch { list = []; } }
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    for (const [label, raw] of Object.entries(entry || {})) {
      const m = String(raw).match(/^\s*(-?\d+)\s*(?:\/\s*(-?\d+))?\s*$/);
      if (m) out.push({ label, value: Number(m[1]), max: Number(m[2] ?? m[1]) });
    }
  }
  return out;
}

const YT_DX_SKILLS = [["Melee", "白兵"], ["Dodge", "回避"], ["Ranged", "射撃"], ["Percept", "知覚"], ["RC", "RC"], ["Will", "意志"], ["Negotiate", "交渉"], ["Procure", "調達"]];

function ytParamsAndSkills(system, d) {
  if (system === "dx3rd") {
    const params = [["Body", "肉体"], ["Sense", "感覚"], ["Mind", "精神"], ["Social", "社会"]]
      .map(([k, label]) => ({ label, value: String(Number(d["sttTotal" + k]) || 0) }));
    const skills = YT_DX_SKILLS.map(([k, label]) => ({ label, value: Number(d["skillTotal" + k]) || 0 }));
    for (const k of ["Ride", "Art", "Know", "Info"]) {
      const n = Number(d[`skill${k}Num`]) || 0;
      for (let i = 1; i <= n; i++) {
        const name = d[`skill${k}${i}Name`];
        if (name) skills.push({ label: name, value: Number(d[`skillTotal${k}${i}`] ?? d[`skill${k}${i}`]) || 0 });
      }
    }
    return { params, skills: skills.filter(s => s.value > 0).map(s => ({ label: s.label, value: String(s.value) })) };
  }
  return { params: [], skills: [] };
}

function ytsheetToItem(sheet) {
  const d = sheet.data || {};
  const system = sheet.system;
  const url = d.sheetURL || `${sheet.base}?id=${sheet.id}`;
  const name = ytText(d.characterName || d.aka || d.name || "");
  const status = ytStatus(d);
  const { params, skills } = ytParamsAndSkills(system, d);

  // Session titles are the scenarios this character played.
  const sessions = [];
  for (let i = 1; i <= (Number(d.historyNum) || 0); i++) { const t = ytText(d[`history${i}Title`]); if (t) sessions.push(t); }
  const tags = [...String(d.tags || "").split(/\s+/), ...sessions].map(t => t.trim()).filter(Boolean);

  const notes = [
    ytText(d.sheetDescriptionM),
    d.playerName ? "PL: " + ytText(d.playerName) : "",
    ytText(d.freeNote),
    ytText(d.freeHistory),
  ].filter(Boolean).join("\n\n");

  const summary = ytText(d.aka || d.class || d.works || d.cover || "");
  return {
    url, site: "ゆとシート", image: d.image && d.imageURL ? String(d.imageURL) : "",
    name, ruby: ytText(d.characterNameRuby || d.akaRuby || ""),
    system: YT_SYSTEMS[system] || system,
    summary, tags: [...new Set(tags)], notes, skills,
    ccfolia: {
      kind: "character",
      data: {
        name, memo: "", initiative: Number(d.initiativeTotal) || 0, externalUrl: url,
        status, params, commands: sheet.palette || "",
      },
    },
  };
}

if (typeof module !== "undefined") module.exports = { ytsheetToItem };
