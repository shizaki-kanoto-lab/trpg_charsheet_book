// キャラクターシート倉庫 (character-sheets.appspot.com): reads a sheet through the site's JSON output
// (/<system>/display?ajax=1&key=…). Every system gets the name, profile and memo; トーキョーN◎VA
// THE AXLERATION (tnx) sheets also get their abilities and skills.

// Runs inside the キャラクターシート倉庫 page (MAIN world).
async function appspotFetchSheets(onlyKey) {
  const key = onlyKey || new URLSearchParams(location.search).get("key");
  const system = location.pathname.split("/").filter(Boolean)[0] || "";
  if (!key || !system) return { error: "open-sheet" };
  const r = await fetch(`/${system}/display?ajax=1&key=${encodeURIComponent(key)}`);
  if (!r.ok) return { error: "sheet-" + r.status };
  let data;
  try { data = JSON.parse(await r.text()); } catch { return { error: "sheet-json" }; }
  // The system's name is the <title> of the sheet page as served (e.g. "トーキョーN◎VA THE AXLERATION");
  // the open page renames its tab to the character's name, so document.title can't be used.
  let systemName = "";
  try {
    const html = await (await fetch(`/${system}/edit.html`)).text();
    systemName = (new DOMParser().parseFromString(html, "text/html").title || "").replace(/\s*キャラクターシート\s*$/, "").trim();
  } catch { /* falls back to the system code */ }
  // The sheet's picture: /<system>/image?key=… answers with the image bytes when there is one.
  let image = "";
  try {
    const url = `/${system}/image?key=${encodeURIComponent(key)}`;
    const b = new Uint8Array(await (await fetch(url)).arrayBuffer()).slice(0, 4);
    const isImage = (b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0xFF && b[1] === 0xD8) || (b[0] === 0x47 && b[1] === 0x49) || (b[0] === 0x52 && b[1] === 0x49);
    if (isImage) image = location.origin + url;
  } catch { /* no picture */ }
  return { sheets: [{ key, system, systemName, data, image }] };
}

const AS_CLEAN = s => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\s　]+/g, " ").trim();

// トーキョーN◎VA THE AXLERATION: 能力値 / 制御値 for the four abilities, then 一般技能 and 特技 with levels.
function asTnx(d) {
  const a = d.ability || {};
  const params = [];
  for (const [k, label] of [["reason", "理性"], ["passion", "感情"], ["life", "生命"], ["mundane", "外界"]]) {
    if (a[k]?.abl != null) params.push({ label, value: String(a[k].abl) });
    if (a[k]?.ctl != null) params.push({ label: label + "制御", value: String(a[k].ctl) });
  }
  const skills = [];
  for (const g of ["skills1", "skills2", "skills3", "skills4", "superhumanskills"]) {
    for (const s of d[g] || []) {
      const name = AS_CLEAN(s?.name).replace(/^★/, "");
      if (name && !/[：:]$/.test(name) && Number(s.level) > 0) skills.push({ label: name, value: String(Number(s.level)) });
    }
  }
  const style = (String(d.outline || "").match(/STYLE:([^\s]+)/) || [])[1] || "";
  return { params, skills, summary: style.replace(/,/g, "・") };
}

// フタリソウサ: the sheet also holds the partner (d.partner); only the owner's character (d.base) is read.
// The scenarios played are the 捜査メモ lines that start with ▼ ("▼ここに堕天は完成される").
function as2s(d) {
  const b = d.base || {};
  const scenarios = String(d.investigation?.memo || "").split("\n").map(l => l.trim()).filter(l => /^[▼▽]/.test(l))
    .map(l => AS_CLEAN(l.replace(/^[▼▽]\s*/, ""))).filter(Boolean);
  const quirks = Object.entries(d.abnormal || {}).filter(([k, v]) => /^text\d$/.test(k) && AS_CLEAN(v))
    .sort().map(([k, v], i) => ({ label: `癖${i + 1}`, value: AS_CLEAN(v) }));
  return { params: quirks, skills: [], summary: [b.role, b.roleclass, b.background].map(AS_CLEAN).filter(Boolean).join("・"), stats: [], scenarios,
    notes: quirks.length ? "＜異常な癖＞\n" + quirks.map((q, i) => `${i + 1}：${q.value}`).join("\n") : "" };
}

function appspotToItem(sheet) {
  const d = sheet.data || {};
  const b = d.base || {};
  const url = `https://character-sheets.appspot.com/${sheet.system}/edit.html?key=${sheet.key}`;
  // N◎VA names carry the 二つ名 in quotes: 四藤 傑 "西の高校生探偵になれなかった男"
  const alias = (AS_CLEAN(b.name).match(/["“”『「]([^"“”』」]+)["“”』」]/) || [])[1] || "";
  const unquote = s => AS_CLEAN(String(s ?? "").replace(/["“”『「][^"“”』」]*["“”』」]/g, ""));
  const name = unquote(b.name) || AS_CLEAN(b.name);
  const extra = sheet.system === "tnx" ? asTnx(d) : sheet.system === "2s" ? as2s(d) : { params: [], skills: [], summary: "" };
  const profile = [
    ["PL", b.player], ["年齢", b.age], ["性別", b.sex], ["誕生日", b.birthday], ["出身", b.birth],
    ["身長", b.height], ["体重", b.weight], ["髪", b.hair], ["瞳", b.eyes], ["肌", b.skin],
    ["職業", b.job], ["雰囲気", b.atmosphere], ["好きなもの", b.like], ["嫌いなもの", b.dislike],
    ["パートナー", d.partner?.name && (() => { const r = [d.partner.role, d.partner.roleclass, d.partner.background].map(AS_CLEAN).filter(Boolean).join("・"); return AS_CLEAN(d.partner.name) + (r ? `（${r}）` : ""); })()],
  ].filter(([, v]) => AS_CLEAN(v)).map(([k, v]) => `${k}: ${AS_CLEAN(v)}`);
  const notes = [profile.join("\n"), String(b.memoir || "").trim(), String(b.memo || "").trim(), extra.notes || ""].filter(Boolean).join("\n\n");
  return {
    url, site: "キャラクターシート倉庫",
    name, ruby: unquote(b.nameKana),
    system: sheet.systemName || sheet.system,
    summary: [alias && `“${alias}”`, extra.summary || AS_CLEAN(d.outline)].filter(Boolean).join(" "),
    tags: extra.scenarios || [], notes, skills: extra.skills, image: sheet.image || "", ...(extra.stats ? { stats: extra.stats } : {}),
    ccfolia: {
      kind: "character",
      data: { name, memo: "", initiative: 0, externalUrl: url, status: [], params: extra.params, commands: "" },
    },
  };
}

if (typeof module !== "undefined") module.exports = { appspotToItem };
