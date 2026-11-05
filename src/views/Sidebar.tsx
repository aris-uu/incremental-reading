import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Notify } from "../notify";
import { api, bandOf, fmtDays, LEECH_LAPSES, type BulkAction, type TreeNode } from "../api";
import { exportToAnki } from "../ankiExport";
import { EMPTY_DOC } from "../editor/extensions";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { MoveDialog } from "./MoveDialog";

interface Props {
  today: number;
  version: number;
  /** Element shown in the reader. */
  openId: number | null;
  onOpen: (id: number) => void;
  /** Open the element browser with a search. */
  onBrowse: (query: string) => void;
  onReview: (label: string, entries: Promise<import("../api").QueueEntry[]>) => void;
  onChanged: () => void;
  notify: Notify;
}

const DRAG_TYPE = "application/x-ir-elements";
const SORT_KEY = "ir.treeSort";
const FILTER_KEY = "ir.treeFilter";

const FILTERS = {
  all: "Everything",
  due: "Due today",
  overdue: "Overdue",
  items: "Items only",
  leeches: "Leeches",
  needs_work: "Needs work",
  pdf: "PDFs",
  video: "Videos",
  recent: "Edited this week",
} as const;
type Filter = keyof typeof FILTERS;
/** Where a drag would land: before/after a row (reorder) or into it (reparent). */
type DropTarget = { id: number; zone: "before" | "into" | "after" };
const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA"].includes(t.tagName));

/**
 * Knowledge tree: source → extracts → items, plus user topics (notes, roots).
 * Click opens; Ctrl+click toggles; Shift+click selects a range. Right-click
 * for actions, drag to reorganize, arrow keys to move.
 */
export function Sidebar({ today, version, openId, onOpen, onBrowse, onReview, onChanged, notify }: Props) {
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Set<number> | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; target: number | null } | null>(null);
  const [moving, setMoving] = useState<number[] | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | "root" | null>(null);
  const [sortMode, setSortMode] = useState<"manual" | "priority">(() => {
    try {
      return localStorage.getItem(SORT_KEY) === "priority" ? "priority" : "manual";
    } catch {
      return "manual";
    }
  });
  const bodyRef = useRef<HTMLDivElement>(null);
  const [filter, setFilterState] = useState<Filter>(() => {
    try {
      const f = localStorage.getItem(FILTER_KEY) as Filter | null;
      return f && f in FILTERS ? f : "all";
    } catch {
      return "all";
    }
  });
  const setFilter = (f: Filter) => {
    setFilterState(f);
    try {
      localStorage.setItem(FILTER_KEY, f);
    } catch {
      /* not remembered */
    }
  };
  const weekAgo = Date.now() / 1000 - 7 * 86400;
  const passes = (n: TreeNode): boolean => {
    const due = n.status === "active" && n.due_day != null && !(n.kind === "topic" && n.empty && !n.pdf);
    switch (filter) {
      case "due":
        return due && n.due_day! <= today;
      case "overdue":
        return due && n.due_day! < today;
      case "items":
        return n.kind === "item";
      case "leeches":
        return n.kind === "item" && n.lapses >= LEECH_LAPSES;
      case "needs_work":
        return n.needs_work;
      case "pdf":
        return n.pdf;
      case "video":
        return n.video;
      case "recent":
        return n.updated_at >= weekAgo;
      default:
        return true;
    }
  };

  const changeSort = (m: "manual" | "priority") => {
    setSortMode(m);
    try {
      localStorage.setItem(SORT_KEY, m);
    } catch {
      /* not remembered */
    }
  };

  useEffect(() => {
    api.getTree().then(setNodes);
  }, [version]);

  useEffect(() => {
    const q = query.trim();
    if (!q) return setMatches(null);
    const t = window.setTimeout(() => api.search(q).then((ids) => setMatches(new Set(ids))), 200);
    return () => window.clearTimeout(t);
  }, [query, version]);

  const { byId, children, parentOf } = useMemo(() => {
    const byId = new Map<number, TreeNode>();
    const children = new Map<number | null, TreeNode[]>();
    const parentOf = new Map<number, number | null>();
    for (const n of nodes) {
      byId.set(n.id, n);
      const k = n.parent_id ?? null;
      parentOf.set(n.id, k);
      if (!children.has(k)) children.set(k, []);
      children.get(k)!.push(n);
    }
    // The server returns manual order; the priority view only re-sorts for display.
    if (sortMode === "priority") for (const list of children.values()) list.sort((a, b) => a.priority - b.priority || a.position - b.position);
    // Pinned roots stay at the top.
    children.get(null)?.sort((a, b) => Number(b.pinned) - Number(a.pinned));
    return { byId, children, parentOf };
  }, [nodes, sortMode]);

  // Drop selections of elements that no longer exist.
  useEffect(() => {
    setSelected((s) => {
      const kept = new Set([...s].filter((id) => byId.has(id)));
      return kept.size === s.size ? s : kept;
    });
  }, [byId]);

  // Follow the reader: the open element becomes the selection and is revealed.
  useEffect(() => {
    if (openId == null) return;
    setSelected((s) => (s.has(openId) ? s : new Set([openId])));
    setCursor(openId);
    setAnchor((a) => a ?? openId);
    setCollapsed((c) => {
      if (c.size === 0) return c;
      const next = new Set(c);
      for (let p = parentOf.get(openId) ?? null; p != null; p = parentOf.get(p) ?? null) next.delete(p);
      return next;
    });
  }, [openId, parentOf]);

  const visible = useMemo(() => {
    const memo = new Map<number, boolean>();
    const visit = (n: TreeNode): boolean => {
      const self = (showInactive || n.status === "active") && (!matches || matches.has(n.id)) && passes(n);
      const kids = (children.get(n.id) ?? []).map(visit).some(Boolean);
      memo.set(n.id, self || kids);
      return self || kids;
    };
    (children.get(null) ?? []).forEach(visit);
    return memo;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children, matches, showInactive, filter, today]);

  const isOpen = useCallback((id: number) => !!matches || filter !== "all" || !collapsed.has(id), [collapsed, filter, matches]);

  /** Rows in display order, for Shift ranges and arrow keys. */
  const flat = useMemo(() => {
    const out: { node: TreeNode; depth: number }[] = [];
    const walk = (list: TreeNode[], depth: number) => {
      for (const n of list) {
        if (!visible.get(n.id)) continue;
        out.push({ node: n, depth });
        if (isOpen(n.id)) walk(children.get(n.id) ?? [], depth + 1);
      }
    };
    walk(children.get(null) ?? [], 0);
    return out;
  }, [children, isOpen, visible]);
  const indexOf = useMemo(() => new Map(flat.map((r, i) => [r.node.id, i])), [flat]);

  const selectRange = (from: number, to: number) => {
    const [a, b] = [indexOf.get(from) ?? 0, indexOf.get(to) ?? 0].sort((x, y) => x - y);
    return new Set(flat.slice(a, b + 1).map((r) => r.node.id));
  };

  const clickRow = (ev: React.MouseEvent, id: number) => {
    bodyRef.current?.focus();
    setCursor(id);
    if (ev.shiftKey && anchor != null) {
      const range = selectRange(anchor, id);
      setSelected(ev.ctrlKey || ev.metaKey ? new Set([...selected, ...range]) : range);
    } else if (ev.ctrlKey || ev.metaKey) {
      const next = new Set(selected);
      next.has(id) ? next.delete(id) : next.add(id);
      setSelected(next);
      setAnchor(id);
    } else {
      setSelected(new Set([id]));
      setAnchor(id);
      onOpen(id);
    }
  };

  const toggle = (id: number) =>
    setCollapsed((c) => {
      const next = new Set(c);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const descendants = useCallback(
    (id: number): number[] => (children.get(id) ?? []).flatMap((k) => [k.id, ...descendants(k.id)]),
    [children],
  );

  // ----- actions on the selection -----

  /** Top-most selected elements (a selected child of a selected parent moves with it). */
  const roots = (ids: number[]) => {
    const set = new Set(ids);
    return ids.filter((id) => {
      for (let p = parentOf.get(id) ?? null; p != null; p = parentOf.get(p) ?? null) if (set.has(p)) return false;
      return true;
    });
  };

  const ordered = (s: Set<number>) => [...s].sort((a, b) => (indexOf.get(a) ?? 0) - (indexOf.get(b) ?? 0));

  /** Run a tree action; all of them are journaled, so the toast offers Undo. */
  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChanged();
      if (label) notify(label, { undo: true });
    } catch (e) {
      notify(String(e));
    }
  };

  const bulk = (ids: number[], action: BulkAction, priority?: number) => {
    const words: Record<BulkAction, string> = {
      dismiss: "Dismissed", done: "Marked done", restore: "Restored", delete: "Deleted", priority: "Priority set", read_today: "Scheduled for today",
    };
    return run(`${words[action]}: ${ids.length}`, () => api.bulk(ids, action, priority));
  };

  const askPriority = (ids: number[]) => {
    const first = byId.get(ids[0]);
    const v = window.prompt(`Priority for ${ids.length} element(s), 0 = most important`, String(Math.round(first?.priority ?? 50)));
    const n = v == null ? NaN : Number(v);
    if (!Number.isNaN(n)) void bulk(ids, "priority", Math.max(0, Math.min(100, n)));
  };

  const askDelete = (ids: number[]) => {
    const top = roots(ids);
    const kids = top.reduce((n, id) => n + descendants(id).filter((d) => !ids.includes(d)).length, 0);
    const what = top.length === 1 ? `“${byId.get(top[0])?.title}”` : `${top.length} elements`;
    const extra = kids ? ` ${kids} descendant(s) that aren't selected will move to the top level.` : "";
    if (window.confirm(`Delete ${what}?${extra} (You can undo right after.)`)) void bulk(ids, "delete");
  };

  const moveTo = (ids: number[], parent: number | null) =>
    run("", async () => {
      const top = roots(ids);
      // Appends at the end of the new parent's children.
      await api.placeElements(top, parent, null);
      notify(`Moved ${top.length} to ${parent == null ? "the top level" : `“${byId.get(parent)?.title}”`}`, { undo: true });
      if (parent != null) setCollapsed((c) => (c.has(parent) ? new Set([...c].filter((x) => x !== parent)) : c));
    });

  /** Reorder: put `ids` under `parent`, before sibling `before` (null = last). */
  const placeAt = (ids: number[], parent: number | null, before: number | null) =>
    run("", async () => {
      await api.placeElements(roots(ids), parent, before);
      if (parent != null) setCollapsed((c) => (c.has(parent) ? new Set([...c].filter((x) => x !== parent)) : c));
    });

  const shiftBy = (id: number, delta: number) => {
    if (sortMode !== "manual") return notify("Switch the tree to manual order to move elements up and down");
    void run("", () => api.shiftElement(id, delta));
  };

  const newTopic = async (parent: number | null) => {
    const title = window.prompt(parent == null ? "New top-level topic (a root or a note)" : `New topic under “${byId.get(parent)?.title}”`, "");
    if (title == null) return;
    const id = await api.createTopic(parent, title, JSON.stringify(EMPTY_DOC));
    onChanged();
    onOpen(id);
  };

  const newItem = async (parent: number | null) => {
    const empty = JSON.stringify(EMPTY_DOC);
    const id = await api.createItem(parent, "qa", empty, empty);
    onChanged();
    onOpen(id);
  };

  const review = (ids: number[], dueOnly: boolean) => {
    const top = roots(ids);
    const label = top.length === 1 ? `Branch “${byId.get(top[0])?.title}”` : `${top.length} branches`;
    onReview(dueOnly ? `${label} (due)` : label, api.branchesQueue(top, dueOnly));
  };

  const setBranchCollapsed = (ids: number[] | null, collapse: boolean) => {
    const all = ids ? ids.flatMap((id) => [id, ...descendants(id)]) : nodes.map((n) => n.id);
    setCollapsed((c) => {
      const next = new Set(c);
      for (const id of all) if ((children.get(id) ?? []).length) collapse ? next.add(id) : next.delete(id);
      return next;
    });
  };

  const exportAnki = async (ids: number[] | null) => {
    try {
      notify("Exporting to Anki…");
      const { path, count } = await exportToAnki(ids);
      notify(`Exported ${count} items: ${path}`);
    } catch (e) {
      notify(`Anki export: ${e}`);
    }
  };

  const setFlag = (ids: number[], flag: "pinned" | "needs_work", value: boolean) =>
    run("", () => Promise.all(ids.map((id) => api.setFlag(id, flag, value))));

  const menuEntries = (target: number | null): MenuEntry[] => {
    if (target == null || selected.size === 0) {
      return [
        { label: "New top-level topic…", onClick: () => newTopic(null) },
        { label: "New top-level item", onClick: () => newItem(null) },
        "separator",
        { label: "Expand all", onClick: () => setBranchCollapsed(null, false) },
        { label: "Collapse all", onClick: () => setBranchCollapsed(null, true) },
        { label: "Sort top level by priority", onClick: () => run("Sorted by priority", () => api.sortChildren(null)) },
        { label: "Export all items to Anki (.apkg)", onClick: () => void exportAnki(null) },
        "separator",
        { label: sortMode === "manual" ? "✓ Manual order" : "Manual order", onClick: () => changeSort("manual") },
        { label: sortMode === "priority" ? "✓ Priority order" : "Priority order", onClick: () => changeSort("priority") },
      ];
    }
    const ids = ordered(selected);
    const one = ids.length === 1 ? byId.get(ids[0]) : null;
    const anyActive = ids.some((id) => byId.get(id)?.status === "active");
    const anyInactive = ids.some((id) => byId.get(id)?.status !== "active");
    const parent = one ? parentOf.get(one.id) ?? null : null;
    const grandparent = parent != null ? parentOf.get(parent) ?? null : null;
    const n = ids.length > 1 ? ` (${ids.length})` : "";
    return [
      ...(one ? [{ label: "Open", onClick: () => onOpen(one.id), hint: "Enter" } as MenuEntry] : []),
      { label: `Show descendants in the browser${n}`, onClick: () => onBrowse(`under:${roots(ids).join(",")}`) },
      { label: `Review branch${n}`, onClick: () => review(ids, false) },
      { label: `Review branch, due only${n}`, onClick: () => review(ids, true) },
      "separator",
      ...(one
        ? ([
            { label: "New topic inside…", onClick: () => newTopic(one.id) },
            { label: "New item inside", onClick: () => newItem(one.id) },
            "separator",
          ] as MenuEntry[])
        : []),
      ...(one
        ? ([
            { label: "Move up", onClick: () => shiftBy(one.id, -1), hint: "Alt+↑", disabled: sortMode !== "manual" },
            { label: "Move down", onClick: () => shiftBy(one.id, 1), hint: "Alt+↓", disabled: sortMode !== "manual" },
          ] as MenuEntry[])
        : []),
      ...(one && (children.get(one.id) ?? []).length > 1
        ? [{ label: "Sort children by priority", onClick: () => run("Sorted by priority", () => api.sortChildren(one.id)) } as MenuEntry]
        : []),
      { label: `Move to…${n}`, onClick: () => setMoving(roots(ids)), hint: "M" },
      ...(one && parent != null ? [{ label: "Move up a level", onClick: () => moveTo(ids, grandparent) } as MenuEntry] : []),
      { label: "Move to top level", onClick: () => moveTo(ids, null), disabled: ids.every((id) => parentOf.get(id) == null) },
      "separator",
      ...(one && parent == null
        ? [{ label: one.pinned ? "Unpin from top" : "Pin to top", onClick: () => setFlag([one.id], "pinned", !one.pinned) } as MenuEntry]
        : []),
      ...(ids.some((id) => byId.get(id)?.kind === "item")
        ? [
            {
              label: ids.every((id) => byId.get(id)?.needs_work) ? `Clear “needs work”${n}` : `Flag “needs work”${n}`,
              onClick: () => setFlag(ids, "needs_work", !ids.every((id) => byId.get(id)?.needs_work)),
            } as MenuEntry,
          ]
        : []),
      { label: `Export branch to Anki${n}`, onClick: () => void exportAnki(roots(ids)) },
      { label: `Set priority…${n}`, onClick: () => askPriority(ids), hint: "P" },
      { label: `Review today${n}`, onClick: () => bulk(ids, "read_today"), disabled: !anyActive },
      ...(anyActive ? ([{ label: `Dismiss${n}`, onClick: () => bulk(ids, "dismiss") }, { label: `Done!${n}`, onClick: () => bulk(ids, "done") }] as MenuEntry[]) : []),
      ...(anyInactive ? [{ label: `Restore${n}`, onClick: () => bulk(ids, "restore") } as MenuEntry] : []),
      "separator",
      { label: "Expand branch", onClick: () => setBranchCollapsed(ids, false) },
      { label: "Collapse branch", onClick: () => setBranchCollapsed(ids, true) },
      "separator",
      { label: `Delete…${n}`, onClick: () => askDelete(ids), danger: true, hint: "Del" },
    ];
  };

  const onContextMenu = (ev: React.MouseEvent, id: number | null) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (id != null && !selected.has(id)) {
      setSelected(new Set([id]));
      setAnchor(id);
      setCursor(id);
    }
    setMenu({ x: ev.clientX, y: ev.clientY, target: id });
  };

  // ----- keyboard -----

  /**
   * Arrow-key navigation. Each step opens the element in the reader (which
   * leaves Learn mode; Learn resumes the queue). Shift+↑/↓ extends the
   * selection without opening. Returns true when the key was handled.
   */
  const navigate = (ev: { key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): boolean => {
    const start = cursor ?? openId;
    const idx = start != null ? indexOf.get(start) ?? -1 : -1;
    const go = (i: number) => {
      const row = flat[Math.max(0, Math.min(flat.length - 1, i))];
      if (!row) return;
      const id = row.node.id;
      setCursor(id);
      if (ev.shiftKey && anchor != null) setSelected(selectRange(anchor, id));
      else {
        setSelected(new Set([id]));
        setAnchor(id);
        onOpen(id);
      }
      document.getElementById(`tree-row-${id}`)?.scrollIntoView({ block: "nearest" });
    };
    const key = ev.key;
    if (ev.altKey && (key === "ArrowUp" || key === "ArrowDown")) {
      if (start != null) shiftBy(start, key === "ArrowUp" ? -1 : 1);
    } else if (ev.altKey || ev.ctrlKey || ev.metaKey) return false;
    else if (key === "ArrowDown") go(idx + 1);
    else if (key === "ArrowUp") go(idx < 0 ? 0 : idx - 1);
    else if (key === "ArrowRight") {
      if (start == null) go(0);
      else if (collapsed.has(start) && !matches) toggle(start);
      else if ((children.get(start) ?? []).some((k) => visible.get(k.id))) go(idx + 1); // first child
    } else if (key === "ArrowLeft") {
      if (start == null) go(0);
      else if ((children.get(start) ?? []).length && !collapsed.has(start) && !matches) toggle(start);
      else {
        const p = parentOf.get(start);
        if (p != null) go(indexOf.get(p) ?? idx);
      }
    } else return false;
    return true;
  };

  // The same arrows work anywhere in the window, unless typing, in a dialog, or scrolling a PDF.
  const navRef = useRef(navigate);
  navRef.current = navigate;
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!ev.key.startsWith("Arrow") || ev.defaultPrevented || isTyping(ev.target)) return;
      const t = ev.target as HTMLElement | null;
      if (t?.closest?.(".sidebar, .modal-backdrop, .context-menu, .pdf-scroller, .browser")) return;
      if (document.querySelector(".modal-backdrop")) return;
      if (navRef.current(ev)) ev.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (isTyping(ev.target)) return;
    const ids = ordered(selected);
    const key = ev.key;
    if (key.startsWith("Arrow") && navigate(ev)) {
      /* handled */
    } else if (key === "Home" || key === "End") {
      const row = flat[key === "Home" ? 0 : flat.length - 1];
      if (row) {
        setCursor(row.node.id);
        setSelected(new Set([row.node.id]));
        setAnchor(row.node.id);
        onOpen(row.node.id);
      }
    } else if (key === "Enter" && cursor != null) onOpen(cursor);
    else if (key === "Delete" && ids.length) askDelete(ids);
    else if (key.toLowerCase() === "m" && ids.length) setMoving(roots(ids));
    else if (key.toLowerCase() === "p" && ids.length) askPriority(ids);
    else if (key === "a" && (ev.ctrlKey || ev.metaKey)) setSelected(new Set(flat.map((r) => r.node.id)));
    else if (key === "Escape") setSelected(new Set());
    else if (key === "ContextMenu" || (key === "F10" && ev.shiftKey)) {
      const el = cursor != null ? document.getElementById(`tree-row-${cursor}`) : null;
      const r = el?.getBoundingClientRect();
      setMenu({ x: r ? r.left + 40 : 40, y: r ? r.bottom : 80, target: cursor });
    } else return;
    ev.preventDefault();
  };

  // ----- drag and drop -----

  const onDragStart = (ev: React.DragEvent, id: number) => {
    const ids = selected.has(id) ? ordered(selected) : [id];
    if (!selected.has(id)) setSelected(new Set([id]));
    ev.dataTransfer.setData(DRAG_TYPE, JSON.stringify(roots(ids)));
    ev.dataTransfer.effectAllowed = "move";
  };
  const draggedIds = (ev: React.DragEvent): number[] | null => {
    try {
      return JSON.parse(ev.dataTransfer.getData(DRAG_TYPE));
    } catch {
      return null;
    }
  };
  /** Top quarter = before, bottom quarter = after, middle = into (topics only). */
  const dropZone = (ev: React.DragEvent, n: TreeNode): DropTarget["zone"] | null => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (ev.clientY - r.top) / r.height;
    const canInto = true; // topics and items can both have children
    if (sortMode !== "manual") return canInto ? "into" : null; // reordering only makes sense in manual order
    if (y < 0.28) return "before";
    if (y > 0.72) return "after";
    return canInto ? "into" : y < 0.5 ? "before" : "after";
  };
  const onDropRow = (ev: React.DragEvent, n: TreeNode) => {
    ev.preventDefault();
    ev.stopPropagation();
    const zone = dropZone(ev, n);
    setDropTarget(null);
    const ids = draggedIds(ev);
    if (!ids?.length || !zone || ids.includes(n.id)) return;
    if (zone === "into") return void moveTo(ids, n.id);
    const parent = parentOf.get(n.id) ?? null;
    const sibs = (children.get(parent) ?? []).map((s) => s.id).filter((id) => !ids.includes(id));
    const before = zone === "before" ? n.id : sibs[sibs.indexOf(n.id) + 1] ?? null;
    void placeAt(ids, parent, before);
  };
  const onDropRoot = (ev: React.DragEvent) => {
    ev.preventDefault();
    setDropTarget(null);
    const ids = draggedIds(ev);
    if (ids?.length) void placeAt(ids, null, null);
  };

  const renderRow = ({ node: n, depth }: { node: TreeNode; depth: number }) => {
    const kids = children.get(n.id) ?? [];
    const open = isOpen(n.id);
    const hit = matches?.has(n.id);
    const classes = [
      "tree-row",
      n.status,
      selected.has(n.id) ? "selected" : "",
      openId === n.id ? "open" : "",
      cursor === n.id ? "cursor" : "",
      matches && !hit ? "context" : "",
      dropTarget !== "root" && dropTarget?.id === n.id ? `drop-${dropTarget.zone}` : "",
    ].join(" ");
    const badge = n.kind === "item" ? "Q" : n.pdf ? "P" : n.video ? "V" : n.empty ? "N" : "T";
    const band = n.status === "active" ? `band-${bandOf(n.priority).name}` : "";
    const due =
      n.status !== "active" ? n.status : n.due_day == null || (n.kind === "topic" && n.empty && !n.pdf) ? "" : fmtDays(n.due_day - today);
    return (
      <div
        key={n.id}
        id={`tree-row-${n.id}`}
        className={classes}
        style={{ paddingLeft: 4 + depth * 14 }}
        draggable
        onDragStart={(e) => onDragStart(e, n.id)}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
          const zone = dropZone(e, n);
          if (!zone) return;
          e.preventDefault();
          e.stopPropagation();
          setDropTarget((t) => (t !== "root" && t?.id === n.id && t.zone === zone ? t : { id: n.id, zone }));
        }}
        onDragLeave={() => setDropTarget((t) => (t !== "root" && t?.id === n.id ? null : t))}
        onDrop={(e) => onDropRow(e, n)}
        onDragEnd={() => setDropTarget(null)}
        onClick={(e) => clickRow(e, n.id)}
        onDoubleClick={() => kids.length && toggle(n.id)}
        onContextMenu={(e) => onContextMenu(e, n.id)}
      >
        <span
          className={`twisty ${kids.length ? "" : "leaf"}`}
          onClick={(e) => {
            e.stopPropagation();
            if (kids.length) toggle(n.id);
          }}
        >
          {kids.length ? (open ? "▾" : "▸") : ""}
        </span>
        <span
          className={`badge ${n.kind} ${badge === "N" ? "note" : ""} ${badge === "P" ? "pdf" : ""} ${badge === "V" ? "video" : ""} ${band}`}
          title={n.status === "active" ? `${bandOf(n.priority).label} priority (${Math.round(n.priority)}%)` : n.status}
        >
          {badge}
        </span>
        {n.pinned && depth === 0 && <span className="marker" title="Pinned">📌</span>}
        <span className="tree-title" title={n.title}>{n.title}</span>
        {n.kind === "item" && n.lapses >= LEECH_LAPSES && <span className="marker warn" title={`Leech: forgotten ${n.lapses}×`}>⚠</span>}
        {n.needs_work && <span className="marker" title="Needs work">✎</span>}
        <span className="muted small mono">{due}</span>
      </div>
    );
  };

  const activeMatches = matches ? nodes.filter((n) => matches.has(n.id) && n.status === "active").map((n) => n.id) : [];

  return (
    <aside className="sidebar">
      <div className="tree-tools">
        <input placeholder="Search text…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery("")} />
        <select className="small" value={filter} onChange={(e) => setFilter(e.target.value as Filter)} title="Filter the tree">
          {(Object.keys(FILTERS) as Filter[]).map((f) => (
            <option key={f} value={f}>
              {FILTERS[f]}
            </option>
          ))}
        </select>
        <label className="small" title="Show done and dismissed elements">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> all
        </label>
        <button
          className="small-btn"
          title={sortMode === "manual" ? "Manual order (drag to reorder). Click for priority order." : "Priority order. Click for manual order."}
          onClick={() => changeSort(sortMode === "manual" ? "priority" : "manual")}
        >
          {sortMode === "manual" ? "⇅" : "P↑"}
        </button>
        <button className="small-btn" title="New top-level topic" onClick={() => newTopic(null)}>+</button>
      </div>
      {filter !== "all" && (
        <div className="search-bar small">
          <span className="muted">Filter: {FILTERS[filter]}</span>
          <span className="spacer" />
          <button className="small-btn" onClick={() => setFilter("all")}>Clear</button>
        </div>
      )}
      {(matches || selected.size > 1) && (
        <div className="search-bar small">
          {matches ? <span className="muted">{matches.size} matches</span> : <span className="muted">{selected.size} selected</span>}
          <span className="spacer" />
          {matches && activeMatches.length > 0 && (
            <button className="small-btn" onClick={() => onReview(`Search “${query.trim()}”`, api.idsQueue(activeMatches))}>
              Review results
            </button>
          )}
          {selected.size > 1 && (
            <button className="small-btn" onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, target: ordered(selected)[0] })}>
              Actions ▾
            </button>
          )}
        </div>
      )}
      <div
        ref={bodyRef}
        className={`tree-body ${dropTarget === "root" ? "drop-root" : ""}`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => onContextMenu(e, null)}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
          e.preventDefault();
          setDropTarget("root");
        }}
        onDrop={onDropRoot}
        onClick={(e) => e.target === e.currentTarget && setSelected(new Set())}
      >
        {flat.map(renderRow)}
        {nodes.length === 0 && <p className="muted pad small">Nothing here yet. Import with Ctrl+N; new imports wait in the Inbox. Right-click for a new topic.</p>}
        <div className="tree-drop-hint small muted">drop here: end of the top level</div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.target)} onClose={() => setMenu(null)} />}
      {moving && (
        <MoveDialog
          nodes={nodes}
          moving={moving}
          onClose={() => setMoving(null)}
          onPick={(p) => {
            const ids = moving;
            setMoving(null);
            void moveTo(ids, p);
          }}
        />
      )}
    </aside>
  );
}
