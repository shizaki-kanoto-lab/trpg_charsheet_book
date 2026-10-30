const DEFAULT_BOOK = "https://claude.ai/artifact/UFcoUM4QKeEcBXE55RigXo";
const SITES = {
  "iachara.com": "いあきゃら",
  "yutorize.work": "ゆとシート",
  "yutorize.2-d.jp": "ゆとシート",
  "charasheet.vampire-blood.net": "キャラクター保管所",
};

const $ = id => document.getElementById(id);
let items = [];      // what this popup will send (one sheet, or every iachara sheet)
let iaAll = null;    // every iachara sheet, when the visitor is logged in

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

function setStatus(kind, text) { const st = $("status"); st.className = "st " + kind; st.textContent = text; }

async function copyBundle(list) {
  if (list.length === 1) list[0].name = $("name").value.trim() || list[0].name;
  await navigator.clipboard.writeText(JSON.stringify({ kind: "charsheet-bridge", version: 2, items: list, sentAt: new Date().toISOString() }));
}

async function openBook() {
  const { book } = await chrome.storage.local.get("book");
  await chrome.tabs.create({ url: book || DEFAULT_BOOK });
}

async function initIachara(tab) {
  const m = tab.url.match(/^https:\/\/iachara\.com\/(?:view|edit)\/(\d+)/);
  setStatus("", "いあきゃらからシートを読み込んでいます…");
  let r;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: iacharaFetchSheets, args: [null] });
    r = res?.result;
  } catch (e) { r = { error: e.message }; }

  if (r?.sheets) {
    iaAll = r.sheets.map(iacharaToItem);
    $("allCount").textContent = iaAll.length;
    $("allBox").hidden = false;
  }

  let one = m && iaAll?.find(i => i.url.endsWith("/" + m[1]));
  if (m && !one) {
    // Someone else's public sheet: ask for that one directly.
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: iacharaFetchSheets, args: [m[1]] });
      if (res?.result?.sheets?.[0]?.data) one = iacharaToItem(res.result.sheets[0]);
    } catch { /* falls through to the message below */ }
  }

  if (one) {
    items = [one];
    $("name").value = one.name;
    $("single").hidden = false;
    const d = one.ccfolia.data;
    setStatus("ok", `${one.system}: ステータス${d.status.length}件・能力値${d.params.length}件・技能${one.skills.length}件`);
  } else if (iaAll) {
    setStatus("ok", "下のボタンで、いあきゃらの自分のキャラをまとめて送れます。1人だけ送るときはそのシートを開いてください。");
  } else {
    setStatus("warn", r?.error === "not-logged-in"
      ? "いあきゃらにログインしていません。ログインしてから、もう一度この画面を開いてください。"
      : `いあきゃらから読み込めませんでした（${r?.error || "不明"}）。ページを再読み込みしてから試してください。`);
  }
}

async function initOther(tab) {
  let page = { url: tab?.url || "", title: tab?.title || "", ogTitle: "", ccfolia: null };
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: grabFromPage });
    if (res?.result) page = res.result;
  } catch { /* chrome:// pages and the Web Store refuse scripts; fall back to the tab title */ }

  let ccfolia = page.ccfolia, source = ccfolia ? "ページ" : "";
  if (!ccfolia) { ccfolia = await readClipboardPiece(); if (ccfolia) source = "クリップボード"; }
  const url = page.url;
  items = [{ url, site: siteName(url), name: ccfolia?.data?.name || cleanTitle(page.ogTitle || page.title), ccfolia }];
  $("name").value = items[0].name;
  $("single").hidden = false;

  if (ccfolia) {
    const d = ccfolia.data;
    setStatus("ok", `能力値データあり（${source}から取得）: ステータス${(d.status || []).length}件・パラメータ${(d.params || []).length}件${d.commands ? "・チャットパレットあり" : ""}`);
  } else {
    setStatus("warn", "能力値データが見つかりません。名前とURLだけ送ります。サイトの「ココフォリア出力」ボタンでコピーしてから、もう一度この画面を開くと能力値も送れます。");
  }
}

async function init() {
  const { book } = await chrome.storage.local.get("book");
  $("book").value = book || DEFAULT_BOOK;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $("site").textContent = `${siteName(tab?.url) || "このページ"} — ${tab?.url || ""}`;
  if (/^https:\/\/iachara\.com\//.test(tab?.url || "")) await initIachara(tab);
  else await initOther(tab);
}

const run = async (list, andOpen) => {
  try {
    await copyBundle(list);
    if (andOpen) await openBook();
    else $("msg").textContent = "コピーしました。シート帳で ⌘V を押すと取り込めます。";
  } catch (e) { $("msg").textContent = "コピーできませんでした: " + e.message; }
};
$("send").addEventListener("click", () => run(items, true));
$("copy").addEventListener("click", () => run(items, false));
$("sendAll").addEventListener("click", () => run(iaAll, true));
$("saveBook").addEventListener("click", async () => {
  await chrome.storage.local.set({ book: $("book").value.trim() });
  $("msg").textContent = "シート帳のURLを保存しました。";
});

init();
