const SITES = {
  "iachara.com": "いあきゃら",
  "yutorize.work": "ゆとシート",
  "yutorize.2-d.jp": "ゆとシート",
  "charasheet.vampire-blood.net": "キャラクター保管所",
  "charash.jp": "キャラッシュ",
  "vinsanet.com": "vinsanet",
  "character-sheets.appspot.com": "キャラクターシート倉庫",
  "docs.google.com": "Googleスプレッドシート",
};

const $ = id => document.getElementById(id);
let items = [];      // the single sheet this popup can add
let iaAll = null;    // every sheet on the site, when the visitor is logged in
let bulkSite = "";   // the site iaAll was read from ("キャラッシュ")
// One button: on a sheet page it sends that sheet, on any other page of the site (the list) every sheet.
let bulkMode = false;
let notion = { token: "", db: NOTION_DEFAULT_DB };

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

function setMsg(text, isError) { const m = $("msg"); m.className = "msg" + (isError ? " err" : ""); m.textContent = text; }

async function loadSettings() {
  const { notionToken, notionDb } = await chrome.storage.local.get(["notionToken", "notionDb"]);
  notion = { token: notionToken || "", db: notionDbId(notionDb) || NOTION_DEFAULT_DB };
  $("token").value = notion.token;
  $("db").value = "https://www.notion.so/" + notion.db;
  if (!notion.token) { $("settings").open = true; setMsg("Notionのトークンを設定に入力してください。", true); }
}

// The button labels never change after the popup opens; what a press will do (add a new sheet,
// or fill in the シナリオ欄 of one already added) is said in the message line instead.
async function showAllCount() {
  if (!notion.token || (!iaAll && !items[0]?.url)) return;
  try {
    const existing = showAllCount.cache ||= await notionExistingUrls(notion.token, notion.db);
    if (bulkMode) {
      const fresh = iaAll.filter(i => !existing.has(i.url)).length;
      $("sendAll").disabled = false;
      setMsg(`全${iaAll.length}人（新規 ${fresh}人・追加済み ${iaAll.length - fresh}人）\n新規は追加し、追加済みはシナリオ欄に追記します。`);
    } else if (items[0]?.url) {
      $("send").disabled = false;
      setMsg(existing.has(items[0].url) ? "シート帳に追加済みです。送るとシナリオ欄に追記します。" : "シート帳にまだありません。送ると追加します。");
    }
  } catch (e) { setMsg(e.message, true); }
}

async function send(list) {
  if (!notion.token) { $("settings").open = true; setMsg("Notionのトークンを設定に入力してください。", true); return; }
  $("send").disabled = $("sendAll").disabled = true;
  setMsg("Notionに保存しています…");
  try {
    const r = await notionAddNew(notion.token, notion.db, list.map(notionRecordFromItem), (done, total) =>
      setMsg(`${done} / ${total} 人を保存しました…\nこの画面を閉じると止まります。もう一度押せば続きから追加します。`));
    const parts = [`${r.added}人を追加しました`, r.updated ? `追加済みの${r.updated}人にシナリオを追記しました` : "",
      r.skipped - r.updated > 0 ? `追加済みの${r.skipped - r.updated}人はそのままです` : "", r.failed.length ? `${r.failed.length}人は失敗しました: ${r.failed.map(f => f.name).join("、")}` : "", r.stopped || ""];
    setMsg(parts.filter(Boolean).join("\n"), !!(r.stopped || r.failed.length));
    showAllCount.cache = null;
  } catch (e) { setMsg(e.message, true); }
}

// Sites whose whole character list the extension can read with the visitor's login.
const BULK_SITES = [
  { name: "いあきゃら", host: /^https:\/\/iachara\.com\//, sheet: /^https:\/\/iachara\.com\/(?:view|edit)\/(\d+)/,
    fetch: iacharaFetchSheets, convert: iacharaToItem, ok: s => !!s?.data },
  { name: "キャラッシュ", host: /^https:\/\/charash\.jp\//, sheet: /^https:\/\/charash\.jp\/(?:view|edit)\/([A-Za-z0-9_-]{12})/,
    fetch: charashFetchSheets, convert: charashToItem, ok: s => !!s?.data },
  { name: "vinsanet", host: /^https:\/\/vinsanet\.com\//, sheet: /^https:\/\/vinsanet\.com\/characters\/([A-Za-z0-9_-]{21})/,
    fetch: vinsanetFetchSheets, convert: vinsanetToItem, ok: s => !!s?.data,
    errors: { "open-mypage": "全キャラを追加するときは vinsanet のマイページ（https://vinsanet.com/mypage）を開いてから押してください。" } },
  // One sheet at a time: the sheet open in the tab.
  { name: "ゆとシート", single: true, host: /^https:\/\/yutorize\.(?:work|2-d\.jp)\//, sheet: /[?&]id=([A-Za-z0-9_-]+)/,
    fetch: ytsheetFetchSheets, convert: ytsheetToItem, ok: s => !!s?.data,
    errors: { "open-sheet": "ゆとシートのキャラクターシートを開いてから押してください。" } },
  { name: "キャラクター保管所", single: true, host: /^https:\/\/charasheet\.vampire-blood\.net\//, sheet: /^https:\/\/charasheet\.vampire-blood\.net\/(m?[0-9a-f]{32})/,
    fetch: vampireFetchSheets, convert: vampireToItem, ok: s => !!s?.data,
    errors: { "open-sheet": "キャラクター保管所のキャラクターシートを開いてから押してください。" } },
  { name: "キャラクターシート倉庫", single: true, host: /^https:\/\/character-sheets\.appspot\.com\//, sheet: /[?&]key=([A-Za-z0-9_-]+)/,
    fetch: appspotFetchSheets, convert: appspotToItem, ok: s => !!s?.data?.base,
    errors: { "open-sheet": "キャラクターシート倉庫のキャラクターシートを開いてから押してください。" } },
  // フタリソウサの公式シート: one spreadsheet holds the 探偵 and the 助手; the visitor picks theirs.
  { name: "Googleスプレッドシート", single: true, host: /^https:\/\/docs\.google\.com\/spreadsheets\/d\//, sheet: /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/,
    fetch: gsheetFetchSheets, convert: gsheetToItems, ok: s => !!s?.main,
    errors: { "sheet-401": "このスプレッドシートを読めませんでした。Googleにログインしているか、共有設定を確かめてください。",
              "sheet-403": "このスプレッドシートを読めませんでした。Googleにログインしているか、共有設定を確かめてください。" } },
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
  const r = await call(site.single ? (m?.[1] || null) : null);

  if (site.single){
    const s = r?.sheets?.[0];
    if (site.ok(s)) {
      const conv = site.convert(s);
      if (!Array.isArray(conv)) return showOne(conv);
      if (conv.length) return showPick(conv);
      setStatus("warn", "このスプレッドシートからキャラクターが見つかりませんでした。フタリソウサの公式キャラクターシートか確かめてください。");
      return;
    }
    setStatus("warn", site.errors?.[r?.error] || `${site.name}から読み込めませんでした（${r?.error || "不明"}）。ページを再読み込みしてから試してください。`);
    return;
  }

  if (r?.sheets?.length) {
    iaAll = r.sheets.filter(site.ok).map(site.convert);
    bulkSite = site.name;
  }

  let one = m && iaAll?.find(i => i.url.split("/").includes(m[1]));
  if (m && !one) {
    // Someone else's public sheet: ask for that one directly.
    const r1 = await call(m[1]);
    const s = r1?.sheets?.[0];
    if (site.ok(s)) one = site.convert(s);
  }

  if (one) {
    showOne(one);
  } else if (iaAll) {
    bulkMode = true;
    $("sendAll").textContent = `${site.name}の全員をシート帳に送る`;
    $("allBox").hidden = false;
    setStatus("ok", `${site.name}の自分のキャラ全員をシート帳に送ります。1人だけ送るときはそのシートを開いてください。`);
  } else {
    setStatus("warn", site.errors?.[r?.error] ? site.errors[r.error] : r?.error === "not-logged-in"
      ? `${site.name}にログインしていません。ログインしてから、もう一度この画面を開いてください。`
      : `${site.name}から読み込めませんでした（${r?.error || "不明"}）。ページを再読み込みしてから試してください。`);
  }
}

function showOne(one) {
  items = [one];
  $("name").value = one.name;
  $("single").hidden = false;
  const d = one.ccfolia?.data;
  const filled = d && (d.status.length || d.params.length || one.skills.length);
  setStatus(filled ? "ok" : "warn", filled
    ? `${one.system}: ステータス${d.status.length}件・能力値${d.params.length}件・技能${one.skills.length}件${d.commands ? "・チャットパレットあり" : ""}`
    : `${one.system}: このシステムの能力値はまだ読み取れません。名前・URL・プロフィールを追加します。`);
}

// Several characters on one sheet (フタリソウサ: 探偵 and 助手). Preselects the one whose PL name
// matches the PL name saved the last time a sheet was added this way.
async function showPick(list) {
  const { plName } = await chrome.storage.local.get("plName");
  const pick = $("pick");
  pick.replaceChildren(...list.map((it, i) => new Option(`${it.role ? it.role + ": " : ""}${it.name}${it.plName ? `（PL ${it.plName}）` : ""}`, String(i))));
  const mine = Math.max(0, list.findIndex(it => plName && it.plName === plName));
  pick.value = String(mine);
  pick.onchange = () => { showOne(list[Number(pick.value)]); showAllCount(); };
  $("pickBox").hidden = false;
  showOne(list[mine]);
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
    setStatus("warn", "能力値データが見つかりません。名前とURLだけ追加します。サイトの「ココフォリア出力」ボタンでコピーしてから、もう一度この画面を開くと能力値も追加できます。");
  }
}

async function init() {
  await loadSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $("site").textContent = `${siteName(tab?.url) || "このページ"} — ${tab?.url || ""}`;
  const site = BULK_SITES.find(s => s.host.test(tab?.url || ""));
  if (site) await initBulk(tab, site);
  else await initOther(tab);
  await showAllCount();
}

$("send").addEventListener("click", () => {
  if (items[0]?.plName) chrome.storage.local.set({ plName: items[0].plName });
  const name = $("name").value.trim();
  send([{ ...items[0], name: name || items[0].name, ...(items[0].ccfolia && name ? { ccfolia: { ...items[0].ccfolia, data: { ...items[0].ccfolia.data, name } } } : {}) }]);
});
$("sendAll").addEventListener("click", () => send(iaAll));
$("open").addEventListener("click", () => chrome.tabs.create({ url: "https://www.notion.so/" + notion.db }));
$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ notionToken: $("token").value.trim(), notionDb: notionDbId($("db").value) || NOTION_DEFAULT_DB });
  await loadSettings();
  showAllCount.cache = null;
  setMsg("保存しました。");
  await showAllCount();
});

init();
