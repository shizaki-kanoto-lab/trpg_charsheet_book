const DEFAULT_BOOK = "https://claude.ai/artifact/UFcoUM4QKeEcBXE55RigXo";
const SITES = {
  "iachara.com": "いあきゃら",
  "yutorize.work": "ゆとシート",
  "yutorize.2-d.jp": "ゆとシート",
  "charasheet.vampire-blood.net": "キャラクター保管所",
  "charash.jp": "キャラッシュ",
  "vinsanet.com": "vinsanet",
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

// Sites whose whole character list the extension can read with the visitor's login.
const BULK_SITES = [
  { name: "いあきゃら", host: /^https:\/\/iachara\.com\//, sheet: /^https:\/\/iachara\.com\/(?:view|edit)\/(\d+)/,
    fetch: iacharaFetchSheets, convert: iacharaToItem, ok: s => !!s?.data },
  { name: "キャラッシュ", host: /^https:\/\/charash\.jp\//, sheet: /^https:\/\/charash\.jp\/(?:view|edit)\/([A-Za-z0-9_-]{12})/,
    fetch: charashFetchSheets, convert: charashToItem, ok: s => !!s?.data },
  { name: "vinsanet", host: /^https:\/\/vinsanet\.com\//, sheet: /^https:\/\/vinsanet\.com\/characters\/([A-Za-z0-9_-]{21})/,
    fetch: vinsanetFetchSheets, convert: vinsanetToItem, ok: s => !!s?.data,
    errors: { "open-mypage": "全キャラを送るときは vinsanet のマイページ（https://vinsanet.com/mypage）を開いてから押してください。" } },
];

async function initBulk(tab, site) {
  const m = tab.url.match(site.sheet);
  setStatus("", `${site.name}からシートを読み込んでいます…`);
  const call = async arg => {
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: site.fetch, args: [arg] });
      return res?.result;
    } catch (e) { return { error: e.message }; }
  };
  const r = await call(null);

  if (r?.sheets?.length) {
    iaAll = r.sheets.filter(site.ok).map(site.convert);
    $("allSite").textContent = site.name;
    $("allCount").textContent = iaAll.length;
    $("allBox").hidden = false;
  }

  let one = m && iaAll?.find(i => i.url.split("/").includes(m[1]));
  if (m && !one) {
    // Someone else's public sheet: ask for that one directly.
    const r1 = await call(m[1]);
    const s = r1?.sheets?.[0];
    if (site.ok(s)) one = site.convert(s);
  }

  if (one) {
    items = [one];
    $("name").value = one.name;
    $("single").hidden = false;
    const d = one.ccfolia?.data;
    setStatus(d ? "ok" : "warn", d
      ? `${one.system}: ステータス${d.status.length}件・能力値${d.params.length}件・技能${one.skills.length}件`
      : `${one.system}: このシステムの能力値はまだ読み取れません。名前・URL・プロフィールを送ります。`);
  } else if (iaAll) {
    setStatus("ok", `下のボタンで、${site.name}の自分のキャラをまとめて送れます。1人だけ送るときはそのシートを開いてください。`);
  } else {
    setStatus("warn", site.errors?.[r?.error] ? site.errors[r.error] : r?.error === "not-logged-in"
      ? `${site.name}にログインしていません。ログインしてから、もう一度この画面を開いてください。`
      : `${site.name}から読み込めませんでした（${r?.error || "不明"}）。ページを再読み込みしてから試してください。`);
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
  const site = BULK_SITES.find(s => s.host.test(tab?.url || ""));
  if (site) await initBulk(tab, site);
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
