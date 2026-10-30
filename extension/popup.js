const DEFAULT_BOOK = "https://claude.ai/artifact/UFcoUM4QKeEcBXE55RigXo";
const SITES = {
  "iachara.com": "いあきゃら",
  "yutorize.work": "ゆとシート",
  "yutorize.2-d.jp": "ゆとシート",
  "charasheet.vampire-blood.net": "キャラクター保管所",
};

const $ = id => document.getElementById(id);
let found = { url: "", site: "", ccfolia: null };

// Runs inside the sheet page: collects the URL, title, and any CCFolia piece data shown on the page.
function grabFromPage() {
  const isPiece = t => { try { const o = JSON.parse(t); return o && o.kind === "character" && o.data ? o : null; } catch { return null; } };
  let ccfolia = null;
  for (const el of document.querySelectorAll("textarea, pre, code, input[type=hidden], input[type=text]")) {
    const t = (el.value ?? el.textContent ?? "").trim();
    if (t.startsWith("{") && t.includes('"kind"')) { ccfolia = isPiece(t); if (ccfolia) break; }
  }
  const og = document.querySelector('meta[property="og:title"]')?.content || "";
  return { url: location.href, title: document.title, ogTitle: og, ccfolia };
}

function cleanTitle(t) {
  return String(t || "").split(/\s+[-|｜–—]\s+|｜/)[0].replace(/^(キャラクター|キャラ)(シート)?[:：]\s*/, "").trim();
}

function siteName(u) {
  try { const h = new URL(u).hostname.replace(/^www\./, ""); return SITES[h] || h; } catch { return ""; }
}

async function readClipboardPiece() {
  try {
    const t = (await navigator.clipboard.readText()).trim();
    const o = JSON.parse(t);
    return o && o.kind === "character" && o.data ? o : null;
  } catch { return null; }
}

function bundle() {
  return JSON.stringify({
    kind: "charsheet-bridge", version: 1,
    url: found.url, site: found.site, name: $("name").value.trim(),
    ccfolia: found.ccfolia, sentAt: new Date().toISOString(),
  });
}

async function copyBundle() {
  await navigator.clipboard.writeText(bundle());
}

async function init() {
  const { book } = await chrome.storage.local.get("book");
  $("book").value = book || DEFAULT_BOOK;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let page = { url: tab?.url || "", title: tab?.title || "", ogTitle: "", ccfolia: null };
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: grabFromPage });
    if (res?.result) page = res.result;
  } catch { /* chrome:// pages and the Web Store refuse scripts; fall back to the tab title */ }

  found.url = page.url;
  found.site = siteName(page.url);
  $("site").textContent = `${found.site || "このページ"} — ${page.url}`;

  let source = "";
  if (page.ccfolia) { found.ccfolia = page.ccfolia; source = "ページ"; }
  else {
    const clip = await readClipboardPiece();
    if (clip) { found.ccfolia = clip; source = "クリップボード"; }
  }
  $("name").value = found.ccfolia?.data?.name || cleanTitle(page.ogTitle || page.title);

  const st = $("status");
  if (found.ccfolia) {
    const d = found.ccfolia.data;
    st.className = "st ok";
    st.textContent = `能力値データあり（${source}から取得）: ステータス${(d.status || []).length}件・パラメータ${(d.params || []).length}件${d.commands ? "・チャットパレットあり" : ""}`;
  } else {
    st.className = "st warn";
    st.textContent = "能力値データが見つかりません。名前とURLだけ送ります。サイトの「ココフォリア出力」ボタンでコピーしてから、もう一度この画面を開くと能力値も送れます。";
  }
}

$("send").addEventListener("click", async () => {
  try {
    await copyBundle();
    const { book } = await chrome.storage.local.get("book");
    await chrome.tabs.create({ url: book || DEFAULT_BOOK });
  } catch (e) { $("msg").textContent = "コピーできませんでした: " + e.message; }
});
$("copy").addEventListener("click", async () => {
  try { await copyBundle(); $("msg").textContent = "コピーしました。シート帳で ⌘V を押すと取り込めます。"; }
  catch (e) { $("msg").textContent = "コピーできませんでした: " + e.message; }
});
$("saveBook").addEventListener("click", async () => {
  await chrome.storage.local.set({ book: $("book").value.trim() });
  $("msg").textContent = "シート帳のURLを保存しました。";
});

init();
