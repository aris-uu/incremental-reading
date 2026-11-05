import { generateHTML } from "@tiptap/react";
import { api } from "./api";
import { fieldExtensions, parseDoc } from "./editor/extensions";
import { ASSET_BASE, ASSET_PREFIX } from "./editor/assetSrc";

/** One item side as Anki HTML: local images by file name, math as MathJax \( \) / \[ \]. */
export function ankiHtml(docJson: string): string {
  const html = generateHTML(parseDoc(docJson), fieldExtensions);
  const root = document.createElement("div");
  root.innerHTML = html;
  for (const img of root.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    if (src.startsWith(ASSET_BASE)) img.setAttribute("src", src.slice(ASSET_BASE.length));
    else if (src.startsWith(ASSET_PREFIX)) img.setAttribute("src", src.slice(ASSET_PREFIX.length));
  }
  for (const el of root.querySelectorAll("[data-math-inline]")) {
    const latex = el.getAttribute("data-latex") ?? "";
    el.replaceWith(document.createTextNode(el.getAttribute("display") === "true" ? `\\[${latex}\\]` : `\\(${latex}\\)`));
  }
  for (const el of root.querySelectorAll("[data-math-block]")) {
    el.replaceWith(document.createTextNode(`\\[${el.getAttribute("data-latex") ?? ""}\\]`));
  }
  for (const el of root.querySelectorAll("[data-occlusion]")) el.removeAttribute("data-occlusion");
  for (const el of root.querySelectorAll("[data-sound]")) el.replaceWith(document.createTextNode(`[sound:${el.getAttribute("data-sound")}]`));
  return root.innerHTML;
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * Export active items (all, or those in the given branches) as an Anki
 * package. Returns the file path and the number of cards.
 */
export async function exportToAnki(roots: number[] | null): Promise<{ path: string; count: number }> {
  const items = await api.exportItems(roots);
  if (!items.length) throw new Error("No active items to export");
  const cards = items.map((it) => ({
    id: it.id,
    deck: it.deck,
    front: ankiHtml(it.question),
    back: ankiHtml(it.answer) + (it.reference ? `<div class="ir-ref">${escape(it.reference)}</div>` : ""),
  }));
  const path = await api.exportApkg(cards);
  return { path, count: cards.length };
}
