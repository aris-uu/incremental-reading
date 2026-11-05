/** Per-machine review preferences (localStorage, like the appearance). */
export interface Prefs {
  /** "4": Again/Hard/Good/Easy. "2": Again/Good (pass/fail). */
  grading: "4" | "2";
  /** "supermemo" adds Enter as the default action (like Space) for people coming from SuperMemo. */
  keys: "modern" | "supermemo";
}

const KEY = "ir.prefs";
const DEFAULTS: Prefs = { grading: "4", keys: "modern" };

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
