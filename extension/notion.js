// Saves character sheets to the Notion database. Used by the popup and by tools/migrate-to-notion.js.

const NOTION_DEFAULT_DB = "b47dc79665f54fdeb8df5e2afdb134a5";
const NOTION_API = (typeof process !== "undefined" && process.env.NOTION_API_BASE) || "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const NOTION_TEXT_LIMIT = 2000;
const NOTION_GAP_MS = 350;   // Notion allows about 3 requests per second
// Tags kept in the タグ multi-select; every other tag (scenario names, HO, …) goes into the シナリオ text,
// one per line, so the multi-select's option list stays small.
const NOTION_META_TAG = /^(?:[67]版|ロスト|.*コンバート|CoC転生|要確認)$/;
const notionCleanTag = t => String(t).replace(/,/g, "、").replace(/\s+/g, " ").trim().slice(0, 100);

const notionSleep = ms => new Promise(r => setTimeout(r, ms));

// A database URL or ID, as a 32-character ID.
function notionDbId(text) {
  const m = String(text || "").split("?")[0].replace(/-/g, "").match(/[0-9a-f]{32}/i);
  return m ? m[0] : "";
}

class NotionError extends Error {
  constructor(status, message) {
    super(status === 401 ? "Notionのトークンが正しくありません。"
      : status === 404 ? "データベースが見つかりません。Notionでデータベースに連携を接続してください。"
      : `Notionに保存できませんでした（${status}）: ${message}`);
    this.status = status;
    this.fatal = status === 401 || status === 403 || status === 404;
  }
}

async function notionRequest(token, path, body, method) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(NOTION_API + path, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: { "Authorization": "Bearer " + token, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status === 409 || res.status >= 500;
    if (!retryable || attempt >= 5) {
      const detail = await res.json().catch(() => ({}));
      throw new NotionError(res.status, detail.message || "");
    }
    const wait = Number(res.headers.get("Retry-After")) * 1000 || 800 * 2 ** attempt;
    await notionSleep(wait);
  }
}

// The sheets already in the database, by source URL: url -> { id, scenarios }.
// A sheet is "new" when its URL is not in this map.
async function notionExistingUrls(token, db) {
  const urls = new Map();
  let cursor;
  do {
    const r = await notionRequest(token, `/databases/${db}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    for (const page of r.results) {
      const u = page.properties?.["元シート"]?.url;
      const text = (page.properties?.["シナリオ"]?.rich_text || []).map(t => t.plain_text ?? t.text?.content ?? "").join("");
      if (u) urls.set(u, { id: page.id, scenarios: text.split("\n").map(l => l.trim()).filter(Boolean) });
    }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return urls;
}

// Scenario lines. "シナリオ名HO2" is a scenario and its HO; a line that is only "HO4" is the HO
// of the line before it (いあきゃら tags are split at spaces, so "VOID HO4" arrives as two).
// "HO" followed by a number, a symbol or a Japanese word: "HO2", "HO-β", "HO探偵" (not the HO of
// SHOTGUN or ECHO).
const NOTION_HO = /H[OＯ](?=[0-9０-９:：\-－α-ωΑ-Ω\u3040-\u30ff\u3400-\u9fff\uff10-\uff19])/;
function notionSplitHo(line) {
  const t = String(line);
  const m = t.match(NOTION_HO);
  return m ? [t.slice(0, m.index).trim(), t.slice(m.index)] : [t.trim(), ""];
}
// Compared without spaces, punctuation, brackets, readings in parentheses and kana/width differences.
const notionScenarioKey = t => String(t).normalize("NFKC").toLowerCase()
  .replace(/[(（][^()（）]*[)）]/g, "")
  .replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60))
  .replace(/[\s「」『』【】\[\]"'“”・:：;；\-－―~〜、。,.!！?？…‥♪☆★]+/g, "");
function notionEditDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
// Same scenario: the names (without the HO) match, or differ by a typo (one letter in names of
// 5 or more, two in 12 or more). Names that differ only in numbers are different episodes.
function notionSameScenario(a, b) {
  const x = notionScenarioKey(notionSplitHo(a)[0]), y = notionScenarioKey(notionSplitHo(b)[0]);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.replace(/\d+/g, "") === y.replace(/\d+/g, "")) return false;
  const n = Math.min(x.length, y.length);
  return n >= 5 && notionEditDistance(x, y) <= (n >= 12 ? 2 : 1);
}
// Two HOs agree when either is missing or one starts with the other ("HO1" and "HO1生還").
function notionSameHo(a, b) {
  const x = notionScenarioKey(notionSplitHo(a)[1]), y = notionScenarioKey(notionSplitHo(b)[1]);
  return !x || !y || x.startsWith(y) || y.startsWith(x);
}
// Joins lone "HO…" lines to the line before ("VOID" + "HO4" -> "VOIDHO4"); a lone HO equal to
// the one already on that line is dropped.
function notionJoinHo(lines) {
  const out = [];
  for (const raw of lines) {
    const t = String(raw).trim();
    if (!t) continue;
    if (out.length && NOTION_HO.test(t) && !notionSplitHo(t)[0]) {
      const prev = out[out.length - 1];
      const [base, ho] = notionSplitHo(prev);
      if (base && !ho) { out[out.length - 1] = base + t; continue; }
      if (notionScenarioKey(ho) === notionScenarioKey(t)) continue;
    }
    out.push(t);
  }
  return out;
}
// The scenario lines written on the sheet (tags) with the passed scenarios added. Written lines
// win: a passed scenario already there (in any spelling, with any HO) is not added again, and
// only gives its HO (or its full name) to a written line that lacks it. Written lines drop only repeats of themselves
// (same scenario and the same HO); the same scenario with two HOs stays.
function notionMergeScenarios(have, add = []) {
  const out = [];
  for (const t of notionJoinHo(have)) {
    if (!notionScenarioKey(t)) continue;
    const at = out.findIndex(o => notionSameScenario(o, t) && notionSameHo(o, t));
    if (at < 0) { out.push(t); continue; }
    const [base, ho] = notionSplitHo(out[at]);
    if (!ho && notionSplitHo(t)[1]) out[at] = base + notionSplitHo(t)[1];
  }
  const written = out.length;
  const adds = notionJoinHo(add).filter(t => notionScenarioKey(t));
  // A written short name ("ループ橋") stands for the one passed scenario whose name contains it
  // ("ループ橋でなにかが…"): that full name takes its place, keeping the written HO.
  const baseKey = t => notionScenarioKey(notionSplitHo(t)[0]);
  // "よむとてとKPC" is the same scenario run as the KPC, not a fuller name of "よむとてと".
  const isKpcOf = (t, k) => baseKey(t) === k + "kpc";
  const used = new Set();
  for (let i = 0; i < written; i++) {
    const k = baseKey(out[i]);
    if (k.length < 2 || adds.some(t => notionSameScenario(out[i], t))) continue;
    // A name with a subtitle ("爛爛-二人のための間奏曲-") is a sequel, not the full name.
    const longer = adds.filter(t => isKpcOf(t, k) || (baseKey(t).includes(k) && !/[-－―～〜:：〈《]/.test(notionSplitHo(t)[0].normalize("NFKC"))));
    // A series name without an HO ("TRASH") gives way to its episodes ("TRASH1", "TRASH2").
    if (longer.length > 1 && !notionSplitHo(out[i])[1]) { out[i] = ""; continue; }
    if (longer.length !== 1 || used.has(longer[0])) continue;
    const [base, ho] = notionSplitHo(longer[0]);
    out[i] = base + (notionSplitHo(out[i])[1] || ho);
    used.add(longer[0]);
  }
  for (let i = out.length - 1; i >= 0; i--) if (!out[i]) out.splice(i, 1);
  for (const t of adds) {
    if (used.has(t)) continue;
    // Already written out in more detail ("星原にて" in "星原にて、僕は君と踊る夢を見るKPC").
    const k = baseKey(t);
    // Kept when the same list also has it as the KPC: two sessions, one as a player and one as the KPC.
    const alsoKpc = adds.some(a => isKpcOf(a, k));
    if (k.length >= 2 && out.some(o => baseKey(o).length > k.length && baseKey(o).includes(k) && !(alsoKpc && isKpcOf(o, k)))) continue;
    const at = out.findIndex(o => notionSameScenario(o, t));
    if (at < 0) {
      // "XKPC" marks the written "X" (even spelled a little differently) as run by the KPC,
      // unless the list also has "X" as a session of its own.
      const plain = /KPC$/i.test(t) ? t.replace(/\s*KPC$/i, "") : "";
      const j = plain && !adds.some(a => baseKey(a) === baseKey(plain))
        ? out.findIndex(o => !/KPC$/i.test(o) && !notionSplitHo(o)[1] && notionSameScenario(o, plain)) : -1;
      if (j >= 0) out[j] += "KPC"; else out.push(t);
      continue;
    }
    const [base, ho] = notionSplitHo(out[at]);
    if (!ho && notionSplitHo(t)[1]) out[at] = base + notionSplitHo(t)[1];
  }
  return out;
}
// A passed scenario and its memo -> "シナリオ名HO2" when the memo names one HO and only one
// ("HO2", "HO：探偵", "HO異邦人"), or "シナリオ名KPC" when a memo line says "KPC". A memo that
// mentions several HOs is not used.
function notionScenarioWithHo(name, memo) {
  name = String(name || "").trim();
  if (!name || NOTION_HO.test(name)) return name;
  // NFKC so a full-width "ＨＯ" counts too; "HO「三根春花（みつねはるか）について」" gives 三根春花.
  // A line that is only an HO followed by a sheet link ("HO2" then "https://iachara.com/view/…")
  // names the other player's character, so it is left out.
  const lines = String(memo || "").normalize("NFKC").split("\n");
  // A memo line that is only "KPC" (or "KPCとして") means the character was the KPC: "シナリオ名KPC".
  if (lines.some(l => /^\s*KPC(として)?\s*$/i.test(l))) return /KPC$/i.test(name) ? name : `${name}KPC`;
  const isLink = l => /^\s*https?:\/\//.test(l || "");
  const nextLine = i => lines.slice(i + 1).find(l => l.trim());
  const text = lines.filter((l, i) => !(/^\s*HO\s*[:\-]?\s*\S{0,12}\s*(https?:\/\/\S+\s*)?$/i.test(l) && (/https?:\/\//.test(l) || isLink(nextLine(i)))))
    .join("\n").replace(/https?:\/\/\S+/g, " ");
  const found = [...text.matchAll(/(?<![A-Za-z])HO\s*[:\-]?\s*[「『]?\s*([0-9A-Za-zα-ωΑ-Ωァ-ヶー一-龥]{1,12})/gi)].map(m => m[1]);
  return new Set(found).size === 1 ? `${name}HO${found[0]}` : name;
}
// The record's scenario lines: its tags other than the edition and similar marks, then the
// passed scenarios read from the sheet.
function notionScenarios(r) {
  const clean = list => (list || []).map(notionCleanTag).filter(t => t && t !== "ロスト" && !NOTION_META_TAG.test(t));
  return notionMergeScenarios(clean(r.tags), clean(r.passed));
}

// The extension's item format -> the record saved to Notion.
function notionRecordFromItem(item) {
  const d = item.ccfolia?.data || {};
  const tags = item.tags || [];
  return {
    name: item.name || d.name || "", ruby: item.ruby || "", system: item.system || "", site: item.site || "",
    summary: item.summary || "", tags, passed: item.passed || [], lost: tags.includes("ロスト"), url: item.url || d.externalUrl || "",
    resources: (d.status || []).map(s => ({ label: s.label, cur: s.value, max: s.max })),
    image: item.image || d.iconUrl || "",
    stats: item.stats || d.params || [], skills: item.skills || [], notes: item.notes || d.memo || "", palette: d.commands || "",
  };
}

// A document from the old sheet book -> the record saved to Notion.
function notionRecordFromDoc(doc) {
  const tags = doc.tags || [];
  return {
    name: doc.name || "", ruby: doc.ruby || "", system: doc.system || "", site: doc.sourceSite || "",
    summary: doc.summary || "", tags, lost: tags.includes("ロスト"), url: doc.sourceUrl || "",
    resources: doc.resources || [], stats: doc.stats || [], skills: doc.skills || [],
    notes: doc.notes || "", palette: doc.palette || "",
  };
}

function notionChunks(text, size = NOTION_TEXT_LIMIT) {
  const chars = [...String(text || "")];   // never split a surrogate pair
  const out = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out;
}
const notionRich = text => notionChunks(text).map(content => ({ type: "text", text: { content } }));

function notionProperties(r) {
  const res = label => r.resources.find(x => x.label === label);
  const num = v => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const select = v => (v ? { select: { name: String(v).replace(/,/g, "、").slice(0, 100) } } : undefined);
  const others = r.resources.filter(x => !["HP", "MP", "SAN"].includes(x.label)).map(x => `${x.label} ${x.cur}`);
  const all = [...new Set(r.tags.filter(t => t !== "ロスト").map(notionCleanTag).filter(Boolean))];
  const tags = all.filter(t => NOTION_META_TAG.test(t));
  const scenarios = notionScenarios(r);
  const props = {
    "名前": { title: notionRich(r.name || "名無し") },
    "ふりがな": { rich_text: notionRich(r.ruby) },
    "状態": { select: { name: r.lost ? "ロスト" : "生存" } },
    "システム": select(r.system),
    "サイト": select(r.site),
    "概要": { rich_text: notionRich(r.summary) },
    "タグ": { multi_select: tags.map(name => ({ name })) },
    "シナリオ": { rich_text: notionRich(scenarios.join("\n")) },
    "能力値": { rich_text: notionRich([...r.stats.map(s => `${s.label} ${s.value}`), ...others].join(" / ")) },
    "技能": { rich_text: notionRich(r.skills.map(s => `${s.label}${s.value}`).join(" / ")) },
    "元シート": { url: r.url || null },
    "立ち絵": { url: r.image || null },
  };
  for (const label of ["HP", "MP", "SAN"]) {
    const x = res(label);
    props[label] = { number: x ? num(x.cur) : null };
    props[label + "最大"] = { number: x ? num(x.max) : null };
  }
  for (const k of Object.keys(props)) if (props[k] === undefined) delete props[k];
  return props;
}

function notionCcfolia(r) {
  return JSON.stringify({ kind: "character", data: {
    name: r.name, memo: "", initiative: 0, externalUrl: r.url, iconUrl: r.image || null,
    status: r.resources.map(x => ({ label: x.label, value: Number(x.cur) || 0, max: Number(x.max) || 0 })),
    params: r.stats.map(s => ({ label: s.label, value: String(s.value) })),
    commands: r.palette,   // no CoC-style fallback: other systems roll differently
  } });
}

function notionBlocks(r) {
  const heading = text => ({ object: "block", type: "heading_2", heading_2: { rich_text: notionRich(text) } });
  const code = (text, language) => ({ object: "block", type: "code", code: { language, rich_text: notionRich(text) } });
  const blocks = [];
  if (r.notes) {
    const paragraphs = String(r.notes).split(/\n{2,}/).filter(p => p.trim());
    // A request takes at most 100 blocks; a very fragmented memo goes into one paragraph.
    const parts = paragraphs.length > 90 ? [r.notes] : paragraphs;
    blocks.push(heading("メモ"), ...parts.map(p => ({ object: "block", type: "paragraph", paragraph: { rich_text: notionRich(p) } })));
  }
  if (r.palette) blocks.push(heading("チャットパレット"), code(r.palette, "plain text"));
  if (r.resources.length || r.stats.length) blocks.push(heading("ココフォリア駒（追加した時点の値）"), code(notionCcfolia(r), "json"));
  return blocks;
}

async function notionCreateSheet(token, db, record) {
  return notionRequest(token, "/pages", {
    parent: { database_id: db },
    properties: notionProperties(record),
    children: notionBlocks(record),
  });
}

// Adds only the records whose URL is not yet in the database. Safe to run again after an interruption.
// A sheet already there only gets the scenarios (passed scenarios, scenario tags) it is missing;
// nothing else on its page changes.
async function notionAddNew(token, db, records, onProgress = () => {}) {
  const existing = await notionExistingUrls(token, db);
  const fresh = records.filter(r => !r.url || !existing.has(r.url));
  const result = { total: records.length, skipped: records.length - fresh.length, added: 0, updated: 0, failed: [], stopped: null };
  for (const record of records.filter(r => r.url && existing.has(r.url))) {
    const page = existing.get(record.url);
    const merged = notionMergeScenarios(page.scenarios, notionScenarios(record));   // what is in Notion wins
    if (merged.join("\n") === page.scenarios.join("\n")) continue;
    try {
      await notionRequest(token, `/pages/${page.id}`, { properties: { "シナリオ": { rich_text: notionRich(merged.join("\n")) } } }, "PATCH");
      result.updated++;
    } catch (e) {
      if (e.fatal) { result.stopped = e.message; return result; }
      result.failed.push({ name: record.name, url: record.url, message: e.message });
    }
    await notionSleep(NOTION_GAP_MS);
  }
  for (const record of fresh) {
    try {
      await notionCreateSheet(token, db, record);
      result.added++;
    } catch (e) {
      if (e.fatal) { result.stopped = e.message; break; }
      result.failed.push({ name: record.name, url: record.url, message: e.message });
    }
    onProgress(result.added + result.failed.length, fresh.length);
    await notionSleep(NOTION_GAP_MS);
  }
  return result;
}

if (typeof module !== "undefined") {
  module.exports = { NOTION_DEFAULT_DB, NOTION_GAP_MS, NOTION_META_TAG, notionCleanTag, notionRequest, notionSleep, notionDbId, notionExistingUrls, notionMergeScenarios, notionScenarios, notionScenarioWithHo, notionScenarioKey, notionSplitHo, notionRecordFromItem, notionRecordFromDoc, notionProperties, notionBlocks, notionAddNew };
}
