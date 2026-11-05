import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type QueueEntry, type Stats } from "./api";
import { EMPTY_DOC } from "./editor/extensions";
import { htmlToDoc } from "./editor/extensions";
import { LearnView, useLearnSession } from "./views/LearnView";
import { BrowseView } from "./views/BrowseView";
import { InboxView } from "./views/InboxView";
import { Sidebar } from "./views/Sidebar";
import { ToolsDialog } from "./views/ToolsDialog";
import { StatsView } from "./views/StatsView";
import { openImportWindow, COLLECTION_CHANGED } from "./importWindow";
import { CommandPalette, type Command } from "./views/CommandPalette";
import { TodayContext, type Notify } from "./notify";
import { fetchVideoInfo, youtubeId } from "./youtube";
import { exportToAnki } from "./ankiExport";
import { OcclusionDialog } from "./views/OcclusionDialog";
import { BrowserView } from "./views/BrowserView";

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/** What the reader pane shows. */
type View = { kind: "learn" } | { kind: "inbox" } | { kind: "stats" } | { kind: "browse"; id: number } | { kind: "browser"; query: string };

interface ExternalImport {
  title: string;
  url: string | null;
  html: string;
  priority: number | null;
  site: string | null;
  author: string | null;
}

const SIDEBAR_KEY = "ir.sidebarOpen";
const FOCUS_KEY = "ir.focus";

export default function App() {
  const [view, setView] = useState<View>({ kind: "learn" });
  const [stats, setStats] = useState<Stats | null>(null);
  const [toast, setToast] = useState<{ message: string; undo: boolean } | null>(null);
  /** Bumped by Undo so the open element reloads from the database. */
  const [undoVersion, setUndoVersion] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [version, setVersion] = useState(0);
  const [toolsOpen, setToolsOpen] = useState(false);
  /** Focus mode: no sidebar or toolbars, text centred, read text dimmed. */
  const [focus, setFocus] = useState(() => {
    try {
      return localStorage.getItem(FOCUS_KEY) === "1";
    } catch {
      return false;
    }
  });
  /** Standalone image occlusion from a picked image file. */
  const [occlusionSrc, setOcclusionSrc] = useState<string | null>(null);
  const imagePick = useRef<HTMLInputElement>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const toastTimer = useRef<number | undefined>(undefined);
  const session = useLearnSession();
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const notify: Notify = useCallback((message, opts) => {
    const undo = !!opts?.undo;
    setToast({ message, undo });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), undo ? 8000 : 3000);
  }, []);

  /** Refresh the tree, inbox and counters. */
  const changed = useCallback(() => {
    setVersion((v) => v + 1);
    api.getStats().then(setStats).catch((e) => notify(String(e)));
  }, [notify]);
  useEffect(changed, [changed]);

  /** Undo the last destructive action (Done!, Dismiss, Move, Delete, Postpone, …). */
  const doUndo = useCallback(async () => {
    try {
      const label = await api.undo();
      notify(label ? `Undone: ${label}` : "Nothing to undo");
      if (label) {
        setUndoVersion((v) => v + 1);
        changed();
      }
    } catch (e) {
      notify(`Undo failed: ${e}`);
    }
  }, [changed, notify]);

  // The import window broadcasts when it adds something; the browser
  // extension's pages arrive as raw HTML and are converted here.
  useEffect(() => {
    const unChanged = listen(COLLECTION_CHANGED, changed);
    const unExternal = listen<ExternalImport>("external-import", async ({ payload }) => {
      try {
        // A YouTube page from the browser extension becomes an incremental video.
        const vid = payload.url ? youtubeId(payload.url) : null;
        if (vid) {
          const info = await fetchVideoInfo(vid);
          await api.importTopic({
            title: info.title,
            doc_json: JSON.stringify(info.transcript ?? EMPTY_DOC),
            priority: payload.priority ?? 50,
            url: payload.url,
            site: "YouTube",
            author: info.author,
            inbox: true,
            video_id: vid,
          });
          notify(`Inbox: video “${info.title}”`);
          return changed();
        }
        await api.importTopic({
          title: payload.title,
          doc_json: JSON.stringify(htmlToDoc(payload.html)),
          priority: payload.priority ?? 50,
          url: payload.url,
          site: payload.site,
          author: payload.author,
          inbox: true,
        });
        notify(`Inbox: “${payload.title}”`);
        changed();
      } catch (e) {
        notify(`Import from browser failed: ${e}`);
      }
    });
    return () => {
      void unChanged.then((f) => f());
      void unExternal.then((f) => f());
    };
  }, [changed, notify]);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((o) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, o ? "0" : "1");
      } catch {
        /* storage unavailable: just don't remember */
      }
      return !o;
    });
  }, []);

  const toggleFocus = useCallback(() => {
    setFocus((f) => {
      try {
        localStorage.setItem(FOCUS_KEY, f ? "0" : "1");
      } catch {
        /* not remembered */
      }
      return !f;
    });
  }, []);

  const exportAll = useCallback(async () => {
    try {
      notify("Exporting to Anki…");
      const { path, count } = await exportToAnki(null);
      notify(`Exported ${count} items: ${path}`);
    } catch (e) {
      notify(`Anki export: ${e}`);
    }
  }, [notify]);

  const pickedImage = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      try {
        const ext = file.name.split(".").pop() ?? "png";
        setOcclusionSrc(await api.saveAsset(await file.arrayBuffer(), ext));
      } catch (e) {
        notify(String(e));
      }
    },
    [notify],
  );

  const learn = useCallback(() => {
    setView({ kind: "learn" });
    const s = sessionRef.current;
    if (s.queue == null || s.pos >= s.queue.length) void s.load().then((m) => m && notify(m));
  }, [notify]);
  const open = useCallback((id: number) => setView({ kind: "browse", id }), []);
  /** The element browser with a search (e.g. `under:12`, `is:due`). */
  const browser = useCallback((query = "is:active") => setView({ kind: "browser", query }), []);

  /** Start a subset review (branch, search results) in the Learn pane. */
  const review = useCallback(
    async (label: string, entries: Promise<QueueEntry[]>) => {
      try {
        const list = await entries;
        if (!list.length) return notify("Nothing active to review there");
        sessionRef.current.startSubset(label, list);
        setView({ kind: "learn" });
      } catch (e) {
        notify(String(e));
      }
    },
    [notify],
  );
  const reviewBranch = useCallback(
    async (id: number) => {
      const el = await api.getElement(id);
      void review(`Branch “${el.title}”`, api.branchesQueue([id], false));
    },
    [review],
  );

  const doImport = useCallback(() => {
    openImportWindow().catch((e) => notify(`Could not open import window: ${e}`));
  }, [notify]);

  /** Standalone Q&A item (Alt+A works inside a topic to attach it there). */
  const newItem = useCallback(async () => {
    const empty = JSON.stringify(EMPTY_DOC);
    const id = await api.createItem(null, "qa", empty, empty);
    changed();
    open(id);
  }, [changed, open]);

  /** User-written topic: a note, or a root to organize other elements under. */
  const newTopic = useCallback(async () => {
    const title = window.prompt("New top-level topic (a root or a note)", "");
    if (title == null) return;
    const id = await api.createTopic(null, title, JSON.stringify(EMPTY_DOC));
    changed();
    open(id);
  }, [changed, open]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const k = ev.key.toLowerCase();
      if (ev.ctrlKey && !ev.shiftKey && k === "l") ev.preventDefault(), learn();
      else if (ev.ctrlKey && !ev.shiftKey && k === "n") ev.preventDefault(), doImport();
      else if (ev.ctrlKey && ev.shiftKey && k === "n") ev.preventDefault(), void newItem();
      else if (ev.ctrlKey && ev.key === "\\") ev.preventDefault(), toggleSidebar();
      else if (ev.ctrlKey && !ev.shiftKey && k === "k") ev.preventDefault(), setPaletteOpen(true);
      else if (ev.ctrlKey && ev.shiftKey && k === "f") ev.preventDefault(), toggleFocus();
      else if (ev.ctrlKey && ev.shiftKey && k === "b") ev.preventDefault(), browser();
      else if (ev.key === "Escape" && focus && !document.querySelector(".modal-backdrop")) toggleFocus();
      // Ctrl+Z outside a text field undoes the last tree/schedule action; inside, the editor's own undo applies.
      else if (ev.ctrlKey && !ev.shiftKey && k === "z" && !isTyping(ev.target)) ev.preventDefault(), void doUndo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [browser, doImport, doUndo, focus, learn, newItem, toggleFocus, toggleSidebar]);

  const currentIdForPalette = () => (view.kind === "browse" ? view.id : view.kind === "learn" ? session.queue?.[session.pos]?.id ?? null : null);
  const commands: Command[] = [
    { label: "Learn: today's queue", hint: "Ctrl+L", run: learn },
    { label: "Inbox", run: () => setView({ kind: "inbox" }) },
    { label: "Browser: priority queue", hint: "Ctrl+Shift+B", run: () => browser("is:active") },
    { label: "Browser: due today", run: () => browser("is:due") },
    { label: "Browser: leeches", run: () => browser("is:leech") },
    { label: "Browser: needs work", run: () => browser("is:needs-work") },
    ...(currentIdForPalette() != null
      ? [{ label: "Browser: descendants of the open element", run: () => browser(`under:${currentIdForPalette()}`) }]
      : []),
    { label: "Import…", hint: "Ctrl+N", run: doImport },
    { label: "New topic", run: () => void newTopic() },
    { label: "New item", hint: "Ctrl+Shift+N", run: () => void newItem() },
    { label: "Statistics", run: () => setView({ kind: "stats" }) },
    { label: "Tools: postpone, mercy, settings, backup", run: () => setToolsOpen(true) },
    { label: "Toggle sidebar", hint: "Ctrl+\\", run: toggleSidebar },
    { label: focus ? "Leave focus mode" : "Focus mode", hint: "Ctrl+Shift+F", run: toggleFocus },
    { label: "Time box: fit today's session into N minutes", run: () => {
      learn();
      const v = window.prompt("How many minutes do you have?", "20");
      const m = v == null ? NaN : Number(v);
      if (m > 0) notify(`Time box: ${sessionRef.current.timebox(m)} elements in ${m} min`);
    } },
    { label: "New image occlusion from a file…", run: () => imagePick.current?.click() },
    { label: "Export all items to Anki (.apkg)", run: () => void exportAll() },
    { label: "Undo last action", hint: "Ctrl+Z", run: () => void doUndo() },
    { label: "Reload today's queue", run: () => void session.load().then((m) => m && notify(m)) },
    { label: "Back up the collection", run: () => void api.backup().then((p) => notify(`Backup written: ${p}`)) },
  ];

  const currentId = view.kind === "browse" ? view.id : view.kind === "learn" ? session.queue?.[session.pos]?.id ?? null : null;
  const [branch, setBranch] = useState<{ id: number; title: string } | null>(null);
  useEffect(() => {
    if (currentId == null) return setBranch(null);
    api.getElement(currentId).then((el) => setBranch({ id: el.id, title: el.title })).catch(() => setBranch(null));
  }, [currentId]);

  const left = session.queue ? session.queue.length - session.pos : 0;

  return (
    <TodayContext.Provider value={stats?.today ?? null}>
    <div className={`app ${focus ? "focus" : ""}`}>
      <nav className="topnav">
        <button className="icon" onClick={toggleSidebar} title="Toggle sidebar (Ctrl+\)">☰</button>
        <strong className="brand">IR</strong>
        <button className={view.kind === "learn" ? "active" : ""} onClick={learn} title="Ctrl+L">
          Learn {left > 0 && <span className="count">{left}</span>}
        </button>
        <button className={view.kind === "inbox" ? "active" : ""} onClick={() => setView({ kind: "inbox" })} title="New imports waiting for a priority">
          Inbox {!!stats?.inbox && <span className="count">{stats.inbox}</span>}
        </button>
        <button onClick={doImport} title="Opens the import window (Ctrl+N)">Import</button>
        <button onClick={newTopic} title="New topic: a note, or a root to organize under">New topic</button>
        <button onClick={newItem} title="New Q&A item (Ctrl+Shift+N)">New item</button>
        <button className={view.kind === "browser" ? "active" : ""} onClick={() => browser()} title="Search, filter and act on everything (Ctrl+Shift+B)">
          Browser
        </button>
        <button className={view.kind === "stats" ? "active" : ""} onClick={() => setView({ kind: "stats" })}>Stats</button>
        <button onClick={() => setToolsOpen(true)}>Tools</button>
        <button className="icon" onClick={() => setPaletteOpen(true)} title="Command palette (Ctrl+K)">⌘K</button>
        <span className="spacer" />
        {stats && (
          <span className="small muted">
            due {stats.due_topics} T · {stats.due_items} Q — total {stats.total_topics} T / {stats.total_items} Q
          </span>
        )}
      </nav>
      <div className="workspace">
        {sidebarOpen && !focus && stats && (
          <Sidebar
            today={stats.today}
            version={version}
            openId={currentId}
            onOpen={open}
            onBrowse={browser}
            onReview={review}
            onChanged={changed}
            notify={notify}
          />
        )}
        <main>
          {view.kind === "learn" && (
            <LearnView
              key={undoVersion}
              session={session}
              notify={notify}
              onOpen={open}
              onChanged={changed}
              onReviewBranch={reviewBranch}
              onOverload={() => setToolsOpen(true)}
            />
          )}
          {view.kind === "stats" && <StatsView version={version} />}
          {view.kind === "browser" && stats && (
            <BrowserView
              initialQuery={view.query}
              today={stats.today}
              version={version}
              notify={notify}
              onOpen={open}
              onReview={review}
              onChanged={changed}
              onReviewBranch={reviewBranch}
            />
          )}
          {view.kind === "inbox" && <InboxView version={version} notify={notify} onChanged={changed} onOpen={open} />}
          {view.kind === "browse" && (
            <BrowseView
              key={undoVersion}
              id={view.id}
              notify={notify}
              onOpen={open}
              onChanged={changed}
              onReviewBranch={reviewBranch}
              onDeleted={() => {
                changed();
                learn();
              }}
            />
          )}
        </main>
      </div>
      {focus && (
        <button className="focus-exit small-btn" onClick={toggleFocus} title="Leave focus mode (Esc or Ctrl+Shift+F)">
          ✕ focus
        </button>
      )}
      <input ref={imagePick} type="file" accept="image/*" hidden onChange={(e) => (void pickedImage(e.target.files?.[0]), (e.target.value = ""))} />
      {occlusionSrc && (
        <OcclusionDialog
          src={occlusionSrc}
          parentId={null}
          title="Image"
          notify={notify}
          onClose={() => setOcclusionSrc(null)}
          onCreated={(ids) => {
            setOcclusionSrc(null);
            changed();
            if (ids[0]) open(ids[0]);
          }}
        />
      )}
      {toolsOpen && <ToolsDialog branch={branch} onClose={() => setToolsOpen(false)} onChanged={changed} notify={notify} />}
      {paletteOpen && <CommandPalette commands={commands} onOpenElement={open} onClose={() => setPaletteOpen(false)} />}
      {toast && (
        <div className="toast">
          <span>{toast.message}</span>
          {toast.undo && (
            <button className="toast-undo" onClick={() => (setToast(null), void doUndo())}>
              Undo <kbd>Ctrl+Z</kbd>
            </button>
          )}
        </div>
      )}
    </div>
    </TodayContext.Provider>
  );
}
