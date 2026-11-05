import JSZip from "jszip";
import { Readability } from "@mozilla/readability";
import { api } from "./api";
import { EMPTY_DOC, htmlToDoc } from "./editor/extensions";
import { markdownToHtml } from "./editor/markdown";

export { markdownToHtml };

export interface ImportOptions {
  priority: number;
  /** Parent topic for everything imported (null = top level). */
  parent: number | null;
  /** Single files may go to the Inbox; folder and book imports never do. */
  inbox?: boolean;
  /** Report progress. */
  onProgress?: (msg: string) => void;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export const textToHtml = (t: string) =>
  t
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\r?\n/g, "<br>")}</p>`)
    .join("\n");

/** Readable article from a full HTML page (falls back to the body). */
export function articleFromHtml(html: string, baseUrl?: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (baseUrl) {
    const base = doc.createElement("base");
    base.href = baseUrl;
    doc.head.prepend(base);
  }
  const title = doc.title;
  const article = new Readability(doc.cloneNode(true) as Document).parse();
  if (article?.content && (article.length ?? 0) > 200) return { title: article.title || title, html: article.content, site: article.siteName ?? null, author: article.byline ?? null };
  return { title, html: doc.body?.innerHTML ?? html, site: null, author: null };
}

const extOf = (name: string) => name.toLowerCase().split(".").pop() ?? "";
const baseName = (name: string) => name.replace(/\.[^.]+$/, "");
export const SUPPORTED = ["pdf", "epub", "html", "htm", "md", "markdown", "txt"];

/** Import one file under `parent`. Returns the new element id. */
export async function importFile(file: File, opts: ImportOptions, dueOffset = 0): Promise<number | null> {
  const ext = extOf(file.name);
  const title = baseName(file.name);
  if (ext === "pdf") {
    const asset = await api.saveAsset(await file.arrayBuffer(), "pdf");
    return api.importPdf({ title, asset: asset.replace(/^ir-asset:/, ""), priority: opts.priority, parent: opts.parent, inbox: !!opts.inbox && opts.parent == null });
  }
  if (ext === "epub") return importEpub(file, opts);
  let html: string;
  let docTitle = title;
  if (ext === "html" || ext === "htm") {
    const a = articleFromHtml(await file.text());
    html = a.html;
    docTitle = a.title || title;
  } else if (ext === "md" || ext === "markdown") html = markdownToHtml(await file.text());
  else if (ext === "txt") html = textToHtml(await file.text());
  else return null;
  const id = await api.importTopic({
    title: docTitle,
    doc_json: JSON.stringify(htmlToDoc(html)),
    priority: opts.priority,
    parent: opts.parent,
    inbox: !!opts.inbox && opts.parent == null,
  });
  if (dueOffset > 0) await api.reschedule(id, dueOffset);
  return id;
}

/**
 * Import a set of files, recreating their folder structure as topics. Files
 * are staggered a few per day so a big folder doesn't land in one day.
 */
export async function importFiles(files: File[], opts: ImportOptions, perDay = 3): Promise<number> {
  const supported = files.filter((f) => SUPPORTED.includes(extOf(f.name)));
  supported.sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true }));
  const folders = new Map<string, number | null>([["", opts.parent]]);
  const folderFor = async (path: string): Promise<number | null> => {
    if (folders.has(path)) return folders.get(path)!;
    const cut = path.lastIndexOf("/");
    const parent = await folderFor(cut < 0 ? "" : path.slice(0, cut));
    const id = await api.createTopic(parent, path.slice(cut + 1), JSON.stringify(EMPTY_DOC));
    folders.set(path, id);
    return id;
  };
  let n = 0;
  for (const [i, f] of supported.entries()) {
    const rel = f.webkitRelativePath || f.name;
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    opts.onProgress?.(`Importing ${i + 1}/${supported.length}: ${rel}`);
    try {
      const parent = await folderFor(dir);
      const single = supported.length === 1 && !dir;
      if ((await importFile(f, { ...opts, parent, inbox: single && opts.inbox }, Math.floor(i / perDay))) != null) n++;
    } catch (e) {
      opts.onProgress?.(`Skipped ${rel}: ${e}`);
    }
  }
  return n;
}

// ---------- EPUB ----------

const resolvePath = (from: string, rel: string) => {
  const u = new URL(rel, `http://epub.invalid/${from}`);
  return decodeURIComponent(u.pathname.slice(1));
};

const mimeExt = (path: string) => {
  const e = extOf(path);
  return ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(e) ? (e === "jpeg" ? "jpg" : e) : "img";
};

/**
 * EPUB → a book topic with one child topic per chapter (spine order).
 * Images are copied into the collection. Chapters come due one per day.
 */
export async function importEpub(file: File, opts: ImportOptions): Promise<number> {
  const zip = await JSZip.loadAsync(file);
  const read = (p: string) => zip.file(p)?.async("string");
  const container = await read("META-INF/container.xml");
  if (!container) throw new Error("Not an EPUB (no container.xml)");
  const opfPath = new DOMParser().parseFromString(container, "application/xml").querySelector("rootfile")?.getAttribute("full-path");
  if (!opfPath) throw new Error("EPUB has no package file");
  const opf = new DOMParser().parseFromString((await read(opfPath)) ?? "", "application/xml");
  const meta = (tag: string) => opf.getElementsByTagNameNS("*", tag)[0]?.textContent?.trim() || null;
  const bookTitle = meta("title") || baseName(file.name);
  const author = meta("creator");
  const manifest = new Map<string, { href: string; type: string }>();
  opf.querySelectorAll("manifest > item").forEach((it) =>
    manifest.set(it.getAttribute("id") ?? "", { href: resolvePath(opfPath, it.getAttribute("href") ?? ""), type: it.getAttribute("media-type") ?? "" }),
  );
  const spine = [...opf.querySelectorAll("spine > itemref")].map((r) => manifest.get(r.getAttribute("idref") ?? "")).filter(Boolean) as {
    href: string;
    type: string;
  }[];

  const bookId = await api.createTopic(opts.parent, bookTitle, JSON.stringify(EMPTY_DOC));
  const imageCache = new Map<string, string>();
  let chapter = 0;
  const chapterIds: number[] = [];
  for (const [i, item] of spine.entries()) {
    if (!/x?html/.test(item.type)) continue;
    opts.onProgress?.(`“${bookTitle}”: chapter ${i + 1}/${spine.length}`);
    const raw = await read(item.href);
    if (!raw) continue;
    let doc = new DOMParser().parseFromString(raw, "application/xhtml+xml");
    if (doc.querySelector("parsererror")) doc = new DOMParser().parseFromString(raw, "text/html");
    const body = doc.querySelector("body");
    if (!body || (body.textContent ?? "").trim().length < 80) continue; // cover pages, blank separators
    // Copy images into the collection.
    for (const img of [...body.querySelectorAll("img, image")]) {
      const attr = img.tagName.toLowerCase() === "img" ? "src" : "xlink:href";
      const src = img.getAttribute(attr) ?? img.getAttribute("href");
      if (!src || /^(https?:|data:)/.test(src)) continue;
      const path = resolvePath(item.href, src);
      let stored = imageCache.get(path);
      if (!stored) {
        const bytes = await zip.file(path)?.async("uint8array");
        if (!bytes) continue;
        stored = await api.saveAsset(bytes, mimeExt(path));
        imageCache.set(path, stored);
      }
      if (img.tagName.toLowerCase() === "img") img.setAttribute("src", stored);
      else img.replaceWith(Object.assign(doc.createElement("img"), { src: stored }));
    }
    const heading = body.querySelector("h1, h2, h3")?.textContent?.trim();
    const title = heading || doc.querySelector("title")?.textContent?.trim() || `Chapter ${chapter + 1}`;
    const id = await api.importTopic({
      title,
      doc_json: JSON.stringify(htmlToDoc(body.innerHTML)),
      priority: opts.priority,
      parent: bookId,
      author,
      site: bookTitle,
    });
    if (chapter > 0) await api.reschedule(id, chapter);
    chapterIds.push(id);
    chapter++;
  }
  // Chapters sit together in the priority queue, in reading order.
  if (chapterIds.length > 1) await api.bulk(chapterIds, "priority", opts.priority);
  return bookId;
}
