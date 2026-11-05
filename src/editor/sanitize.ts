import { ASSET_BASE } from "./assetSrc";

const BAD_TAGS = "script,iframe,object,embed,link,meta,base,form,input,textarea,select,style";
const escapeAttr = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * Dictionary HTML (Yomitan glossaries, pitch accent, frequencies) made safe to
 * show: no scripts, embeds or forms, no event handlers or javascript: links;
 * local media pointed at the app's asset server; `[sound:x]` as play buttons.
 */
export function sanitizeHtml(html: string): string {
  const withSounds = (html ?? "").replace(/\[sound:([^\]]+)\]/g, (_, name) => `<button type="button" class="play" data-sound="${escapeAttr(name)}">▶</button>`);
  const doc = new DOMParser().parseFromString(`<body>${withSounds}</body>`, "text/html");
  doc.querySelectorAll(BAD_TAGS).forEach((el) => el.remove());
  doc.querySelectorAll("button:not([data-sound])").forEach((el) => el.remove());
  doc.body.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      if (n.startsWith("on")) el.removeAttribute(attr.name);
      else if ((n === "href" || n === "src" || n === "xlink:href") && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    }
    if (el instanceof HTMLImageElement) {
      const src = el.getAttribute("src") ?? "";
      if (src.startsWith("ir-asset:")) el.setAttribute("src", ASSET_BASE + src.slice(9));
      else if (src && !/^[a-z]+:/i.test(src) && !src.startsWith("/")) el.setAttribute("src", ASSET_BASE + src);
    }
    if (el instanceof HTMLAnchorElement) {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noreferrer");
    }
  });
  return doc.body.innerHTML;
}
