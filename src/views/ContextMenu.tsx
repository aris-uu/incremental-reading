import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuEntry =
  | { label: string; onClick: () => void; hint?: string; danger?: boolean; disabled?: boolean }
  | "separator";

/** A right-click menu at screen coordinates; closes on outside click, Escape or scroll. */
export function ContextMenu({ x, y, entries, onClose }: { x: number; y: number; entries: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.min(x, window.innerWidth - r.width - 4), y: Math.min(y, window.innerHeight - r.height - 4) });
  }, [x, y]);

  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", onClose);
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onClose, { passive: true });
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onClose);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="context-menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {entries.map((m, i) =>
        m === "separator" ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            className={`menu-item ${m.danger ? "danger" : ""}`}
            disabled={m.disabled}
            onClick={() => {
              onClose();
              m.onClick();
            }}
          >
            <span>{m.label}</span>
            {m.hint && <kbd>{m.hint}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}
