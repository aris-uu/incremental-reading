import { api } from "./api";
import { ASSET_BASE } from "./editor/assetSrc";
import { loadPrefs } from "./prefs";

/** Field values of a sentence item (Senren field names). */
export type Fields = Record<string, string>;

/** Senren field → Yomitan marker, as Senren's setup guide recommends. */
export const MARKERS: Record<string, string> = {
  word: "expression",
  reading: "reading",
  glossary: "glossary",
  wordAudio: "audio",
  pitchAccents: "pitch-accents",
  pitchPositions: "pitch-accent-positions",
  pitchCategories: "pitch-accent-categories",
  frequencies: "frequencies",
  freqSort: "frequency-harmonic-rank",
};

const SENTENCE_END = /[。！？!?…\n]/;
const OPEN_QUOTES = "「『（(“";
const CLOSE_QUOTES = "」』）)”";

/**
 * The sentence around [from, to) in `text` (Japanese or Western punctuation).
 * Returns the sentence and the target's offsets inside it.
 */
export function sentenceAround(text: string, from: number, to: number): { sentence: string; start: number; end: number } {
  let a = from;
  while (a > 0 && !SENTENCE_END.test(text[a - 1])) a--;
  let b = to;
  while (b < text.length && !SENTENCE_END.test(text[b])) b++;
  // Keep the closing punctuation (and a closing quote after it).
  while (b < text.length && /[。！？!?…]/.test(text[b])) b++;
  while (b < text.length && CLOSE_QUOTES.includes(text[b])) b++;
  // Drop leading spaces and an unmatched opening quote.
  while (a < from && /\s/.test(text[a])) a++;
  let s = text.slice(a, b).replace(/\s+$/, "");
  let start = from - a;
  if (OPEN_QUOTES.includes(s[0]) && ![...s].some((c) => CLOSE_QUOTES.includes(c)) && start > 0) {
    s = s.slice(1);
    start -= 1;
  }
  return { sentence: s, start, end: start + (to - from) };
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Senren's sentence field: the target in a highlight span. */
export function sentenceHtml(sentence: string, start: number, end: number) {
  return `${escapeHtml(sentence.slice(0, start))}<span class="highlight">${escapeHtml(sentence.slice(start, end))}</span>${escapeHtml(sentence.slice(end))}`;
}

/**
 * Look a word up through the Yomitan API (yomitan-api) and return Senren
 * fields for the best entry. With `media`, audio and dictionary images are
 * stored in the collection (do that only when making a card).
 */
export async function yomitanFields(text: string, media = true): Promise<Fields | null> {
  return (await yomitanEntries(text, 1, media))[0] ?? null;
}

/**
 * Up to `max` entries for text that starts at the cursor (Yomitan scans for
 * the longest match). Each has Senren fields plus `match`, the source text
 * that matched (e.g. 飲んだ for 飲む).
 */
export async function yomitanEntries(text: string, max = 3, media = false): Promise<Fields[]> {
  const prefs = loadPrefs();
  if (!prefs.yomitanUrl) throw new Error("Yomitan API is off (Tools → Japanese & Yomitan)");
  const markers: Record<string, string> = { ...MARKERS, match: "cloze-body" };
  if (prefs.definitionMarker.trim()) markers.definition = prefs.definitionMarker.trim().replace(/[{}]/g, "");
  const res: any = await api.yomitanApi(prefs.yomitanUrl, "ankiFields", {
    text,
    type: "term",
    markers: [...new Set(Object.values(markers))],
    maxEntries: max,
    includeMedia: media,
  });
  if (media)
    for (const m of [...(res?.audioMedia ?? []), ...(res?.dictionaryMedia ?? [])]) {
      if (m?.ankiFilename && m?.content) await api.saveMedia(m.ankiFilename, m.content);
    }
  return (res?.fields ?? []).map((entry: any) => {
    const out: Fields = {};
    for (const [field, marker] of Object.entries(markers)) if (typeof entry[marker] === "string") out[field] = entry[marker];
    return out;
  });
}

/** Yomitan API reachable? Returns its version or throws. */
export async function testYomitan(url: string): Promise<string> {
  const v: any = await api.yomitanApi(url, "serverVersion", {});
  return String(v?.version ?? JSON.stringify(v));
}

// ---------- rendering ----------

const BAD_TAGS = "script,iframe,object,embed,link,meta,base,form,input,button,textarea,select";

/**
 * Field HTML from dictionaries, made safe to show: no scripts or embeds, no
 * event handlers or javascript: links; local media pointed at the app's asset
 * server; `[sound:x]` turned into play buttons.
 */
export function renderField(html: string): string {
  const withSounds = (html ?? "").replace(/\[sound:([^\]]+)\]/g, (_, name) => `<button type="button" class="play" data-sound="${escapeHtml(name)}">▶</button>`);
  const doc = new DOMParser().parseFromString(`<body>${withSounds}</body>`, "text/html");
  doc.querySelectorAll(BAD_TAGS).forEach((el) => {
    if (!(el instanceof HTMLButtonElement && el.dataset.sound)) el.remove();
  });
  doc.body.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      if (n.startsWith("on")) el.removeAttribute(attr.name);
      else if ((n === "href" || n === "src" || n === "xlink:href") && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    }
    if (el instanceof HTMLImageElement) {
      const src = el.getAttribute("src") ?? "";
      if (src && !/^[a-z]+:/i.test(src) && !src.startsWith("/")) el.setAttribute("src", ASSET_BASE + src);
    }
    if (el instanceof HTMLAnchorElement) {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noreferrer");
    }
  });
  return doc.body.innerHTML;
}

/** `[sound:a.mp3]` names in a field. */
export const soundsIn = (html: string) => [...(html ?? "").matchAll(/\[sound:([^\]]+)\]/g)].map((m) => m[1]);

let current: HTMLAudioElement | null = null;
export function playSound(name: string) {
  current?.pause();
  current = new Audio(ASSET_BASE + name);
  void current.play().catch(() => {});
}

/** Which card a sentence item shows, following Senren's flags. */
export function cardKind(f: Fields): "word" | "sentence" | "audio" {
  if (f.audioCard?.trim()) return "audio";
  if (f.sentenceCard?.trim()) return "sentence";
  return loadPrefs().cardType;
}
