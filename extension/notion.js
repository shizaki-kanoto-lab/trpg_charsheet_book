// Saves character sheets to the Notion database. Used by the popup and by tools/migrate-to-notion.js.

const NOTION_DEFAULT_DB = "b47dc79665f54fdeb8df5e2afdb134a5";
const NOTION_API = (typeof process !== "undefined" && process.env.NOTION_API_BASE) || "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const NOTION_TEXT_LIMIT = 2000;
const NOTION_GAP_MS = 350;   // Notion allows about 3 requests per second

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

// The source URLs already in the database. A sheet is "new" when its URL is not in this set.
async function notionExistingUrls(token, db) {
  const urls = new Set();
  let cursor;
  do {
    const r = await notionRequest(token, `/databases/${db}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    for (const page of r.results) { const u = page.properties?.["元シート"]?.url; if (u) urls.add(u); }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return urls;
}

// The extension's item format -> the record saved to Notion.
function notionRecordFromItem(item) {
  const d = item.ccfolia?.data || {};
  const tags = item.tags || [];
  return {
    name: item.name || d.name || "", ruby: item.ruby || "", system: item.system || "", site: item.site || "",
    summary: item.summary || "", tags, lost: tags.includes("ロスト"), url: item.url || d.externalUrl || "",
    resources: (d.status || []).map(s => ({ label: s.label, cur: s.value, max: s.max })),
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
  const tags = [...new Set(r.tags.filter(t => t !== "ロスト").map(t => String(t).replace(/,/g, "、").trim().slice(0, 100)).filter(Boolean))];
  const props = {
    "名前": { title: notionRich(r.name || "名無し") },
    "ふりがな": { rich_text: notionRich(r.ruby) },
    "状態": { select: { name: r.lost ? "ロスト" : "生存" } },
    "システム": select(r.system),
    "サイト": select(r.site),
    "概要": { rich_text: notionRich(r.summary) },
    "タグ": { multi_select: tags.map(name => ({ name })) },
    "能力値": { rich_text: notionRich([...r.stats.map(s => `${s.label} ${s.value}`), ...others].join(" / ")) },
    "技能": { rich_text: notionRich(r.skills.map(s => `${s.label}${s.value}`).join(" / ")) },
    "元シート": { url: r.url || null },
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
    name: r.name, memo: "", initiative: 0, externalUrl: r.url,
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
async function notionAddNew(token, db, records, onProgress = () => {}) {
  const existing = await notionExistingUrls(token, db);
  const fresh = records.filter(r => !r.url || !existing.has(r.url));
  const result = { total: records.length, skipped: records.length - fresh.length, added: 0, failed: [], stopped: null };
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
  module.exports = { NOTION_DEFAULT_DB, NOTION_GAP_MS, notionRequest, notionSleep, notionDbId, notionExistingUrls, notionRecordFromItem, notionRecordFromDoc, notionProperties, notionBlocks, notionAddNew };
}
