// vinsanet (Kutulu): reads sheets through vinsanet's public API (/api/v1/characters/{id})
// and converts them into the sheet book's import format.

// Runs inside the vinsanet page (MAIN world). The character list on /mypage has no links,
// so the IDs are collected by catching where each 「閲覧」 button would navigate, without navigating.
async function vinsanetFetchSheets(onlyId) {
  let ids = onlyId ? [onlyId] : null;
  if (!ids) {
    if (location.pathname !== "/mypage") return { error: "open-mypage" };
    const router = document.querySelector("#app")?.__vue_app__?.config?.globalProperties?.$router;
    if (!router) return { error: "no-router" };
    const caught = [];
    const orig = router.push;
    router.push = loc => { caught.push(typeof loc === "string" ? loc : loc?.path || ""); return Promise.resolve(); };
    try {
      for (const b of document.querySelectorAll("button")) if (b.textContent.trim() === "閲覧") b.click();
      await new Promise(r => setTimeout(r, 300));
    } finally { router.push = orig; }
    ids = [...new Set(caught.map(p => (p.match(/\/characters\/([A-Za-z0-9_-]{21})/) || [])[1]).filter(Boolean))];
    if (!ids.length) return { error: "not-logged-in" };
  }
  const sheets = [];
  for (const id of ids) {
    const r = await fetch("/api/v1/characters/" + id);
    if (!r.ok) continue;
    sheets.push({ id, data: await r.json(), image: await vinsanetImage(id) });
  }
  return { sheets };
}

// The character image is named only in the view page's og:image, as a signed URL that expires.
// The same file is public through Firebase Storage without a signature.
async function vinsanetImage(id) {
  try {
    const html = await (await fetch(`/characters/${id}/view`)).text();
    const m = html.match(/og:image"\s+content="https:\/\/storage\.googleapis\.com\/([^/"]+)\/(characters\/[^?"]+)/);
    return m ? `https://firebasestorage.googleapis.com/v0/b/${m[1]}/o/${encodeURIComponent(m[2])}?alt=media` : "";
  } catch { return ""; }
}

function vinsanetToItem(sheet) {
  const d = sheet.data || {};
  const url = `https://vinsanet.com/characters/${sheet.id}/view`;
  const rule = d.rule && d.rule !== "基本ルール" ? d.rule : "";   // a rulebook, not a scenario: kept in the notes
  const profile = [
    ["ルール", rule], ["肩書き", d.title], ["年齢", d.age], ["性別", d.gender], ["職業", d.profession],
    ["出身", d.home], ["階級", d.rank], ["家庭", d.family],
  ].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  // メモ欄: only the first one, about the character. The rest are usually the scenarios' recruiting
  // posts (trailers, play time and the like), not the character.
  const remarks = (d.remarks || []).filter(r => r.body).slice(0, 1).map(r => (r.title ? `【${r.title}】\n` : "") + r.body);
  const base = (d.skills || []).map(s => ({ label: String(s.name), value: String(Number(s.value) || 0) }));
  const specialities = (d.specialities || []).filter(s => Number(s.value) > 0)
    .map(s => ({ label: String(s.name), value: String(Number(s.value)) }));
  return {
    url, site: "vinsanet", image: sheet.image || "",
    name: d.name || "", ruby: d.kana || "",
    system: "Kutulu",
    summary: d.title || d.profession || "",
    tags: [...(d.tags || []), d.isLost ? "ロスト" : ""].filter(Boolean),
    notes: [profile.join("\n"), ...remarks].filter(Boolean).join("\n\n"),
    skills: specialities,
    ccfolia: {
      kind: "character",
      data: {
        name: d.name || "", memo: "", initiative: 0, externalUrl: url,
        status: [],
        params: [...base, { label: "負傷", value: String(Number(d.injury) || 0) }],
        commands: "",
      },
    },
  };
}

if (typeof module !== "undefined") module.exports = { vinsanetToItem };
