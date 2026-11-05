import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, bandOf, fmtDays, LEECH_LAPSES, type BrowseRow, type BulkAction, type QueueEntry, type TreeNode } from "../api";
import { parseQuery, PRESETS, SORTS, type Ctx, type SortKey } from "../browserQuery";
import { exportToAnki } from "../ankiExport";
import { isTyping } from "../keys";
import type { Notify } from "../notify";
import { BrowseView } from "./BrowseView";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { MoveDialog } from "./MoveDialog";

interface Props {
  /** Query to start with (e.g. `under:12` from the tree). Changing it replaces the search. */
  initialQuery: string;
  today: number;
  version: number;
  notify: Notify;
  onOpen: (id: number) => void;
  onReview: (label: string, entries: Promise<QueueEntry[]>) => void;
  onChanged: () => void;
  onReviewBranch: (id: number) => void;
}

const COLUMNS: { key: SortKey; label: string; title?: string; cls?: string }[] = [
  { key: "rank", label: "#", title: "Position in the priority queue", cls: "num" },
  { key: "kind", label: "", title: "Type" },
  { key: "title", label: "Title" },
  { key: "priority", label: "Prio", cls: "num" },
  { key: "due", label: "Due", cls: "num" },
  { key: "interval", label: "Ivl", title: "Interval", cls: "num" },
  { key: "afactor", label: "AF", title: "A-Factor (topics)", cls: "num" },
  { key: "reps", label: "Reps", title: "Repetitions (item grades or topic reads)", cls: "num" },
  { key: "lapses", label: "Lapses", cls: "num" },
  { key: "updated", label: "Edited", cls: "num" },
];

const PAGE = 400;
const ago = (ts: number, now: number) => fmtDays(Math.round((now - ts) / 86400));

/**
 * The element browser: one searchable, sortable table of everything, with a
 * preview of the selected element. Multi-purpose: the priority queue, a
 * branch's descendants, leeches, due elements, any search; then act on the
 * selection in bulk or review it.
 */
export function BrowserView({ initialQuery, today, version, notify, onOpen, onReview, onChanged, onReviewBranch }: Props) {
  const [rows, setRows] = useState<BrowseRow[]>([]);
  const [query, setQuery] = useState(initialQuery);
  const [applied, setApplied] = useState(initialQuery);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "rank", desc: false });
  const [textHits, setTextHits] = useState<Set<number> | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [moving, setMoving] = useState<{ ids: number[]; nodes: TreeNode[] } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const table = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setQuery(initialQuery);
    setApplied(initialQuery);
  }, [initialQuery]);

  useEffect(() => {
    api.browseRows().then(setRows).catch((e) => notify(String(e)));
  }, [version, notify]);

  // Search as you type (debounced).
  useEffect(() => {
    const t = window.setTimeout(() => setApplied(query), 250);
    return () => window.clearTimeout(t);
  }, [query]);

  const parsed = useMemo(() => parseQuery(applied), [applied]);
  useEffect(() => {
    if (!parsed.text) return setTextHits(null);
    let live = true;
    api.search(parsed.text).then((ids) => live && setTextHits(new Set(ids)));
    return () => {
      live = false;
    };
  }, [parsed.text, version]);

  const children = useMemo(() => {
    const m = new Map<number | null, number[]>();
    for (const r of rows) {
      const k = r.parent_id ?? null;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r.id);
    }
    return m;
  }, [rows]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  const shown = useMemo(() => {
    const ctx: Ctx = { today, now: Date.now() / 1000, children, textHits: parsed.text ? textHits ?? new Set() : null };
    const out = rows.filter((r) => parsed.test(r, ctx));
    const f = SORTS[sort.key];
    out.sort((a, b) => {
      const x = f(a);
      const y = f(b);
      const c = x < y ? -1 : x > y ? 1 : a.prank - b.prank;
      return sort.desc ? -c : c;
    });
    return out;
  }, [children, parsed, rows, sort, textHits, today]);

  useEffect(() => setLimit(PAGE), [applied, sort]);
  // Drop selections that left the result.
  useEffect(() => {
    const visible = new Set(shown.map((r) => r.id));
    setSelected((s) => {
      const kept = new Set([...s].filter((id) => visible.has(id)));
      return kept.size === s.size ? s : kept;
    });
  }, [shown]);

  const indexOf = useMemo(() => new Map(shown.map((r, i) => [r.id, i])), [shown]);
  const ordered = useCallback((s: Set<number>) => [...s].sort((a, b) => (indexOf.get(a) ?? 0) - (indexOf.get(b) ?? 0)), [indexOf]);

  const pick = (id: number, ev: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    setCursor(id);
    if (ev.shiftKey && anchor != null) {
      const [a, b] = [indexOf.get(anchor) ?? 0, indexOf.get(id) ?? 0].sort((x, y) => x - y);
      const range = shown.slice(a, b + 1).map((r) => r.id);
      setSelected(ev.ctrlKey || ev.metaKey ? new Set([...selected, ...range]) : new Set(range));
    } else if (ev.ctrlKey || ev.metaKey) {
      const next = new Set(selected);
      next.has(id) ? next.delete(id) : next.add(id);
      setSelected(next);
      setAnchor(id);
    } else {
      setSelected(new Set([id]));
      setAnchor(id);
    }
    document.getElementById(`brow-${id}`)?.scrollIntoView({ block: "nearest" });
  };

  const sel = ordered(selected);
  const setSearch = (q: string, s?: { key: SortKey; desc: boolean }) => {
    setQuery(q);
    setApplied(q);
    if (s) setSort(s);
  };

  // ----- actions -----

  const run = async (label: string, fn: () => Promise<unknown>, undo = true) => {
    try {
      await fn();
      onChanged();
      if (label) notify(label, undo ? { undo: true } : undefined);
    } catch (e) {
      notify(String(e));
    }
  };
  const bulk = (action: BulkAction, priority?: number) => {
    const words: Record<BulkAction, string> = {
      dismiss: "Dismissed", done: "Marked done", restore: "Restored", delete: "Deleted", priority: "Priority set", read_today: "Scheduled for today",
    };
    return run(`${words[action]}: ${sel.length}`, () => api.bulk(sel, action, priority));
  };
  const askPriority = () => {
    const first = byId.get(sel[0]);
    const v = window.prompt(`Priority for ${sel.length} element(s), 0 = most important`, String(Math.round(first?.priority ?? 50)));
    const n = v == null ? NaN : Number(v);
    if (!Number.isNaN(n)) void bulk("priority", Math.max(0, Math.min(100, n)));
  };
  const askAfactor = () => {
    const topics = sel.filter((id) => byId.get(id)?.kind === "topic");
    const first = byId.get(topics[0]);
    const v = window.prompt(`A-Factor for ${topics.length} topic(s), 1.05–5 (higher = read less often)`, (first?.afactor ?? 1.5).toFixed(2));
    const n = v == null ? NaN : Number(v.replace(",", "."));
    if (!Number.isNaN(n)) void run(`A-Factor ${n.toFixed(2)}: ${topics.length} topic(s)`, () => Promise.all(topics.map((id) => api.setAfactor(id, n))), false);
  };
  const askDelete = () => {
    if (window.confirm(`Delete ${sel.length} element(s)? Children that aren't selected move to the top level. (You can undo right after.)`)) void bulk("delete");
  };
  /** Active selected elements, as a review session in the Learn pane (in the table's order). */
  const reviewSelection = () => {
    const ids = (sel.length > 1 ? sel : shown.map((r) => r.id)).filter((id) => byId.get(id)?.status === "active");
    if (!ids.length) return notify("Nothing active to review");
    const entries: QueueEntry[] = ids.map((id) => {
      const r = byId.get(id)!;
      return { id, kind: r.kind, title: r.title, priority: r.priority, due_day: r.due_day ?? today };
    });
    onReview(sel.length > 1 ? `${ids.length} selected` : `Browser: ${applied || "everything"}`, Promise.resolve(entries));
  };
  const showDescendants = (ids: number[]) => setSearch(`under:${ids.join(",")}`, { key: "rank", desc: false });
  const setFlag = (flag: "needs_work" | "pinned", value: boolean) =>
    run("", () => Promise.all(sel.map((id) => api.setFlag(id, flag, value))), false);
  const exportSel = async () => {
    try {
      const { path, count } = await exportToAnki(sel.length ? sel : shown.map((r) => r.id));
      notify(`Exported ${count} items: ${path}`);
    } catch (e) {
      notify(`Anki export: ${e}`);
    }
  };
  /** Top-most selected elements (a selected child moves with its selected ancestor). */
  const topMost = (ids: number[]) => {
    const set = new Set(ids);
    return ids.filter((id) => {
      for (let p = byId.get(id)?.parent_id ?? null; p != null; p = byId.get(p)?.parent_id ?? null) if (set.has(p)) return false;
      return true;
    });
  };
  const startMove = async () => setMoving({ ids: topMost(sel), nodes: await api.getTree() });

  const menuEntries = (): MenuEntry[] => {
    const n = sel.length > 1 ? ` (${sel.length})` : "";
    const one = sel.length === 1 ? byId.get(sel[0]) : null;
    const anyItem = sel.some((id) => byId.get(id)?.kind === "item");
    const allWork = sel.every((id) => byId.get(id)?.needs_work);
    const anyActive = sel.some((id) => byId.get(id)?.status === "active");
    const anyInactive = sel.some((id) => byId.get(id)?.status !== "active");
    return [
      ...(one ? [{ label: "Open in the reader", onClick: () => onOpen(one.id), hint: "Enter" } as MenuEntry] : []),
      { label: `Show descendants${n}`, onClick: () => showDescendants(sel), hint: "D" },
      ...(one?.parent_id != null
        ? [
            { label: "Show parent", onClick: () => setSearch(`id:${one.parent_id}`) } as MenuEntry,
            { label: "Show siblings", onClick: () => setSearch(`child:${one.parent_id}`) } as MenuEntry,
          ]
        : []),
      ...(one && one.children > 0 ? [{ label: "Review branch", onClick: () => onReviewBranch(one.id) } as MenuEntry] : []),
      { label: `Review selected${n}`, onClick: reviewSelection, hint: "R" },
      "separator",
      { label: `Set priority…${n}`, onClick: askPriority, hint: "P" },
      { label: `Review today${n}`, onClick: () => bulk("read_today"), disabled: !anyActive },
      ...(sel.some((id) => byId.get(id)?.kind === "topic") ? [{ label: `Set A-Factor…${n}`, onClick: askAfactor, hint: "A" } as MenuEntry] : []),
      { label: `Move to…${n}`, onClick: () => void startMove(), hint: "M" },
      ...(anyItem ? [{ label: allWork ? `Clear “needs work”${n}` : `Flag “needs work”${n}`, onClick: () => setFlag("needs_work", !allWork) } as MenuEntry] : []),
      ...(anyActive ? ([{ label: `Dismiss${n}`, onClick: () => bulk("dismiss") }, { label: `Done!${n}`, onClick: () => bulk("done") }] as MenuEntry[]) : []),
      ...(anyInactive ? [{ label: `Restore${n}`, onClick: () => bulk("restore") } as MenuEntry] : []),
      { label: `Export to Anki${n}`, onClick: () => void exportSel() },
      "separator",
      { label: `Delete…${n}`, onClick: askDelete, danger: true, hint: "Del" },
    ];
  };

  // ----- keyboard -----

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (isTyping(ev.target)) return;
    const idx = cursor != null ? indexOf.get(cursor) ?? -1 : -1;
    const go = (i: number) => {
      const r = shown[Math.max(0, Math.min(shown.length - 1, i))];
      if (r) pick(r.id, { shiftKey: ev.shiftKey, ctrlKey: false, metaKey: false });
    };
    const k = ev.key;
    if (k === "ArrowDown") go(idx + 1);
    else if (k === "ArrowUp") go(idx < 0 ? 0 : idx - 1);
    else if (k === "PageDown") go(idx + 15);
    else if (k === "PageUp") go(idx - 15);
    else if (k === "Home") go(0);
    else if (k === "End") go(shown.length - 1);
    else if (k === "Enter" && cursor != null) onOpen(cursor);
    else if (k === "Delete" && sel.length) askDelete();
    else if (k.toLowerCase() === "d" && sel.length) showDescendants(sel);
    else if (k.toLowerCase() === "p" && sel.length) askPriority();
    else if (k.toLowerCase() === "a" && !ev.ctrlKey && !ev.metaKey && sel.length) askAfactor();
    else if (k.toLowerCase() === "m" && sel.length) void startMove();
    else if (k.toLowerCase() === "r") reviewSelection();
    else if (k === "a" && (ev.ctrlKey || ev.metaKey)) setSelected(new Set(shown.map((r) => r.id)));
    else if (k === "/") input.current?.focus();
    else if (k === "Escape") setSelected(new Set());
    else if (k === "ContextMenu" || (k === "F10" && ev.shiftKey)) setMenu({ x: 200, y: 200 });
    else return;
    ev.preventDefault();
  };

  const header = (c: (typeof COLUMNS)[number]) => (
    <th
      key={c.key}
      className={`${c.cls ?? ""} ${sort.key === c.key ? "sorted" : ""}`}
      title={c.title ? `${c.title} — click to sort` : "Click to sort"}
      onClick={() => setSort((s) => ({ key: c.key, desc: s.key === c.key ? !s.desc : c.key === "updated" || c.key === "lapses" }))}
    >
      {c.label}
      {sort.key === c.key ? (sort.desc ? " ▾" : " ▴") : ""}
    </th>
  );

  const now = Date.now() / 1000;
  const preview = cursor != null && byId.has(cursor) ? cursor : sel[0] ?? null;

  return (
    <div className="browser">
      <div className="browser-bar">
        <input
          ref={input}
          className="browser-query"
          placeholder="Search: words, is:due, is:leech, under:12, prio<20, due<=0, lapses>=4, added<7 …  (/ to focus)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") setApplied(query), table.current?.focus();
            if (e.key === "Escape") setQuery("");
            if (e.key === "ArrowDown") e.preventDefault(), table.current?.focus();
          }}
        />
        <span className="small muted mono">
          {shown.length} / {rows.length}
        </span>
        <button className="small-btn" onClick={() => setPreviewOpen((o) => !o)} title="Show or hide the preview">
          {previewOpen ? "Hide preview" : "Preview"}
        </button>
      </div>
      <div className="browser-presets">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            className={`chip-btn ${applied === p.query ? "active" : ""}`}
            onClick={() => setSearch(p.query, p.sort ? { key: p.sort, desc: !!p.desc } : undefined)}
          >
            {p.label}
          </button>
        ))}
        {parsed.errors.length > 0 && <span className="warn-text small">{parsed.errors.join("; ")}</span>}
      </div>
      {sel.length > 0 && (
        <div className="browser-actions small">
          <span className="muted">{sel.length} selected</span>
          <button className="small-btn" onClick={() => showDescendants(sel)} title="D">Descendants</button>
          <button className="small-btn" onClick={reviewSelection} title="R">Review</button>
          <button className="small-btn" onClick={askPriority} title="P">Priority…</button>
          <button className="small-btn" onClick={() => bulk("read_today")}>Today</button>
          <button className="small-btn" onClick={() => void startMove()} title="M">Move…</button>
          <button className="small-btn" onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })}>More ▾</button>
        </div>
      )}
      <div className="browser-split">
        <div className="browser-table" ref={table} tabIndex={0} onKeyDown={onKeyDown}>
          <table>
            <thead>
              <tr>{COLUMNS.map(header)}</tr>
            </thead>
            <tbody>
              {shown.slice(0, limit).map((r) => {
                const due = r.due_day == null || r.subtype === "note" ? "" : r.status !== "active" ? r.status : fmtDays(r.due_day - today);
                const overdue = r.status === "active" && r.due_day != null && r.due_day < today && r.subtype !== "note";
                return (
                  <tr
                    key={r.id}
                    id={`brow-${r.id}`}
                    className={`${selected.has(r.id) ? "selected" : ""} ${cursor === r.id ? "cursor" : ""} ${r.status}`}
                    onClick={(e) => pick(r.id, e)}
                    onDoubleClick={() => onOpen(r.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (!selected.has(r.id)) pick(r.id, { shiftKey: false, ctrlKey: false, metaKey: false });
                      setMenu({ x: e.clientX, y: e.clientY });
                    }}
                  >
                    <td className="num muted">{r.status === "active" ? Math.round(r.prank) : ""}</td>
                    <td title={`${r.subtype}${r.status === "active" ? ` · ${bandOf(r.priority).label} priority` : ""}`}>
                      <span className={`badge ${r.kind} band-${r.status === "active" ? bandOf(r.priority).name : "none"}`}>{r.kind === "item" ? "Q" : r.subtype[0].toUpperCase()}</span>
                    </td>
                    <td className="title-cell" title={r.title}>
                      {r.pinned && "📌 "}
                      {r.title}
                      {r.children > 0 && <span className="muted small"> · {r.children}</span>}
                      {r.kind === "item" && r.lapses >= LEECH_LAPSES && <span className="marker warn" title="Leech"> ⚠</span>}
                      {r.needs_work && <span className="marker" title="Needs work"> ✎</span>}
                    </td>
                    <td className="num">{r.status === "active" || r.status === "inbox" ? `${Math.round(r.priority)}%` : ""}</td>
                    <td className={`num ${overdue ? "warn-text" : ""}`}>{due}</td>
                    <td className="num">{r.interval_days != null && r.subtype !== "note" ? fmtDays(r.interval_days) : ""}</td>
                    <td className="num">{r.afactor != null && r.subtype !== "note" ? r.afactor.toFixed(2) : ""}</td>
                    <td className="num">{r.reps || ""}</td>
                    <td className="num">{r.lapses || ""}</td>
                    <td className="num muted">{ago(r.updated_at, now)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {shown.length > limit && (
            <button className="show-more" onClick={() => setLimit((l) => l + PAGE)}>
              Show {Math.min(PAGE, shown.length - limit)} more of {shown.length - limit}
            </button>
          )}
          {shown.length === 0 && <p className="muted pad small">No elements match. Try a preset above, or clear the search.</p>}
        </div>
        {previewOpen && (
          <div className="browser-preview">
            {preview != null ? (
              <BrowseView
                key={preview}
                id={preview}
                notify={notify}
                onOpen={onOpen}
                onChanged={onChanged}
                onReviewBranch={onReviewBranch}
                onDeleted={() => {
                  setCursor(null);
                  onChanged();
                }}
              />
            ) : (
              <div className="muted pad small">
                <p>Select a row to preview and edit it here.</p>
                <p>
                  Click, Ctrl+click and Shift+click to select; ↑/↓ to move; <kbd>D</kbd> descendants, <kbd>R</kbd> review, <kbd>P</kbd> priority,{" "}
                  <kbd>M</kbd> move, <kbd>Enter</kbd> open in the reader; right-click for everything else.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
      {menu && sel.length > 0 && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries()} onClose={() => setMenu(null)} />}
      {moving && (
        <MoveDialog
          nodes={moving.nodes}
          moving={moving.ids}
          onClose={() => setMoving(null)}
          onPick={(p) => {
            const ids = moving.ids;
            setMoving(null);
            void run(`Moved ${ids.length}`, () => api.placeElements(ids, p, null));
          }}
        />
      )}
    </div>
  );
}
