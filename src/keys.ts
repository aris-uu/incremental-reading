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
  if (ev.key !== " " || ev.repeat || ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey) return false;
  if (isTyping(ev.target) || document.querySelector(".modal-backdrop")) return false;
  ev.preventDefault();
  return true;
}
