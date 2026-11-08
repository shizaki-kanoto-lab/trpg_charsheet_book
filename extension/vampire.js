// キャラクター保管所 (charasheet.vampire-blood.net): reads a sheet through the site's JSON output
// (/<sheet id>.js). Call of Cthulhu 6th edition sheets are read in full; other systems get the
// name, profile, memo and tags.

// Runs inside the キャラクター保管所 page (MAIN world).
async function vampireFetchSheets(onlyId) {
  const id = onlyId || (location.pathname.match(/^\/(m?[0-9a-f]{32})/) || [])[1];
  if (!id) return { error: "open-sheet" };
  const r = await fetch(`/${id}.js`);
  if (!r.ok) return { error: "sheet-" + r.status };
  return { sheets: [{ id, data: await r.json() }] };
}

// The fixed skill rows of the CoC 6th edition sheet, in the site's order. Rows after these are
// skills the player added; their names are in T?AName.
const VB_COC_SKILLS = {
  TBA: ["回避", "キック", "組み付き", "こぶし（パンチ）", "頭突き", "投擲", "マーシャルアーツ", "拳銃", "サブマシンガン", "ショットガン", "マシンガン", "ライフル"],
  TFA: ["応急手当", "鍵開け", "隠す", "隠れる", "聞き耳", "忍び歩き", "写真術", "精神分析", "追跡", "登攀", "図書館", "目星"],
  TAA: ["運転", "機械修理", "重機械操作", "乗馬", "水泳", "製作", "操縦", "跳躍", "電気修理", "ナビゲート", "変装"],
  TCA: ["言いくるめ", "信用", "説得", "値切り", "母国語"],
  TKA: ["医学", "オカルト", "化学", "クトゥルフ神話", "芸術", "経理", "考古学", "コンピューター", "心理学", "人類学", "生物学", "地質学", "電子工学", "天文学", "博物学", "物理学", "法律", "薬学", "歴史"],
};
// Skills whose field (運転（自動車）など) is written separately.
const VB_FIELDS = { "運転": "unten_bunya", "製作": "seisaku_bunya", "操縦": "main_souju_norimono", "芸術": "geijutu_bunya", "母国語": "mylang_name" };
const VB_CORE = ["目星", "聞き耳", "図書館", "回避"];
const VB_GAMES = { coc: "クトゥルフ神話TRPG 6版" };   // other systems show the site's own code

function vbSkills(d) {
  const out = [];
  let mythos = 0;
  for (const [g, names] of Object.entries(VB_COC_SKILLS)) {
    const totals = d[g + "P"] || [], defaults = d[g + "D"] || [], extra = d[g + "Name"] || [];
    for (let i = 0; i < totals.length; i++) {
      const base = i < names.length ? names[i] : extra[i - names.length];
      if (!base) continue;
      const field = VB_FIELDS[base] && String(d[VB_FIELDS[base]] || "").trim();
      const label = field ? `${base}（${field}）` : base;
      const value = Number(totals[i]) || 0;
      if (base === "クトゥルフ神話") mythos = value;
      if (value !== (Number(defaults[i]) || 0) || VB_CORE.includes(base) || i >= names.length) out.push({ label, value: String(value) });
    }
  }
  return { skills: out, mythos };
}

function vampireToItem(sheet) {
  const d = sheet.data || {};
  const url = "https://charasheet.vampire-blood.net/" + sheet.id;
  const name = String(d.pc_name || d.data_title || "").trim();
  const isCoc6 = d.game === "coc";
  const profile = [
    ["職業", d.shuzoku], ["年齢", d.age], ["性別", d.sex], ["身長", d.pc_height], ["体重", d.pc_weight],
    ["出身", d.pc_kigen], ["髪の色", d.color_hair], ["瞳の色", d.color_eye], ["肌の色", d.color_skin],
  ].filter(([, v]) => String(v || "").trim()).map(([k, v]) => `${k}: ${String(v).trim()}`);
  const notes = [profile.join("\n"), String(d.pc_making_memo || "").trim()].filter(Boolean).join("\n\n");
  const tags = [isCoc6 ? "6版" : "", ...String(d.pc_tags || "").split(/\s+/)].map(t => t.trim()).filter(Boolean);
  const item = {
    url, site: "キャラクター保管所",
    name, ruby: "",
    system: VB_GAMES[d.game] || d.game || "",
    summary: String(d.shuzoku || "").trim(),
    tags, notes, skills: [],
    ccfolia: { kind: "character", data: { name, memo: "", initiative: 0, externalUrl: url, status: [], params: [], commands: "" } },
  };
  if (!isCoc6) return item;

  const np = i => Number(d["NP" + i]) || 0;
  const keys = ["STR", "CON", "POW", "DEX", "APP", "SIZ", "INT", "EDU"];
  const { skills, mythos } = vbSkills(d);
  const hp = np(9), mp = np(10), sanStart = np(11);
  const san = String(d.SAN_Left || "").trim() !== "" ? Number(d.SAN_Left) || 0 : sanStart;
  const db = String(d.dmg_bonus || "+0").trim();
  const dbStr = /^[+-]/.test(db) ? db : "+" + db;
  const commands = [
    "CCB<={SAN} 【SANチェック】",
    ...skills.map(s => `CCB<=${s.value} 【${s.label}】`),
    `CCB<=${np(12)} 【アイデア】`, `CCB<=${np(13)} 【幸運】`, `CCB<=${np(14)} 【知識】`,
    ...keys.map((k, i) => `CCB<=${np(i + 1) * 5} 【${k} × 5】`),
    `1d3${dbStr} 【ダメージ判定】`, `1d4${dbStr} 【ダメージ判定】`, `1d6${dbStr} 【ダメージ判定】`,
  ].join("\n");
  item.skills = skills;
  item.ccfolia.data.initiative = np(4);
  item.ccfolia.data.status = [{ label: "HP", value: hp, max: hp }, { label: "MP", value: mp, max: mp }, { label: "SAN", value: san, max: 99 - mythos }];
  item.ccfolia.data.params = keys.map((k, i) => ({ label: k, value: String(np(i + 1)) }));
  item.ccfolia.data.commands = commands;
  return item;
}

if (typeof module !== "undefined") module.exports = { vampireToItem };
