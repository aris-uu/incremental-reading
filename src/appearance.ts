/** Reading appearance. A per-machine display preference, so it lives in localStorage. */
export interface Appearance {
  /** Key into FONTS, or "custom". */
  font: string;
  /** Any installed font family, used when font = "custom". */
  customFont: string;
  /** Reader text size in px; item cards use 1.15× this. */
  size: number;
  lineHeight: number;
  /** Text column width in characters. */
  width: number;
  /** Interface (menus, tree) font. */
  uiFont: string;
}

export const FONTS: Record<string, { label: string; stack: string }> = {
  serif: { label: "Serif (Charter, Georgia)", stack: 'Charter, "Bitstream Charter", "Iowan Old Style", Georgia, Cambria, serif' },
  book: { label: "Book (Palatino, Garamond)", stack: '"Palatino Linotype", Palatino, "Book Antiqua", Garamond, "EB Garamond", serif' },
  sans: { label: "Sans (Segoe UI, system)", stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  humanist: { label: "Humanist sans (Optima, Candara)", stack: 'Optima, Candara, "Noto Sans", "Gill Sans", sans-serif' },
  readable: { label: "Legible (Verdana, Atkinson)", stack: '"Atkinson Hyperlegible", Verdana, Tahoma, sans-serif' },
  mono: { label: "Monospace", stack: 'ui-monospace, "Cascadia Code", Consolas, "Courier New", monospace' },
};

export const UI_FONTS: Record<string, string> = {
  system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  humanist: 'Optima, Candara, "Noto Sans", sans-serif',
  mono: 'ui-monospace, "Cascadia Code", Consolas, monospace',
};

export const DEFAULT_APPEARANCE: Appearance = { font: "serif", customFont: "", size: 17, lineHeight: 1.65, width: 72, uiFont: "system" };

const KEY = "ir.appearance";

export function loadAppearance(): Appearance {
  try {
    return { ...DEFAULT_APPEARANCE, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

/** Apply as CSS variables (styles.css reads them). */
export function applyAppearance(a: Appearance) {
  const root = document.documentElement.style;
  const stack = a.font === "custom" && a.customFont.trim() ? `"${a.customFont.trim()}", ${FONTS.serif.stack}` : (FONTS[a.font] ?? FONTS.serif).stack;
  root.setProperty("--reader-font", stack);
  root.setProperty("--reader-size", `${a.size}px`);
  root.setProperty("--reader-line", String(a.lineHeight));
  root.setProperty("--reader-width", `${a.width}ch`);
  root.setProperty("--ui-font", UI_FONTS[a.uiFont] ?? UI_FONTS.system);
}

export function saveAppearance(a: Appearance) {
  applyAppearance(a);
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    /* not remembered, still applied */
  }
}

/** Apply on startup, and follow changes made in another window (e.g. main ↔ import). */
export function initAppearance() {
  applyAppearance(loadAppearance());
  window.addEventListener("storage", (e) => e.key === KEY && applyAppearance(loadAppearance()));
}
