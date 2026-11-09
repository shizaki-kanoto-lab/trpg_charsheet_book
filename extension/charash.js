// キャラッシュ (charash.jp): reads the logged-in visitor's sheets through the site's own pages and API,
// and converts them into the sheet book's import format.

// Runs inside the charash page (MAIN world). The site's login cookie never leaves the page.
async function charashFetchSheets(onlyToken) {
  let tokenList = onlyToken ? [onlyToken] : null;
  if (!tokenList) {
    const res = await fetch("/", { credentials: "include" });
    if (!res.ok) return { error: "list-" + res.status };
    const html = await res.text();
    tokenList = [...new Set([...html.matchAll(/\/(?:edit|view)\/([A-Za-z0-9_-]{12})/g)].map(m => m[1]))];
    if (!tokenList.length) return { error: "not-logged-in" };
  }
  const sheets = [];
  for (const t of tokenList) {
    const r = await fetch("/api/sheets/" + t, { credentials: "include" });
    if (!r.ok) continue;
    const sheet = await r.json();
    // The sheet's own image is only named in the view page (og:image -> /api/sheets/<token>/image).
    try {
      const html = await (await fetch(`/view/${t}`, { credentials: "include" })).text();
      if (new RegExp(`/api/sheets/${t}/image`).test(html)) sheet.image = `https://charash.jp/api/sheets/${t}/image`;
    } catch { /* no image */ }
    sheets.push(sheet);
  }
  return { sheets };
}

const CH_SYSTEMS = {
  emoklore: "エモクロアTRPG", gaiacare: "ガイアケアTRPG",
  coc6: "クトゥルフ神話TRPG 6版", coc7: "クトゥルフ神話TRPG 7版", "10_st": "10_st", none: "オリジナル",
};
const CH_ABILITIES = [
  ["body", "身体"], ["dexterity", "器用"], ["mind", "精神"], ["senses", "五感"],
  ["intellect", "知力"], ["charm", "魅力"], ["social", "社会"], ["fortune", "運勢"],
];
// Skill names and related stats, as charash defines them for エモクロア / ガイアケア.
const CH_SKILLS = {
  origin_gc: ["〈オリジン〉", ["fortune"]],
  investigation_base: ["〈＊調査〉", ["dexterity"]], search: ["〈検索〉", ["intellect"]], insight: ["〈洞察〉", ["intellect"]],
  mapping: ["〈マッピング〉", ["dexterity", "senses"]], intuition: ["〈直感〉", ["mind", "fortune"]], appraisal: ["〈鑑定〉", ["senses", "intellect"]],
  perception_base: ["〈＊知覚〉", ["senses"]], keen_eye: ["〈観察眼〉", ["senses"]], listen: ["〈聞き耳〉", ["senses"]],
  taste_test: ["〈毒見〉", ["senses"]], danger_sense: ["〈危機察知〉", ["senses", "fortune"]], sixth_sense: ["〈★霊感〉", ["mind", "fortune"]],
  negotiation_base: ["〈＊交渉〉", ["charm"]], socializing: ["〈社交術〉", ["social"]], debate: ["〈ディベート〉", ["intellect"]],
  fascination: ["〈魅了〉", ["charm"]], psychology: ["〈心理〉", ["mind", "intellect"]],
  knowledge_base: ["〈＊知識〉", ["intellect"]], news_base: ["〈＊ニュース〉", ["social"]], well_informed: ["〈事情通〉", ["senses", "social"]],
  expertise: ["〈専門知識：○○〉", ["intellect"]], industry: ["〈業界：○○〉", ["social", "charm"]],
  athletics_base: ["〈＊運動〉", ["body"]], speed: ["〈スピード〉", ["body"]], strength: ["〈ストレングス〉", ["body"]],
  acrobat: ["〈アクロバット〉", ["body", "dexterity"]], dive: ["〈ダイブ〉", ["body"]],
  melee_base: ["〈＊格闘〉", ["body"]], martial_art: ["〈武術：○○〉", ["body"]], secret_art: ["〈★奥義：○○〉", ["body", "mind", "dexterity"]],
  throw_base: ["〈＊投擲〉", ["dexterity"]], shooting: ["〈★射撃：○○〉", ["dexterity", "senses"]],
  survival_base: ["〈＊生存〉", ["body"]], endurance: ["〈耐久〉", ["body"]],
  ego_base: ["〈＊自我〉", ["mind"]], guts: ["〈根性〉", ["mind"]],
  first_aid_base: ["〈＊手当て〉", ["intellect"]], medicine: ["〈医術〉", ["dexterity", "intellect"]], resuscitation: ["〈★蘇生〉", ["intellect", "mind"]],
  craft_base: ["〈＊細工〉", ["dexterity"]], technique: ["〈技巧：○○〉", ["dexterity"]], cipher: ["〈暗号〉", ["intellect"]],
  cyber: ["〈電脳〉", ["intellect"]], concealment: ["〈隠匿〉", ["dexterity", "social", "fortune"]],
  art: ["〈芸術：○○〉", ["dexterity", "mind", "senses"]], pilot: ["〈操縦：○○〉", ["dexterity", "senses", "intellect"]],
  luck_base: ["〈＊幸運〉", ["fortune"]], great_luck: ["〈★強運〉", ["fortune"]],
};

function chSkillLabel(defName, free) {
  let n = defName.replace(/^〈|〉$/g, "").replace(/^[＊★∞]/, "");
  if (n.includes("：○○")) n = n.replace("：○○", free ? "（" + free + "）" : "");
  return n;
}

// The scenarios this character played: エモクロアの残響の記録 (systems.<sys>.echoes) and the
// 参加セッション list (shared.sessions), whose memo may name the HO. The same scenario in both counts once.
function chPassed(sheet) {
  const clean = n => String(n || "").replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim();
  const echoes = (sheet.data?.systems?.[sheet.system]?.echoes || []).map(x => clean(x?.scenario)).filter(Boolean);
  const sessions = (sheet.data?.shared?.sessions || []).map(s => notionScenarioWithHo(clean(s?.scenario), s?.memo)).filter(Boolean);
  return [...sessions, ...echoes];
}
// エモクロア sheets take their scenarios only from 残響の記録 and 参加セッション: the sheet's tags
// keep only marks such as 「CoCコンバート」, since scenario tags there often name sessions of the
// character's CoC original.
const chTags = (sheet, tags) => sheet.system === "emoklore" ? tags.filter(t => NOTION_META_TAG.test(t)) : tags;

function charashToItem(sheet) {
  const sh = sheet.data?.shared || {};
  const sys = sheet.system;
  const url = `https://charash.jp/view/${sheet.token}/${sys}`;
  const profile = [
    ["年齢", sh.age], ["性別", sh.gender], ["職業", sh.occupation], ["出身", sh.origin], ["身長", sh.height], ["体重", sh.weight],
    ["外見", sh.appearance], ["性格", sh.personality], ["経歴", sh.background], ["関係", sh.relations], ["好きなもの・嫌いなもの", sh.likes],
  ].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  const memos = (sh.memos || []).filter(m => m.body).map(m => (m.title ? `【${m.title}】\n` : "") + m.body);
  const item = {
    url, site: "キャラッシュ", image: sheet.image || "",
    name: sh.name || "", ruby: sh.nameKana || "",
    system: CH_SYSTEMS[sys] || sys || "",
    summary: sh.occupation || "",
    tags: [...chTags(sheet, sh.tags || []), sh.lost ? "ロスト" : ""].filter(Boolean),
    passed: chPassed(sheet),
    notes: [profile.join("\n"), ...memos].filter(Boolean).join("\n\n"),
    skills: [],
    ccfolia: null,
  };

  const e = sheet.data?.systems?.[sys];
  if (!e || !(sys === "emoklore" || sys === "gaiacare")) return item;   // other systems: name, URL and profile only

  const ab = e.abilities || {};
  const val = k => Number(ab[k]) || 0;
  const hp = e.hpOverride !== "" && e.hpOverride != null ? Number(e.hpOverride) : Number(e.hp) || val("body") + 10;
  const mp = e.mpOverride !== "" && e.mpOverride != null ? Number(e.mpOverride) : Number(e.mp) || val("mind") + val("intellect");
  const resonance = Number(e.skills?.resonance?.[0]?.level) || 0;

  const lines = [];
  for (const [id, entries] of Object.entries(e.skills || {})) {
    if (id === "resonance") continue;
    const def = CH_SKILLS[id];
    for (const s of entries || []) {
      const level = Number(s.level) || 0;
      if (!level) continue;
      const refs = def ? def[1] : [];
      const ability = s.ability || refs.reduce((best, k) => (val(k) > val(best) ? k : best), refs[0] || "body");
      const target = val(ability) + level;
      const label = def ? chSkillLabel(def[0], s.freeField) : id;
      item.skills.push({ label, value: String(target) });
      lines.push(`${level}DM<=${target} 〈${label}〉`);
    }
  }
  for (const s of e.customSkills || []) {
    const level = Number(s.level) || 0;
    if (!s.name || !level) continue;
    const target = val(s.ability) + level;
    item.skills.push({ label: s.name, value: String(target) });
    lines.push(`${level}DM<=${target} 〈${s.name}〉`);
  }
  if (resonance) lines.unshift("{共鳴}DM<={強度} 〈∞共鳴〉");

  item.ccfolia = {
    kind: "character",
    data: {
      name: item.name, memo: "", initiative: val("dexterity"), externalUrl: url,
      status: [{ label: "HP", value: hp, max: hp }, { label: "MP", value: mp, max: mp }, ...(resonance ? [{ label: "共鳴", value: resonance, max: 10 }] : [])],
      params: CH_ABILITIES.map(([k, l]) => ({ label: l, value: String(val(k)) })),
      commands: e.paletteOverride || lines.join("\n"),
    },
  };
  return item;
}
