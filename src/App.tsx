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

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/** What the reader pane shows. */
type View = { kind: "learn" } | { kind: "inbox" } | { kind: "stats" } | { kind: "browse"; id: number };

interface ExternalImport {
  title: string;
  url: string | null;
  html: string;
  priority: number | null;
  site: string | null;
  author: string | null;
}

const SIDEBAR_KEY = "ir.sidebarOpen";

export default function App() {
  const [view, setView] = useState<View>({ kind: "learn" });
  const [stats, setStats] = useState<Stats | null>(null);
  const [toast, setToast] = useState<{ message: string; undo: boolean } | null>(null);
  /** Bumped by Undo so the open element reloads from the database. */
  const [undoVersion, setUndoVersion] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [version, setVersion] = useState(0);
  const [toolsOpen, setToolsOpen] = useState(false);
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

  const learn = useCallback(() => {
    setView({ kind: "learn" });
    const s = sessionRef.current;
    if (s.queue == null || s.pos >= s.queue.length) void s.load().then((m) => m && notify(m));
  }, [notify]);
  const open = useCallback((id: number) => setView({ kind: "browse", id }), []);

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
      // Ctrl+Z outside a text field undoes the last tree/schedule action; inside, the editor's own undo applies.
      else if (ev.ctrlKey && !ev.shiftKey && k === "z" && !isTyping(ev.target)) ev.preventDefault(), void doUndo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doImport, doUndo, learn, newItem, toggleSidebar]);

  const commands: Command[] = [
    { label: "Learn: today's queue", hint: "Ctrl+L", run: learn },
    { label: "Inbox", run: () => setView({ kind: "inbox" }) },
    { label: "Import…", hint: "Ctrl+N", run: doImport },
    { label: "New topic", run: () => void newTopic() },
    { label: "New item", hint: "Ctrl+Shift+N", run: () => void newItem() },
    { label: "Statistics", run: () => setView({ kind: "stats" }) },
    { label: "Tools: postpone, mercy, settings, backup", run: () => setToolsOpen(true) },
    { label: "Toggle sidebar", hint: "Ctrl+\\", run: toggleSidebar },
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
    <div className="app">
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
        {sidebarOpen && stats && (
          <Sidebar today={stats.today} version={version} openId={currentId} onOpen={open} onReview={review} onChanged={changed} notify={notify} />
        )}
        <main>
          {view.kind === "learn" && (
            <LearnView key={undoVersion} session={session} notify={notify} onOpen={open} onChanged={changed} onReviewBranch={reviewBranch} />
          )}
          {view.kind === "stats" && <StatsView version={version} />}
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
