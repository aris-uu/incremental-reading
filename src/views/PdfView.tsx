import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import { isDefaultAction } from "../keys";
import { AFactor } from "./AFactor";
import { api, fmtDays, type PdfMark } from "../api";
import { textDoc, toDisplaySrc } from "../editor/extensions";
import { ElementHeader } from "./ElementHeader";
import type { TopicOutcome, TopicViewProps } from "./TopicView";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Rect = [number, number, number, number];
const ZOOM_KEY = "ir.pdfZoom";

function loadZoom() {
  try {
    return Number(localStorage.getItem(ZOOM_KEY)) || 1.4;
  } catch {
    return 1.4;
  }
}

/** Paragraph documents from selected PDF text (line breaks inside a paragraph are joined). */
function textToDoc(text: string) {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/-\n(?=\w)/g, "").replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
  return { type: "doc", content: paras.length ? paras.map((p) => textDoc(p).content[0]) : textDoc("").content };
}

interface PageProps {
  pdf: pdfjs.PDFDocumentProxy;
  n: number;
  scale: number;
  size: { w: number; h: number };
  marks: PdfMark[];
  regionMode: boolean;
  onRegion: (page: number, rect: Rect, canvas: HTMLCanvasElement, textLayer: HTMLElement) => void;
  onMark: (m: PdfMark, ev: React.MouseEvent) => void;
}

/** One page: canvas + selectable text layer + extract marks, rendered when near the viewport. */
function PdfPage({ pdf, n, scale, size, marks, regionMode, onRegion, onMark }: PageProps) {
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { rootMargin: "1200px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: pdfjs.RenderTask | null = null;
    let text: pdfjs.TextLayer | null = null;
    (async () => {
      const page = await pdf.getPage(n);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current!;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      task = page.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined } as any);
      await task.promise.catch(() => undefined);
      if (cancelled || !textRef.current) return;
      textRef.current.replaceChildren();
      text = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textRef.current, viewport });
      await text.render().catch(() => undefined);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
      text?.cancel();
    };
  }, [visible, pdf, n, scale]);

  const frac = (ev: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height };
  };

  return (
    <div
      ref={ref}
      className={`pdf-page ${regionMode ? "region-mode" : ""}`}
      data-page={n}
      title={marks.length ? "Ctrl+click a marked passage to open its extract" : undefined}
      onClick={(ev) => {
        if (!(ev.ctrlKey || ev.metaKey) || regionMode) return;
        const p = frac(ev);
        const hit = marks.find((m) => m.rects.some(([x, y, w, h]) => p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h));
        if (hit) onMark(hit, ev);
      }}
      style={
        {
          width: size.w * scale,
          height: size.h * scale,
          "--scale-factor": scale,
          "--total-scale-factor": scale,
          "--scale-round-x": "1px",
          "--scale-round-y": "1px",
        } as React.CSSProperties
      }
    >
      <canvas ref={canvasRef} />
      <div ref={textRef} className="textLayer" />
      {marks.map((m) =>
        m.rects.map((r, i) => (
          <div
            key={`${m.id}-${i}`}
            className={`pdf-mark ${m.kind}`}
            style={{ left: `${r[0] * 100}%`, top: `${r[1] * 100}%`, width: `${r[2] * 100}%`, height: `${r[3] * 100}%` }}
          />
        )),
      )}
      {regionMode && (
        <div
          className="region-overlay"
          onMouseDown={(ev) => {
            const p = frac(ev);
            setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
          }}
          onMouseMove={(ev) => drag && setDrag({ ...drag, x1: frac(ev).x, y1: frac(ev).y })}
          onMouseUp={() => {
            if (!drag) return;
            const rect: Rect = [Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0)];
            setDrag(null);
            if (rect[2] > 0.02 && rect[3] > 0.01 && canvasRef.current && textRef.current) onRegion(n, rect, canvasRef.current, textRef.current);
          }}
        >
          {drag && (
            <div
              className="region-rect"
              style={{
                left: `${Math.min(drag.x0, drag.x1) * 100}%`,
                top: `${Math.min(drag.y0, drag.y1) * 100}%`,
                width: `${Math.abs(drag.x1 - drag.x0) * 100}%`,
                height: `${Math.abs(drag.y1 - drag.y0) * 100}%`,
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * PDF topic: read page by page, extract selected text, or extract a region
 * (figure, formula, table) as an image. The read point is the page.
 */
export function PdfView({ element, mode, onFinish, onOpen, onChanged, onDelete, onReviewBranch, notify }: TopicViewProps) {
  /** For the time-per-read statistics. */
  const openedAt = useRef(Date.now());
  const id = element.id;
  const topic = element.topic!;
  const active = element.status === "active";
  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [scale, setScale] = useState(loadZoom);
  const [marks, setMarks] = useState<PdfMark[]>([]);
  const [regionMode, setRegionMode] = useState(false);
  const [page, setPage] = useState(topic.pdf_page ?? 1);
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const task = pdfjs.getDocument({ url: toDisplaySrc(`ir-asset:${topic.pdf_asset}`)! });
    task.promise
      .then(async (d) => {
        const first = await d.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        setSize({ w: vp.width, h: vp.height });
        setPdf(d);
      })
      .catch((e) => setError(String(e)));
    return () => void task.destroy();
  }, [topic.pdf_asset]);

  const loadMarks = useCallback(() => api.pdfMarks(id).then(setMarks), [id]);
  useEffect(() => {
    void loadMarks();
  }, [loadMarks]);

  const marksByPage = useMemo(() => {
    const m = new Map<number, PdfMark[]>();
    for (const x of marks) m.set(x.page, [...(m.get(x.page) ?? []), x]);
    return m;
  }, [marks]);

  const scrollToPage = useCallback((p: number) => {
    scroller.current?.querySelector(`.pdf-page[data-page="${p}"]`)?.scrollIntoView({ block: "start" });
  }, []);

  // Resume at the read point (page) once pages are laid out.
  useEffect(() => {
    if (!pdf || !size || restored.current) return;
    restored.current = true;
    requestAnimationFrame(() => scrollToPage(topic.pdf_page ?? 1));
  }, [pdf, size, scrollToPage, topic.pdf_page]);

  const savePage = useCallback((p: number) => api.setPdfPage(id, p), [id]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    let best = 1;
    for (const pg of el.querySelectorAll<HTMLElement>(".pdf-page")) {
      if (pg.getBoundingClientRect().top - top <= el.clientHeight * 0.4) best = Number(pg.dataset.page);
      else break;
    }
    if (best !== page) {
      setPage(best);
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void savePage(best), 600);
    }
  };
  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  const zoom = (f: number) => {
    const next = Math.max(0.6, Math.min(3.5, Math.round(scale * f * 10) / 10));
    setScale(next);
    try {
      localStorage.setItem(ZOOM_KEY, String(next));
    } catch {
      /* not remembered */
    }
    requestAnimationFrame(() => scrollToPage(page));
  };

  /** Extract the selected text; its position is marked on the page. */
  const extractSelection = useCallback(async () => {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!sel || !text || !sel.rangeCount) return notify("Select text on the page to extract (or use Region for figures)");
    const range = sel.getRangeAt(0);
    const pageEl = (range.startContainer.parentElement ?? (range.startContainer as HTMLElement)).closest<HTMLElement>(".pdf-page");
    if (!pageEl) return notify("Select text inside a page");
    const n = Number(pageEl.dataset.page);
    const pr = pageEl.getBoundingClientRect();
    const rects: Rect[] = [...range.getClientRects()]
      .filter((r) => r.width > 1 && r.height > 1)
      .map((r) => [(r.left - pr.left) / pr.width, (r.top - pr.top) / pr.height, r.width / pr.width, r.height / pr.height]);
    const childId = await api.createExtract(id, "", JSON.stringify(textToDoc(sel.toString())));
    await api.addPdfMark(id, childId, n, rects, "extract");
    await savePage(n);
    sel.removeAllRanges();
    void loadMarks();
    notify(`Extract created (p. ${n})`);
    onChanged?.();
  }, [id, loadMarks, notify, onChanged, savePage]);

  /** Region extract: the rectangle becomes an image, plus any text under it. */
  const onRegion = useCallback(
    async (n: number, rect: Rect, canvas: HTMLCanvasElement, textLayer: HTMLElement) => {
      setRegionMode(false);
      const [x, y, w, h] = rect;
      const crop = document.createElement("canvas");
      crop.width = Math.max(1, Math.round(w * canvas.width));
      crop.height = Math.max(1, Math.round(h * canvas.height));
      crop.getContext("2d")!.drawImage(canvas, x * canvas.width, y * canvas.height, crop.width, crop.height, 0, 0, crop.width, crop.height);
      const blob = await new Promise<Blob | null>((res) => crop.toBlob(res, "image/png"));
      if (!blob) return notify("Couldn't capture the region");
      const src = await api.saveAsset(await blob.arrayBuffer(), "png");
      // Text whose centre falls inside the region (helps search and context).
      const lr = textLayer.getBoundingClientRect();
      const words = [...textLayer.querySelectorAll("span")]
        .filter((s) => {
          const r = s.getBoundingClientRect();
          const cx = (r.left + r.width / 2 - lr.left) / lr.width;
          const cy = (r.top + r.height / 2 - lr.top) / lr.height;
          return cx >= x && cx <= x + w && cy >= y && cy <= y + h;
        })
        .map((s) => s.textContent)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const doc = { type: "doc", content: [{ type: "image", attrs: { src } }, ...(words ? [textDoc(words).content[0]] : [])] };
      const childId = await api.createExtract(id, words ? "" : `${element.title} — p. ${n} region`, JSON.stringify(doc));
      await api.addPdfMark(id, childId, n, [rect], "region");
      void loadMarks();
      notify(`Region extract created (p. ${n})`);
      onChanged?.();
    },
    [element.title, id, loadMarks, notify, onChanged],
  );

  const onMark = (m: PdfMark, ev: React.MouseEvent) => {
    if ((ev.ctrlKey || ev.metaKey) && m.child_id && onOpen) onOpen(m.child_id);
  };

  const finish = useCallback(
    async (outcome: TopicOutcome, days?: number) => {
      if (busy) return;
      setBusy(true);
      try {
        await savePage(page);
        if (outcome === "next") notify(`Next read in ${fmtDays(await api.topicRead(id, Date.now() - openedAt.current))}`);
        else if (outcome === "done") {
          await api.done(id);
          notify("Done!", { undo: true });
        } else if (outcome === "dismiss") {
          await api.dismiss(id);
          notify("Dismissed", { undo: true });
        }
        else if (outcome === "restored") await api.restore(id);
        else if (outcome === "rescheduled" && days != null) {
          await api.reschedule(id, days);
          notify(`Rescheduled to ${fmtDays(days)}`, { undo: true });
        }
        onFinish(outcome);
      } catch (e) {
        notify(String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, id, notify, onFinish, page, savePage],
  );

  /** Not understood yet: come back in 100 days, and read it less often from then on. */
  const dontGetIt = async () => {
    await api.setAfactor(element.id, Math.min(5, (topic.afactor ?? 1.5) + 0.2)).catch(() => {});
    await finish("rescheduled", 100);
  };
  const askPriority = () => {
    const v = window.prompt("Priority (0 = most important)", String(Math.round(element.priority)));
    const n = v == null ? NaN : Number(v);
    if (!Number.isNaN(n)) void api.setPriority(element.id, Math.max(0, Math.min(100, n))).then(() => (notify(`Priority ${n}%`, { undo: true }), onChanged?.()));
  };

  const askReschedule = useCallback(() => {
    const v = window.prompt("Next review in how many days?", String(Math.max(1, topic.interval_days)));
    const n = v == null ? NaN : parseInt(v, 10);
    if (!Number.isNaN(n)) void finish("rescheduled", n);
  }, [finish, topic.interval_days]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const k = ev.key.toLowerCase();
      const run = (f: () => unknown) => (ev.preventDefault(), void f());
      if (ev.altKey && k === "x") return run(extractSelection);
      if (ev.altKey && k === "g") return run(() => setRegionMode((r) => !r));
      if (ev.altKey && k === "z") return run(() => notify("Extract first, then make clozes in the extract"));
      if (ev.key === "Escape" && regionMode) return run(() => setRegionMode(false));
      if (ev.ctrlKey && (ev.key === "=" || ev.key === "+")) return run(() => zoom(1.15));
      if (ev.ctrlKey && ev.key === "-") return run(() => zoom(1 / 1.15));
      if (ev.altKey && k === "p") return run(askPriority);
      if (!active) return;
      // Space: Next (in the queue only; while browsing it would mark the topic read by accident).
      if (mode === "learn" && isDefaultAction(ev)) return void finish("next");
      if (ev.ctrlKey && ev.shiftKey && k === "enter") return run(() => finish("done"));
      if (ev.ctrlKey && k === "enter") return run(() => finish("next"));
      if (ev.ctrlKey && k === "j") return run(askReschedule);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="element-view">
      <ElementHeader element={element} onOpen={onOpen} onChanged={onChanged} onReviewBranch={onReviewBranch} onRestore={() => finish("restored")} />
      <div className="toolbar">
        <button onClick={extractSelection} title="Alt+X — extract the selected text">Extract</button>
        <button className={regionMode ? "active-toggle" : ""} onClick={() => setRegionMode((r) => !r)} title="Alt+G — drag a rectangle around a figure, table or formula">
          Region
        </button>
        <span className="sep" />
        <button onClick={() => zoom(1 / 1.15)} title="Ctrl+-">−</button>
        <span className="mono small">{Math.round(scale * 100)}%</span>
        <button onClick={() => zoom(1.15)} title="Ctrl+=">+</button>
        <span className="spacer" />
        <span className="muted small">
          page {page}/{pdf?.numPages ?? "…"} · read point p. {topic.pdf_page ?? 1} · interval {fmtDays(topic.interval_days)}
        </span>
          <AFactor id={element.id} afactor={topic.afactor} interval={topic.interval_days} notify={notify} onChanged={onChanged} />
      </div>
      <div className="pdf-scroller" ref={scroller} onScroll={onScroll}>
        {error && <p className="pad">Couldn't open the PDF: {error}</p>}
        {pdf &&
          size &&
          Array.from({ length: pdf.numPages }, (_, i) => (
            <PdfPage
              key={i + 1}
              pdf={pdf}
              n={i + 1}
              scale={scale}
              size={size}
              marks={marksByPage.get(i + 1) ?? []}
              regionMode={regionMode}
              onRegion={onRegion}
              onMark={onMark}
            />
          ))}
      </div>
      <footer className="actions">
        {active && (
          <>
            <button className="primary" disabled={busy} onClick={() => finish("next")} title="Space or Ctrl+Enter">
              {mode === "learn" ? (<>Next <kbd>Space</kbd></>) : "Mark read"}
            </button>
            {mode === "learn" && <button disabled={busy} onClick={() => finish("later")}>Later today</button>}
          </>
        )}
        <button disabled={busy} onClick={askReschedule} title="Ctrl+J">Reschedule…</button>
        {active && <button disabled={busy} onClick={() => void dontGetIt()}>Don't get it · +100d</button>}
        <span className="spacer" />
        {onDelete && <button disabled={busy} className="danger" onClick={onDelete}>Delete</button>}
        {active && (
          <>
            <button disabled={busy} onClick={() => finish("dismiss")}>Dismiss</button>
            <button disabled={busy} onClick={() => finish("done")} title="Finished with this PDF; extracts stay">Done!</button>
          </>
        )}
      </footer>
    </div>
  );
}
