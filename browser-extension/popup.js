const BRIDGE = "http://127.0.0.1:47811";
const $ = (id) => document.getElementById(id);

/** Runs inside the page: the readable article, or the current selection. */
function extractFromPage(useSelection) {
  const meta = (name) =>
    document.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.getAttribute("content") || null;
  const site = meta("og:site_name") || location.hostname;
  const sel = window.getSelection();
  if (useSelection) {
    if (!sel || sel.isCollapsed) return { error: "Nothing is selected on the page." };
    const box = document.createElement("div");
    for (let i = 0; i < sel.rangeCount; i++) box.appendChild(sel.getRangeAt(i).cloneContents());
    // Make links and images absolute so they still work outside the page.
    box.querySelectorAll("img").forEach((img) => img.setAttribute("src", new URL(img.getAttribute("src") || "", location.href).href));
    box.querySelectorAll("a[href]").forEach((a) => a.setAttribute("href", new URL(a.getAttribute("href"), location.href).href));
    return { title: document.title, html: box.innerHTML, url: location.href, site, author: meta("author") };
  }
  // eslint-disable-next-line no-undef
  const article = new Readability(document.cloneNode(true)).parse();
  if (!article || !article.content) return { error: "Couldn't find an article on this page. Try selecting the text." };
  return { title: article.title || document.title, html: article.content, url: location.href, site: article.siteName || site, author: article.byline || meta("author") };
}

async function send(useSelection) {
  $("status").textContent = "Reading the page…";
  const { token } = await chrome.storage.local.get("token");
  if (!token) {
    $("status").innerHTML = 'No token yet. Open <a href="options.html" target="_blank">settings</a> and paste it from the app (Tools → Browser extension).';
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    if (!useSelection) await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["Readability.js"] });
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractFromPage, args: [useSelection] });
    if (result.error) return void ($("status").textContent = result.error);
    const res = await fetch(`${BRIDGE}/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-IR-Token": token },
      body: JSON.stringify({ ...result, priority: Number($("priority").value) }),
    });
    if (res.status === 401) return void ($("status").textContent = "The app rejected the token. Copy it again from Tools → Browser extension.");
    if (!res.ok) return void ($("status").textContent = `The app answered ${res.status}.`);
    $("status").textContent = `Sent “${result.title}” to the Inbox.`;
    setTimeout(() => window.close(), 1200);
  } catch (e) {
    $("status").textContent = String(e).includes("Failed to fetch")
      ? "Couldn't reach the app. Is Incremental Reading running?"
      : `Failed: ${e.message || e}`;
  }
}

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $("title").textContent = tab?.title ?? "";
  const { priority = 50 } = await chrome.storage.local.get("priority");
  $("priority").value = priority;
  $("pval").textContent = `${priority}%`;
})();

$("priority").addEventListener("input", (e) => {
  $("pval").textContent = `${e.target.value}%`;
  chrome.storage.local.set({ priority: Number(e.target.value) });
});
$("page").addEventListener("click", () => send(false));
$("selection").addEventListener("click", () => send(true));
