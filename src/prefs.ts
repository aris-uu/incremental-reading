/** Per-machine review preferences (localStorage, like the appearance). */
export interface Prefs {
  /** "4": Again/Hard/Good/Easy. "2": Again/Good (pass/fail). */
  grading: "4" | "2";
  /** "supermemo" adds Enter as the default action (like Space) for people coming from SuperMemo. */
  keys: "modern" | "supermemo";
  /** Sentence items (Senren): what the front shows unless the note's own flags say otherwise. */
  cardType: "sentence" | "word" | "audio";
  autoplay: boolean;
  /** Yomitan API (yomitan-api) address; empty = off. */
  yomitanUrl: string;
  /** Optional marker for the `definition` field, e.g. single-glossary-jitendexorg-2026-01-04. */
  definitionMarker: string;
  /** Where cards mined in the reader go: under the article, or into a deck (topic path). */
  mineInto: "source" | "deck";
  mineDeck: string;
}

const KEY = "ir.prefs";
const DEFAULTS: Prefs = {
  grading: "4",
  keys: "modern",
  cardType: "sentence",
  autoplay: true,
  yomitanUrl: "http://127.0.0.1:19633",
  definitionMarker: "",
  mineInto: "source",
  mineDeck: "Japanese::Mining",
};

export function loadPrefs(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* not remembered */
  }
}
