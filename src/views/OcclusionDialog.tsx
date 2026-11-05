import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { toDisplaySrc } from "../editor/assetSrc";
import { occlusionItems, type Rect } from "../editor/occlusion";
import type { Notify } from "../notify";

interface Props {
  /** Stored image source (`ir-asset:…` or a URL). */
  src: string;
  /** Items are created under this element (null = top level). */
  parentId: number | null;
  title: string;
  onClose: () => void;
  onCreated: (ids: number[]) => void;
  notify: Notify;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * Draw regions over an image, then create one item per region. Drag to draw;
 * click a region to remove it.
 */
export function OcclusionDialog({ src, parentId, title, onClose, onCreated, notify }: Props) {
  const [rects, setRects] = useState<Rect[]>([]);
  const [draft, setDraft] = useState<Rect | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const origin = useRef<[number, number] | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.ctrlKey && e.key.toLowerCase() === "z" && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        e.stopPropagation();
        setRects((r) => r.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const point = (e: React.PointerEvent): [number, number] => {
    const r = box.current!.getBoundingClientRect();
    return [clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height)];
  };
  const down = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).classList.contains("mask")) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    origin.current = point(e);
    setDraft([...origin.current, 0, 0]);
  };
  const move = (e: React.PointerEvent) => {
    if (!origin.current) return;
    const [x0, y0] = origin.current;
    const [x1, y1] = point(e);
    setDraft([Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)]);
  };
  const up = () => {
    if (draft && draft[2] > 0.01 && draft[3] > 0.01) setRects((r) => [...r, draft]);
    origin.current = null;
    setDraft(null);
  };

  const create = async () => {
    if (!rects.length) return notify("Draw at least one region");
    setBusy(true);
    try {
      const ids: number[] = [];
      const items = occlusionItems(src, rects, label.trim());
      for (const [i, it] of items.entries()) {
        const id = await api.createItem(parentId, "occlusion", JSON.stringify(it.question), JSON.stringify(it.answer));
        await api.setTitle(id, `${title || "Image"} — region ${i + 1}/${rects.length}`);
        ids.push(id);
      }
      notify(`Created ${ids.length} occlusion item${ids.length === 1 ? "" : "s"}`);
      onCreated(ids);
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  };

  const style = (r: Rect) => ({ left: `${r[0] * 100}%`, top: `${r[1] * 100}%`, width: `${r[2] * 100}%`, height: `${r[3] * 100}%` });
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal occlusion-modal">
        <div className="modal-tabs">
          <strong>Image occlusion</strong>
          <span className="muted small">Drag to cover a region; click a region to remove it. One item per region.</span>
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
        </div>
        <div className="modal-body">
          <div className="occl-editor" ref={box} onPointerDown={down} onPointerMove={move} onPointerUp={up}>
            <img src={toDisplaySrc(src) ?? ""} alt="" draggable={false} />
            {rects.map((r, i) => (
              <div key={i} className="mask" style={style(r)} title="Click to remove" onClick={() => setRects((rs) => rs.filter((_, j) => j !== i))}>
                {i + 1}
              </div>
            ))}
            {draft && <div className="mask draft" style={style(draft)} />}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <input placeholder="Optional note shown with the answer" value={label} onChange={(e) => setLabel(e.target.value)} style={{ flex: 1 }} />
            <button className="primary" disabled={busy || !rects.length} onClick={() => void create()}>
              Create {rects.length || ""} item{rects.length === 1 ? "" : "s"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
