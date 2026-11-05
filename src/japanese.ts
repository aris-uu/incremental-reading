import { api } from "./api";
import { ASSET_BASE } from "./editor/assetSrc";
import { loadPrefs } from "./prefs";
import { generateJSON } from "@tiptap/react";
import { fieldExtensions } from "./editor/extensions";
import { sanitizeHtml } from "./editor/sanitize";

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
  return sanitizeHtml(html);
}

/** `[sound:a.mp3]` names in a field. */
export const soundsIn = (html: string) => [...(html ?? "").matchAll(/\[sound:([^\]]+)\]/g)].map((m) => m[1]);

export { playSound } from "./editor/audio";

// ---------- mined cards as ordinary Q&A items ----------

/** Field HTML ready for the editor: safe, `[sound:x]` as audio nodes, local images by asset name. */
function editorHtml(html: string): string {
  const withSounds = (html ?? "").replace(/\[sound:([^\]]+)\]/g, (_, name) => `<span data-sound="${escapeHtml(name)}"></span>`);
  const doc = new DOMParser().parseFromString(`<body>${withSounds}</body>`, "text/html");
  doc.querySelectorAll(BAD_TAGS).forEach((el) => el.remove());
  doc.body.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) if (attr.name.toLowerCase().startsWith("on")) el.removeAttribute(attr.name);
    if (el instanceof HTMLImageElement) {
      const src = el.getAttribute("src") ?? "";
      if (src && !/^[a-z]+:/i.test(src) && !src.startsWith("/")) el.setAttribute("src", ASSET_BASE + src);
    }
    // Senren marks the target word with span.highlight: make it bold.
    if (el.classList.contains("highlight")) {
      const b = doc.createElement("b");
      b.append(...el.childNodes);
      el.replaceWith(b);
    }
  });
  return doc.body.innerHTML;
}

const plain = (html: string) => (html ?? "").replace(/<[^>]+>/g, "").trim();

/** Answer HTML for one changed media field (appended to an edited card). */
function mediaHtml(field: string, f: Fields): string {
  const v = f[field] ?? "";
  if (!v.trim()) return "";
  return field === "picture" ? v : `<p>${field === "sentenceAudio" ? "sentence " : ""}${v}</p>`;
}

/**
 * A mined card's question and answer (ProseMirror JSON) from its fields:
 * the sentence with the target word in bold; then the word with its reading
 * and audio, pitch accent and frequency, the gloss, picture, translation,
 * sentence audio, notes and source.
 */
export function fieldsToDocs(f: Fields): { question: string; answer: string } {
  const word = plain(f.word);
  const reading = plain(f.reading);
  const sounds = (v: string | undefined) => soundsIn(v ?? "").map((src) => ({ type: "audio", attrs: { src } }));
  const inline = (kind: string, html: string) => ({ type: "htmlInline", attrs: { kind, html } });
  const block = (kind: string, html: string) => ({ type: "htmlBlock", attrs: { kind, html } });
  const rich = (html: string) => (generateJSON(editorHtml(html), fieldExtensions).content ?? []) as any[];
  const text = (t: string) => ({ type: "text", text: t });

  // Like Senren's back: the word with furigana, audio and pitch accent; the
  // frequency tags; the dictionary entry as Yomitan renders it; then picture,
  // translation, sentence audio, notes and the source.
  const ruby = reading && reading !== word ? `<ruby>${escapeHtml(word)}<rt>${escapeHtml(reading)}</rt></ruby>` : escapeHtml(word);
  const head = { type: "paragraph", content: [inline("word", ruby), ...sounds(f.wordAudio), ...(f.pitchAccents?.trim() ? [inline("pitch", f.pitchAccents)] : [])] };
  const prefGloss = (f.dictionaryPreference ?? "").trim() === "glossary" ? f.glossary || f.definition : f.definition || f.glossary;
  const gloss = f.selectionText?.trim() ? f.selectionText : prefGloss;
  const answer: any[] = [
    head,
    ...(f.frequencies?.trim() ? [block("freq", f.frequencies)] : []),
    ...(gloss?.trim() ? [block("gloss", gloss)] : []),
    ...(f.picture?.trim() ? rich(f.picture) : []),
    ...(f.sentenceTranslation?.trim() ? [{ type: "paragraph", content: [{ ...text(plain(f.sentenceTranslation)), marks: [{ type: "italic" }] }] }] : []),
    ...(f.sentenceAudio?.trim() ? [{ type: "paragraph", content: [text("sentence "), ...sounds(f.sentenceAudio)] }] : []),
    ...(f.notes?.trim() ? rich(f.notes) : []),
    ...(f.miscInfo?.trim() ? [{ type: "paragraph", content: [{ ...text(`— ${plain(f.miscInfo)}`), marks: [{ type: "italic" }] }] }] : []),
  ];
  const sentence = f.sentence?.trim() ? f.sentence : `<b>${escapeHtml(word)}</b>`;
  return {
    question: JSON.stringify(generateJSON(editorHtml(`<p>${sentence}</p>`), fieldExtensions)),
    answer: JSON.stringify({ type: "doc", content: answer }),
  };
}

/**
 * Render the mined cards the core is waiting on (added through AnkiConnect,
 * or converted from older versions). Fields that changed after the card was
 * made (a picture or audio from mpvacious) are appended to its answer instead
 * of rebuilding it, so edits survive.
 */
export async function renderPendingCards(): Promise<number> {
  const list = await api.pendingSentences();
  for (const [id, f] of list) {
    try {
      await renderOne(id, f);
    } catch {
      /* skip this card; the next pass tries again */
    }
  }
  return list.length;
}

async function renderOne(id: number, f: Record<string, any>) {
  {
    const changed = f._pending;
    const media = Array.isArray(changed) && changed.every((c: string) => ["picture", "sentenceAudio", "wordAudio"].includes(c));
    if (media) {
      const el = await api.getElement(id);
      if (!el?.item) throw new Error("not an item");
      const answer = JSON.parse(el.item.answer || '{"type":"doc","content":[]}');
      const extra = generateJSON(editorHtml((changed as string[]).map((c: string) => mediaHtml(c, f)).join("")), fieldExtensions);
      answer.content = [...(answer.content ?? []), ...(extra.content ?? [])];
      await api.renderedSentence(id, el.item.question, JSON.stringify(answer));
    } else {
      const d = fieldsToDocs(f);
      await api.renderedSentence(id, d.question, d.answer);
    }
  }
}
