// いあきゃら: reads sheets through the site's own API with the visitor's logged-in session,
// and converts iachara's raw sheet data into the sheet book's import format.

// Runs inside the iachara page (MAIN world). The login token stays in the page; only sheet data comes back.
async function iacharaFetchSheets(onlyId) {
  const idb = await new Promise((ok, ng) => {
    const r = indexedDB.open("firebaseLocalStorageDb");
    r.onsuccess = () => ok(r.result); r.onerror = () => ng(r.error);
  });
  const rows = await new Promise((ok, ng) => {
    const q = idb.transaction("firebaseLocalStorage").objectStore("firebaseLocalStorage").getAll();
    q.onsuccess = () => ok(q.result); q.onerror = () => ng(q.error);
  });
  const user = rows.map(r => r.value).find(v => v && v.stsTokenManager);
  if (!user) return { error: "not-logged-in" };
  const headers = { "Content-Type": "application/json", Authorization: "Bearer " + user.stsTokenManager.accessToken };
  const api = "https://apiv3.iachara.com/v3";
  const res = await fetch(api + "/user/charasheet", { headers });
  if (!res.ok) return { error: "list-" + res.status };
  let list = (await res.json()).filter(c => !c.deleted);
  if (onlyId) {
    let one = list.find(c => String(c.id) === String(onlyId));
    if (!one) {
      const r = await fetch(api + "/charasheet/" + onlyId, { headers });
      if (!r.ok) return { error: "sheet-" + r.status };
      one = await r.json();
      if (one?.success !== undefined && one.data) one = one.data;   // {success, data: {id, name, data: …}}
      else if (!one.data && one.charasheet) one = one.charasheet;
    }
    list = [one];
  }
  return { sheets: list.map(c => ({ id: c.id, name: c.name, tag: c.tag, public: c.public, data: c.data })) };
}

const IA_GROUPS = ["battleSkills", "searchSkills", "actionSkills", "negotiationSkills", "knowledgeSkills"];
const IA_CORE = ["目星", "聞き耳", "図書館", "回避"];

function iaAbility(a) { return a ? (Number(a.value) || 0) + (Number(a.fixedDiff) || 0) + (Number(a.tmpFixedDiff) || 0) : 0; }
function iaDiff(a) { return a ? (Number(a.fixedDiff) || 0) + (Number(a.tmpFixedDiff) || 0) : 0; }

function iaDb6(n) {
  if (n <= 12) return "-1d6"; if (n <= 16) return "-1d4"; if (n <= 24) return "+0";
  if (n <= 32) return "+1d4"; if (n <= 40) return "+1d6";
  return "+" + (2 + Math.floor((n - 41) / 16)) + "d6";
}
function iaDb7(n) {
  if (n <= 64) return ["-2", -2]; if (n <= 84) return ["-1", -1]; if (n <= 124) return ["+0", 0];
  if (n <= 164) return ["+1d4", 1]; if (n <= 204) return ["+1d6", 2];
  const k = 2 + Math.floor((n - 205) / 80); return ["+" + k + "d6", k + 1];
}

// Tags are separated by spaces (or commas); "、" belongs to names such as 「影よ、影よ！」. A name
// with spaces stays one tag: a passed scenario written out ("胡桃炸裂症候群 -Drosselmeyer Syndrome-"),
// the start of a passed scenario's name ("Paranormal Crime" of "Paranormal Crime Episode 1：…"),
// or a part that begins with a mark ("地球戦争 -火星からの侵略者-").
function iaSplitTags(tag, passedNames = []) {
  let s = String(tag || "");
  const names = passedNames.map(n => String(n || "").trim()).filter(Boolean);
  for (const name of names) {
    if (/\s/.test(name) && s.includes(name)) s = s.split(name).join(name.replace(/\s/g, "\u0000"));
  }
  const key = t => notionScenarioKey(notionSplitHo(t)[0]);
  const keys = names.map(key).filter(Boolean);
  const out = [];
  for (const raw of s.split(/[,\s]+/).filter(Boolean)) {
    const t = raw.replace(/\u0000/g, " ");
    const prev = out[out.length - 1];
    const joined = prev && key(prev + " " + t);
    if (prev && !keys.includes(key(prev)) && (/^[-－―~～〜(（「『【〈《:：]/.test(t)
      || (joined && joined !== key(prev) && keys.some(k => k.startsWith(joined))))) out[out.length - 1] = prev + " " + t;
    else out.push(t);
  }
  return out;
}

function iacharaToItem(sheet) {
  const d = sheet.data || {}, ab = d.abilities || {}, p = d.profile || {};
  const six = d.version !== "7th";
  const v = {}; for (const k of ["str", "con", "pow", "dex", "app", "siz", "int", "edu"]) v[k] = iaAbility(ab[k]);

  const skills = [];
  let mythos = 0;
  for (const g of IA_GROUPS) {
    const grp = d[g] || {};
    for (const s of [...(grp.static || []), ...(grp.additional || [])]) {
      let def = s.defaultPoint;
      if (def === undefined || def === null) {
        if (s.name === "回避") def = six ? v.dex * 2 : Math.floor(v.dex / 2);
        else if (s.name === "母国語") def = six ? v.edu * 5 : v.edu;
        else def = 0;
      }
      def = Number(def) || 0;
      const total = def + (Number(s.professionPoint) || 0) + (Number(s.interestPoint) || 0) + (Number(s.growthPoint) || 0) + (Number(s.otherPoint) || 0);
      const label = s.name + (s.additionalName ? "（" + s.additionalName + "）" : "");
      if (s.name === "クトゥルフ神話") mythos = total;
      if (s.name && (total !== def || IA_CORE.includes(s.name))) skills.push({ label, value: String(total) });
    }
  }

  const dice = six ? "CCB" : "CC";
  // A sheet saved without a current SAN stores 0; use the starting SAN unless the character is lost.
  const sanCur = Number(ab.sanCurrent) > 0 || p.isLost ? Number(ab.sanCurrent) || 0 : null;
  let hp, mp, sanMax = 99 - mythos, san, db, params, status, extraLines;
  if (six) {
    hp = Math.ceil((v.con + v.siz) / 2) + iaDiff(ab.hp);
    mp = v.pow + iaDiff(ab.mp);
    san = sanCur ?? v.pow * 5;
    db = ab.userDB || iaDb6(v.str + v.siz);
    params = ["STR", "CON", "POW", "DEX", "APP", "SIZ", "INT", "EDU"].map(k => ({ label: k, value: String(v[k.toLowerCase()]) }));
    status = [{ label: "HP", value: hp, max: hp }, { label: "MP", value: mp, max: mp }, { label: "SAN", value: san, max: sanMax }];
    extraLines = [
      `${dice}<=${v.int * 5 + iaDiff(ab.ide)} 【アイデア】`,
      `${dice}<=${v.pow * 5 + iaDiff(ab.luck)} 【幸運】`,
      `${dice}<=${Math.min(99, v.edu * 5 + iaDiff(ab.know))} 【知識】`,
      ...["STR", "CON", "POW", "DEX", "APP", "SIZ", "INT", "EDU"].map(k => `${dice}<=${v[k.toLowerCase()] * 5} 【${k} × 5】`),
    ];
  } else {
    hp = Math.floor((v.con + v.siz) / 10) + iaDiff(ab.hp);
    mp = Math.floor(v.pow / 5) + iaDiff(ab.mp);
    san = sanCur ?? v.pow;
    const [db7, bld] = iaDb7(v.str + v.siz);
    db = ab.userDB || db7;
    const mov = Number(ab.userMOV) || (v.dex < v.siz && v.str < v.siz ? 7 : v.dex > v.siz && v.str > v.siz ? 9 : 8);
    const luck = iaAbility(ab.luck);
    params = [...["STR", "CON", "POW", "DEX", "APP", "SIZ", "INT", "EDU"].map(k => ({ label: k, value: String(v[k.toLowerCase()]) })),
      { label: "BLD", value: String(bld) }, { label: "MOV", value: String(mov) }];
    status = [{ label: "HP", value: hp, max: hp }, { label: "MP", value: mp, max: mp }, { label: "SAN", value: san, max: sanMax }, { label: "幸運", value: luck, max: luck }];
    extraLines = [`${dice}<=${luck} 【幸運】`, ...["STR", "CON", "POW", "DEX", "APP", "SIZ", "INT", "EDU"].map(k => `${dice}<=${v[k.toLowerCase()]} 【${k}】`)];
  }
  const dbStr = /^[+-]/.test(db) ? db : "+" + db;
  const commands = [
    `${dice}<={SAN} 【SANチェック】`,
    ...skills.map(s => `${dice}<=${s.value} 【${s.label}】`),
    ...extraLines,
    `1d3${dbStr} 【ダメージ判定】`, `1d4${dbStr} 【ダメージ判定】`, `1d6${dbStr} 【ダメージ判定】`,
  ].join("\n");

  const profileLines = [
    p.profession && "職業: " + p.profession, p.age && "年齢: " + p.age, p.sex && "性別: " + p.sex,
    p.height && "身長: " + p.height, p.weight && "体重: " + p.weight, p.from && "出身: " + p.from,
  ].filter(Boolean);
  const notes = [profileLines.join("\n"), d.memo || ""].filter(Boolean).join("\n\n");
  // 通過シナリオ: [{ name, memo }]
  const passed = (Array.isArray(d.passedScenarios) ? d.passedScenarios : []).map(s => notionScenarioWithHo(s?.name, s?.memo)).filter(Boolean);
  const tags = [six ? "6版" : "7版", ...iaSplitTags(sheet.tag, (d.passedScenarios || []).map(s => s?.name)), p.isLost ? "ロスト" : ""].filter(Boolean);

  return {
    url: "https://iachara.com/view/" + sheet.id,
    site: "いあきゃら",
    name: p.name || sheet.name || "",
    ruby: p.furi || "",
    system: six ? "クトゥルフ神話TRPG 6版" : "クトゥルフ神話TRPG 7版",
    summary: p.profession || "",
    tags, passed, notes, skills,
    image: (p.icons || []).find(i => i?.url)?.url || "",   // the first image shown on the sheet
    ccfolia: { kind: "character", data: { name: p.name || sheet.name || "", memo: "", initiative: v.dex, externalUrl: "https://iachara.com/view/" + sheet.id, status, params, commands } },
  };
}
