import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * The webview can't open pages itself, so web links go to the system browser.
 * Inside an editable text a plain click places the cursor (you may be editing
 * the link text); Ctrl+click opens it. Everywhere else a plain click opens.
 */
export function initLinks() {
  const onClick = (ev: MouseEvent) => {
    const a = (ev.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (!/^(https?:|mailto:)/i.test(href)) return;
    const inEditor = !!a.closest('[contenteditable="true"]');
    if (inEditor && !(ev.ctrlKey || ev.metaKey)) return;
    ev.preventDefault();
    ev.stopPropagation();
    openUrl(href).catch((e) => console.error("Couldn't open link", href, e));
  };
  // Capture phase, so it runs before the editor's own click handling.
  document.addEventListener("click", onClick, true);
  // Middle-click too.
  document.addEventListener("auxclick", (ev) => ev.button === 1 && onClick(ev), true);
}
