import { useEffect, useMemo, useRef, useState } from "react";
import { api, type TreeNode } from "../api";

export interface Command {
  label: string;
  hint?: string;
  run: () => void;
}

interface Props {
  commands: Command[];
  onOpenElement: (id: number) => void;
  onClose: () => void;
  /** Recently opened elements, newest first (shown before commands with no query). */
  recent?: number[];
}

type Row = { kind: "command"; cmd: Command } | { kind: "element"; node: TreeNode; path: string };

/** Ctrl+K: run any command, or jump to an element by title or text. */
export function CommandPalette({ commands, onOpenElement, onClose, recent = [] }: Props) {
  const [q, setQ] = useState("");
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [textHits, setTextHits] = useState<number[]>([]);
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    api.getTree().then(setNodes);
  }, []);

  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) return setTextHits([]);
    const h = window.setTimeout(() => api.search(t).then((ids) => setTextHits(ids.slice(0, 20))), 150);
    return () => window.clearTimeout(h);
  }, [q]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const pathOf = (n: TreeNode) => {
    const parts: string[] = [];
    for (let p = n.parent_id; p != null && parts.length < 3; p = byId.get(p)?.parent_id ?? null) parts.unshift(byId.get(p)?.title ?? "");
    return parts.join(" › ");
  };

  const rows: Row[] = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const words = needle.split(/\s+/).filter(Boolean);
    const matches = (s: string) => words.every((w) => s.toLowerCase().includes(w));
    const cmds = commands.filter((c) => !needle || matches(c.label)).map((cmd) => ({ kind: "command", cmd }) as Row);
    if (!needle) {
      const rec = recent
        .map((id) => byId.get(id))
        .filter(Boolean)
        .slice(0, 8)
        .map((n) => ({ kind: "element", node: n!, path: `recent · ${pathOf(n!)}` }) as Row);
      return [...rec, ...cmds];
    }
    const seen = new Set<number>();
    const els: Row[] = [];
    for (const n of nodes) {
      if (els.length >= 30) break;
      if (matches(n.title)) {
        seen.add(n.id);
        els.push({ kind: "element", node: n, path: pathOf(n) });
      }
    }
    for (const id of textHits) {
      const n = byId.get(id);
      if (n && !seen.has(id) && els.length < 40) els.push({ kind: "element", node: n, path: pathOf(n) });
    }
    return [...cmds, ...els];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commands, nodes, q, recent, textHits, byId]);

  useEffect(() => setCursor(0), [q]);

  const pick = (r: Row | undefined) => {
    if (!r) return;
    onClose();
    if (r.kind === "command") r.cmd.run();
    else onOpenElement(r.node.id);
  };

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal picker palette">
        <input
          ref={input}
          placeholder="Type a command, or an element's title or text…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") e.preventDefault(), setCursor((c) => Math.min(c + 1, rows.length - 1));
            else if (e.key === "ArrowUp") e.preventDefault(), setCursor((c) => Math.max(c - 1, 0));
            else if (e.key === "Enter") e.preventDefault(), pick(rows[cursor]);
            else if (e.key === "Escape") onClose();
          }}
        />
        <div className="picker-list">
          {rows.map((r, i) => (
            <div
              key={r.kind === "command" ? `c-${r.cmd.label}` : `e-${r.node.id}`}
              className={`picker-row palette-row ${i === cursor ? "selected" : ""}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => pick(r)}
            >
              {r.kind === "command" ? (
                <>
                  <span>{r.cmd.label}</span>
                  {r.cmd.hint && <kbd>{r.cmd.hint}</kbd>}
                </>
              ) : (
                <>
                  <span className={`badge ${r.node.kind}`}>{r.node.kind === "topic" ? "T" : "Q"}</span>
                  <span className="palette-title">{r.node.title}</span>
                  {r.path && <span className="muted small palette-path">{r.path}</span>}
                </>
              )}
            </div>
          ))}
          {rows.length === 0 && <div className="muted small pad">No matches</div>}
        </div>
      </div>
    </div>
  );
}
