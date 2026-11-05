import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export const IMPORT_LABEL = "import";
/** Emitted by any window that adds or changes elements. */
export const COLLECTION_CHANGED = "collection-changed";

/** Open the import window, or focus it if it is already open. */
export async function openImportWindow() {
  const existing = await WebviewWindow.getByLabel(IMPORT_LABEL);
  if (existing) {
    await existing.unminimize();
    await existing.setFocus();
    return;
  }
  const w = new WebviewWindow(IMPORT_LABEL, {
    url: "index.html#import",
    title: "Import — Incremental Reading",
    width: 820,
    height: 760,
    center: true,
    // Let the page receive dropped files (PDF, EPUB, HTML) as HTML5 drops.
    dragDropEnabled: false,
  });
  await new Promise<void>((resolve, reject) => {
    w.once("tauri://created", () => resolve());
    w.once("tauri://error", (e) => reject(e.payload));
  });
}
