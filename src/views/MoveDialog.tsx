import { useEffect, useMemo, useRef, useState } from "react";
import type { TreeNode } from "../api";

interface Props {
  nodes: TreeNode[];
  /** Elements being moved; they and their descendants can't be targets. */
  moving: number[];
  onPick: (parentId: number | null) => void;
  onClose: () => void;
}

/** Pick a new parent: type to filter topics, Enter to move. */
export function MoveDialog({ nodes, moving, onPick, onClose }: Props) {
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const { paths, blocked } = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const children = new Map<number, number[]>();
    for (const n of nodes) if (n.parent_id != null) children.set(n.parent_id, [...(children.get(n.parent_id) ?? []), n.id]);
    const blocked = new Set<number>();
    const block = (id: number) => {
      blocked.add(id);
      (children.get(id) ?? []).forEach(block);
    };
    moving.forEach(block);
    const path = (n: TreeNode): string => {
      const parts = [n.title];
      for (let p = n.parent_id; p != null; p = byId.get(p)?.parent_id ?? null) parts.unshift(byId.get(p)?.title ?? "?");
      return parts.join(" › ");
    };
    return { paths: new Map(nodes.map((n) => [n.id, path(n)])), blocked };
  }, [nodes, moving]);

  const options = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = nodes
      .filter((n) => !blocked.has(n.id))
      .filter((n) => !needle || paths.get(n.id)!.toLowerCase().includes(needle))
      // Roots and notes (empty topics) first: they're the usual folders.
      .sort((a, b) => Number(b.empty) - Number(a.empty) || (paths.get(a.id)!.length - paths.get(b.id)!.length))
      .slice(0, 60);
    return [{ id: null as number | null, label: "Top level" }, ...list.map((n) => ({ id: n.id as number | null, label: paths.get(n.id)! }))];
  }, [blocked, nodes, paths, q]);

  useEffect(() => setCursor(0), [q]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal picker">
        <div className="picker-head">
          Move {moving.length} element{moving.length === 1 ? "" : "s"} to…
        </div>
        <input
          ref={input}
          placeholder="Type to find a topic"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") e.preventDefault(), setCursor((c) => Math.min(c + 1, options.length - 1));
            else if (e.key === "ArrowUp") e.preventDefault(), setCursor((c) => Math.max(c - 1, 0));
            else if (e.key === "Enter") options[cursor] && onPick(options[cursor].id);
            else if (e.key === "Escape") onClose();
          }}
        />
        <div className="picker-list">
          {options.map((o, i) => (
            <div key={o.id ?? "root"} className={`picker-row ${i === cursor ? "selected" : ""}`} onMouseEnter={() => setCursor(i)} onClick={() => onPick(o.id)}>
              {o.id == null ? <b>{o.label}</b> : o.label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
