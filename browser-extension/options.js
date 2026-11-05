const $ = (id) => document.getElementById(id);

chrome.storage.local.get("token").then(({ token }) => {
  if (token) $("token").value = token;
});

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ token: $("token").value.trim() });
  $("status").textContent = "Saved.";
});

$("test").addEventListener("click", async () => {
  try {
    const res = await fetch("http://127.0.0.1:47811/ping", { headers: { "X-IR-Token": $("token").value.trim() } });
    $("status").textContent = res.ok ? "Connected." : res.status === 401 ? "The app rejected this token." : `The app answered ${res.status}.`;
  } catch {
    $("status").textContent = "Couldn't reach the app. Is it running?";
  }
});
