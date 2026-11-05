import { loadPrefs } from "./prefs";

/** Keyboard shortcuts must not fire while typing in a field. */
export const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/**
 * Space as the default action (show answer → Good, Next for topics). Not while
 * typing, in a dialog, with modifiers, or on key repeat (holding Space must not
 * fly through the queue). Prevents the default so a focused button isn't also
 * clicked by the same key.
 */
export function isDefaultAction(ev: KeyboardEvent): boolean {
  const enter = ev.key === "Enter" && loadPrefs().keys === "supermemo";
  if ((ev.key !== " " && !enter) || ev.repeat || ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey) return false;
  if (isTyping(ev.target) || document.querySelector(".modal-backdrop")) return false;
  // Keys pressed in the tree or the browser table belong to them.
  if (ev.target instanceof HTMLElement && ev.target.closest(".sidebar, .browser-table, .context-menu")) return false;
  ev.preventDefault();
  return true;
}
