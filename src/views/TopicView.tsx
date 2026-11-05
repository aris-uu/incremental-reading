import { useCallback, useEffect, useRef, useState } from "react";
import type { Notify } from "../notify";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import type { EditorState } from "@tiptap/pm/state";
import { NodeSelection } from "@tiptap/pm/state";
import { isDefaultAction } from "../keys";
import { api, fmtDays, fmtTime, type ElementFull } from "../api";
import { EMPTY_DOC, extensions, parseDoc, readPointKey, stripIrMarks, textDoc } from "../editor/extensions";
import { ElementHeader } from "./ElementHeader";
import { useToday } from "../notify";
import { FormatBar } from "../editor/FormatBar";
import { PdfView } from "./PdfView";
import { VideoPanel, type VideoHandle } from "./VideoPanel";
import { OcclusionDialog } from "./OcclusionDialog";
import { AFactor } from "./AFactor";
import { timeFromHref } from "../youtube";

export type TopicOutcome = "next" | "later" | "done" | "dismiss" | "rescheduled" | "restored";

export interface TopicViewProps {
  element: ElementFull;
  /** In the queue, actions schedule and advance. In browse mode they only schedule. */
  mode: "learn" | "browse";
  onFinish: (outcome: TopicOutcome) => void;
  onOpen?: (id: number) => void;
  /** Something visible in the tree changed (new child, title, priority). */
  onChanged?: () => void;
  onDelete?: () => void;
  onReviewBranch?: (id: number) => void;
  notify: Notify;
}

const LEAF = "\ufffc"; // stands in for math and other atoms when scanning text

/**
 * Cloze from a selection inside one paragraph. The question is the sentence
 * around it with the keyword replaced by [...], keeping formatting and math.
 */
function clozeDocs(state: EditorState, from: number, to: number) {
  const $from = state.doc.resolve(from);
  const block = $from.parent;
  const start0 = $from.start();
  const end0 = $from.end();
  const ch = (p: number) => (p < start0 || p >= end0 ? "" : state.doc.textBetween(p, p + 1, "", LEAF));
  let start = start0;
  for (let p = from - 1; p > start0; p--) {
    if (/[.!?]/.test(ch(p - 1)) && /\s/.test(ch(p))) {
      start = p;
      break;
    }
  }
  while (start < from && /\s/.test(ch(start))) start++;
  let end = end0;
  for (let p = to; p < end0; p++) {
    if (/[.!?]/.test(ch(p)) && (p + 1 >= end0 || /\s/.test(ch(p + 1)))) {
      end = p + 1;
      break;
    }
  }
  const inline = (a: number, b: number): any[] => (b > a ? stripIrMarks(block.slice(a - start0, b - start0).content.toJSON() ?? []) : []);
  const para = (content: any[]) => ({ type: "doc", content: [content.length ? { type: "paragraph", content } : { type: "paragraph" }] });
  return {
    question: para([...inline(start, from), { type: "text", text: "[...]" }, ...inline(to, end)]),
    answer: para(inline(from, to)),
  };
}

/** Reading speed for the "minutes left" estimate (≈230 words/min). */
const CHARS_PER_MINUTE = 1150;

type Props = TopicViewProps;

/** Topics: rich-text reader, or the PDF reader for PDF topics. */
export function TopicView(props: Props) {
  return props.element.topic?.pdf_asset ? <PdfView {...props} /> : <TextTopicView {...props} />;
}

function TextTopicView({ element, mode, onFinish, onOpen, onChanged, onDelete, onReviewBranch, notify }: Props) {
  const id = element.id;
  const topic = element.topic!;
  const active = element.status === "active";
  const dirty = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const today = useToday();
  const readerRef = useRef<HTMLDivElement>(null);
  /** Floating toolbar position (relative to the reader), shown while text is selected. */
  const [selBox, setSelBox] = useState<{ top: number; left: number } | null>(null);
  const [progress, setProgress] = useState<{ pct: number; minutes: number } | null>(null);
  /** Set once the reader places a read point; otherwise one is placed automatically on leaving. */
  const explicitRp = useRef(false);
  const video = useRef<VideoHandle>(null);
  /** For the time-per-read statistics. */
  const openedAt = useRef(Date.now());
  const isVideo = !!topic.video_id;
  /** Image being occluded (stored src). */
  const [occluding, setOccluding] = useState<string | null>(null);
  /** Consecutive clozes: one quiet counter instead of a toast each. */
  const clozeRun = useRef({ n: 0, at: 0 });
  /** Hover preview of an extracted or clozed span. */
  const [peek, setPeek] = useState<{ top: number; left: number; text: string } | null>(null);
  const peekCache = useRef(new Map<number, string>());
  const peekTarget = useRef<number | null>(null);

  const editor = useEditor({
    extensions,
    content: parseDoc(topic.doc_json),
    editorProps: {
      // Ctrl+click an extracted or clozed span to open its child element.
      handleClick(_view, _pos, event) {
        // Transcript timestamps are handled by the reader's click handler (seek, never open a browser).
        if ((event.target as HTMLElement).closest("a[href^='#t=']")) return true;
        const span = (event.target as HTMLElement).closest("[data-extract],[data-cloze]") as HTMLElement | null;
        if (!span || !(event.ctrlKey || event.metaKey) || !onOpen) return false;
        const cid = Number(span.dataset.extract ?? span.dataset.cloze);
        if (cid) onOpen(cid);
        return true;
      },
    },
    onUpdate: () => {
      dirty.current = true;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void save(), 800);
    },
    onSelectionUpdate: ({ editor: ed }) => placeToolbar(ed),
    onBlur: () => setSelBox(null),
  });

  /** Put the selection toolbar just above the selection. */
  const placeToolbar = (ed: Editor) => {
    const { from, to, empty } = ed.state.selection;
    const box = readerRef.current;
    if (empty || !box) return setSelBox(null);
    const a = ed.view.coordsAtPos(from);
    const b = ed.view.coordsAtPos(to);
    const r = box.getBoundingClientRect();
    const left = Math.max(8, Math.min((a.left + b.left) / 2 - r.left - 150, r.width - 320));
    setSelBox({ top: Math.min(a.top, b.top) - r.top + box.scrollTop - 42, left });
  };

  /** Where the reader is: read point (or top of the viewport) through the text. */
  const updateProgress = useCallback(() => {
    if (!editor || !readerRef.current) return;
    const size = editor.state.doc.content.size || 1;
    const box = readerRef.current.getBoundingClientRect();
    const top = editor.view.posAtCoords({ left: box.left + 60, top: box.top + 12 })?.pos ?? 0;
    const pos = Math.max(top, readPointKey.getState(editor.state) ?? 0);
    const remaining = editor.state.doc.textBetween(Math.min(pos, size), size, " ", " ").length;
    setProgress({ pct: Math.min(100, Math.round((pos / size) * 100)), minutes: Math.ceil(remaining / CHARS_PER_MINUTE) });
  }, [editor]);

  /** Leaving without a read point: bookmark the top of what's on screen. */
  const autoReadPoint = useCallback(() => {
    if (!editor || editor.isDestroyed || explicitRp.current || !readerRef.current || readerRef.current.scrollTop < 40) return;
    const box = readerRef.current.getBoundingClientRect();
    const pos = editor.view.posAtCoords({ left: box.left + 60, top: box.top + 12 })?.pos;
    if (pos == null) return;
    editor.view.dispatch(editor.state.tr.setMeta(readPointKey, pos));
    dirty.current = true;
  }, [editor]);

  const save = useCallback(async () => {
    window.clearTimeout(saveTimer.current);
    if (!editor || !dirty.current) return;
    dirty.current = false;
    const rp = readPointKey.getState(editor.state) ?? null;
    await api.saveTopic(id, JSON.stringify(editor.getJSON()), rp);
  }, [editor, id]);

  // Restore the read point and scroll to it once the editor exists.
  useEffect(() => {
    if (!editor) return;
    const rp = topic.read_point;
    if (rp != null && rp <= editor.state.doc.content.size) {
      editor.view.dispatch(editor.state.tr.setMeta(readPointKey, rp));
      editor.commands.setTextSelection(rp);
      requestAnimationFrame(() => {
        editor.view.dom.querySelector(".ir-readpoint")?.scrollIntoView({ block: "center" });
        updateProgress();
      });
    } else requestAnimationFrame(updateProgress);
    return () => {
      autoReadPoint();
      void save();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  const setReadPoint = useCallback(
    (ed: Editor, pos?: number) => {
      explicitRp.current = true;
      ed.view.dispatch(ed.state.tr.setMeta(readPointKey, pos ?? ed.state.selection.to));
      updateProgress();
      dirty.current = true;
      void save();
    },
    [save, updateProgress],
  );

  /** Extracts made from this topic (for the selectivity counter). */
  const made = useRef(element.children);
  const extract = useCallback(async (withPriority = false) => {
    if (!editor) return;
    let priority: number | null = null;
    if (withPriority) {
      const v = window.prompt("Priority for this extract (0 = most important; the parent is " + Math.round(element.priority) + "%)", String(Math.max(0, Math.round(element.priority) - 5)));
      if (v == null) return;
      const n = Number(v);
      if (!Number.isNaN(n)) priority = Math.max(0, Math.min(100, n));
    }
    const { from, to, empty } = editor.state.selection;
    if (empty) return notify("Select text to extract");
    const slice = editor.state.doc.slice(from, to);
    let content: any[] = slice.content.toJSON() ?? [];
    if (slice.content.firstChild?.isInline) content = [{ type: "paragraph", content }];
    let doc: any = { type: "doc", content: stripIrMarks(content) };
    try {
      editor.schema.nodeFromJSON(doc).check();
    } catch {
      // Partial structure (e.g. a list item without its list): fall back to text.
      const text = editor.state.doc.textBetween(from, to, "\n");
      doc = { type: "doc", content: text.split("\n").filter(Boolean).map((t) => textDoc(t).content[0]) };
    }
    const childId = await api.createExtract(id, "", JSON.stringify(doc));
    if (priority != null) await api.setPriority(childId, priority);
    editor.chain().setTextSelection({ from, to }).setMark("extract", { id: childId }).setTextSelection(to).run();
    setReadPoint(editor, to);
    made.current += 1;
    // Over-extracting is the usual way a backlog starts: keep the count in view.
    notify(`Extract created${priority != null ? ` at ${priority}%` : ""} · ${made.current} from this topic${made.current >= 15 ? " — be selective" : ""}`);
    onChanged?.();
  }, [editor, element.priority, id, notify, onChanged, setReadPoint]);

  /** Headings, for the table of contents. */
  const [tocOpen, setTocOpen] = useState(false);
  const headings = () => {
    const out: { pos: number; level: number; text: string }[] = [];
    editor?.state.doc.descendants((n, pos) => {
      if (n.type.name === "heading") out.push({ pos, level: n.attrs.level ?? 1, text: n.textContent });
      return n.isBlock && n.type.name !== "heading";
    });
    return out;
  };
  const jumpTo = (pos: number) => {
    if (!editor) return;
    setTocOpen(false);
    const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
    dom?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const cloze = useCallback(async () => {
    if (!editor) return;
    const { state } = editor;
    const { from, to, empty, $from, $to } = state.selection;
    if (empty) return notify("Select a keyword to cloze");
    if (!$from.sameParent($to) || !$from.parent.isTextblock) return notify("A cloze must be inside one paragraph");
    const { question, answer } = clozeDocs(state, from, to);
    const itemId = await api.createItem(id, "cloze", JSON.stringify(question), JSON.stringify(answer));
    editor.chain().setTextSelection({ from, to }).setMark("cloze", { id: itemId }).setTextSelection(to).run();
    // Keep the cursor in the text so the next keyword + Alt+Z follows straight on.
    const run = clozeRun.current;
    run.n = Date.now() - run.at < 30_000 ? run.n + 1 : 1;
    run.at = Date.now();
    notify(run.n > 1 ? `Cloze created (${run.n} in a row)` : "Cloze created");
    onChanged?.();
  }, [editor, id, notify, onChanged]);

  /** New Q&A item under this topic; the selection (if any) seeds the answer. */
  const addQa = useCallback(async () => {
    if (!editor) return;
    const { from, to, empty } = editor.state.selection;
    const answer = empty ? "" : editor.state.doc.textBetween(from, to, " ").trim();
    const itemId = await api.createItem(id, "qa", JSON.stringify(EMPTY_DOC), JSON.stringify(textDoc(answer)));
    await save();
    onChanged?.();
    onOpen?.(itemId);
  }, [editor, id, onChanged, onOpen, save]);

  /**
   * Dismember: one child topic per section at the highest heading level, then
   * Done! on this topic (its text is archived; the children carry on).
   */
  const splitByHeadings = useCallback(async () => {
    if (!editor) return;
    const nodes: any[] = editor.getJSON().content ?? [];
    const levels = nodes.filter((n) => n.type === "heading").map((n) => n.attrs?.level ?? 1);
    if (!levels.length) return notify("No headings to split at");
    const level = Math.min(...levels);
    const text = (n: any): string => (n.text ?? "") + (n.content ?? []).map(text).join("");
    const sections: { title: string; nodes: any[] }[] = [];
    for (const n of nodes) {
      if (n.type === "heading" && (n.attrs?.level ?? 1) === level) sections.push({ title: text(n).trim() || "Section", nodes: [n] });
      else if (sections.length) sections[sections.length - 1].nodes.push(n);
      else sections.push({ title: "Introduction", nodes: [n] });
    }
    const real = sections.filter((s) => s.nodes.some((n) => text(n).trim()));
    if (real.length < 2) return notify("Only one section; nothing to split");
    if (!window.confirm(`Split into ${real.length} topics at heading level ${level}? This topic's text moves into them (Done!).`)) return;
    await save();
    const ids: number[] = [];
    for (const s of real) ids.push(await api.createExtract(id, s.title, JSON.stringify({ type: "doc", content: stripIrMarks(s.nodes) })));
    // Keep the sections together, in reading order, just after this topic in the queue.
    await api.bulk(ids, "priority", element.priority);
    notify(`Split into ${real.length} topics`);
    onChanged?.();
    await finish("done");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, id, notify, onChanged, save]);

  /** The selected image, or the first image in the selection. */
  const selectedImage = useCallback((): string | null => {
    if (!editor) return null;
    const sel = editor.state.selection;
    if (sel instanceof NodeSelection && sel.node.type.name === "image") return sel.node.attrs.src;
    let found: string | null = null;
    editor.state.doc.nodesBetween(sel.from, Math.max(sel.to, sel.from + 1), (n) => {
      if (!found && n.type.name === "image") found = n.attrs.src;
      return !found;
    });
    return found;
  }, [editor]);

  const occlude = useCallback(() => {
    const src = selectedImage();
    if (!src) return notify("Click an image first, then Occlude");
    setOccluding(src);
  }, [notify, selectedImage]);

  /** Clip extract: the transcript paragraphs that fall in the range come along as text. */
  const makeClip = useCallback(
    async (start: number, end: number) => {
      const paras: any[] = editor?.getJSON().content ?? [];
      const stamp = (p: any) => timeFromHref(p.content?.find((c: any) => c.marks?.some((m: any) => m.type === "link"))?.marks?.find((m: any) => m.type === "link")?.attrs?.href);
      const picked = paras.filter((p) => {
        const t = stamp(p);
        return t != null && t >= start - 30 && t < end;
      });
      const doc = picked.length ? { type: "doc", content: stripIrMarks(picked) } : EMPTY_DOC;
      await api.createClip(id, `${fmtTime(start)}–${fmtTime(end)} · ${element.title}`, start, end, JSON.stringify(doc));
      notify(`Clip ${fmtTime(start)}–${fmtTime(end)} extracted`);
      onChanged?.();
    },
    [editor, element.title, id, notify, onChanged],
  );

  /** Show where an extracted/clozed span lives and when it's due. */
  const onReaderOver = useCallback(
    (ev: React.MouseEvent) => {
      const span = (ev.target as HTMLElement).closest("[data-extract],[data-cloze]") as HTMLElement | null;
      const cid = span ? Number(span.dataset.extract ?? span.dataset.cloze) : 0;
      if (!cid || !readerRef.current) {
        peekTarget.current = null;
        return setPeek(null);
      }
      if (peekTarget.current === cid) return;
      peekTarget.current = cid;
      const box = readerRef.current.getBoundingClientRect();
      const r = span!.getBoundingClientRect();
      const pos = { top: r.bottom - box.top + readerRef.current.scrollTop + 4, left: Math.max(8, Math.min(r.left - box.left, box.width - 300)) };
      const show = (text: string) => peekTarget.current === cid && setPeek({ ...pos, text });
      const cached = peekCache.current.get(cid);
      if (cached) return show(cached);
      api
        .getElement(cid)
        .then((el) => {
          const due = el.topic?.due_day ?? el.item?.due_day;
          const when = el.status !== "active" ? el.status : due == null ? "" : `due ${fmtDays(due - (today ?? due))}`;
          const text = `${el.kind === "item" ? "Item" : "Extract"}: ${el.title}${when ? ` · ${when}` : ""}${el.children ? ` · ${el.children} children` : ""} — Ctrl+click to open`;
          peekCache.current.set(cid, text);
          show(text);
        })
        .catch(() => show("Deleted element"));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const ignore = useCallback(() => {
    if (!editor || editor.state.selection.empty) return;
    editor.chain().toggleMark("ignore").run();
  }, [editor]);

  /** Remove everything before the cursor (text already processed). */
  const deleteBefore = useCallback(() => {
    if (!editor) return;
    const { from } = editor.state.selection;
    if (from <= 1) return;
    editor.view.dispatch(editor.state.tr.delete(0, from).setMeta(readPointKey, 0));
    editor.commands.setTextSelection(1);
    notify("Deleted text before the cursor");
  }, [editor, notify]);

  const finish = useCallback(
    async (outcome: TopicOutcome, days?: number) => {
      if (busy) return;
      setBusy(true);
      try {
        if (outcome !== "done") autoReadPoint();
        await save();
        if (outcome === "next") notify(`Next read in ${fmtDays(await api.topicRead(id, Date.now() - openedAt.current))}`);
        else if (outcome === "done") {
          await api.done(id);
          notify("Done! — text removed, extracts kept", { undo: true });
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
    [autoReadPoint, busy, id, notify, onFinish, save],
  );

  const askReschedule = useCallback(() => {
    const v = window.prompt("Next review in how many days?", String(Math.max(1, topic.interval_days)));
    const n = v == null ? NaN : parseInt(v, 10);
    if (!Number.isNaN(n)) void finish("rescheduled", n);
  }, [finish, topic.interval_days]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const k = ev.key.toLowerCase();
      const run = (f: () => unknown) => (ev.preventDefault(), void f());
      if (ev.altKey && ev.shiftKey && k === "x") return run(() => extract(true));
      if (ev.altKey && k === "x") return run(() => extract());
      if (ev.altKey && k === "z") return run(cloze);
      if (ev.altKey && k === "a") return run(addQa);
      if (ev.altKey && k === "i") return run(ignore);
      if (ev.altKey && k === "o") return run(occlude);
      if (ev.altKey && ev.key === "\\") return run(deleteBefore);
      if ((ev.altKey && k === "r") || (ev.ctrlKey && ev.key === "F7")) return run(() => editor && setReadPoint(editor));
      // Esc leaves the text, so Space works as Next again.
      if (ev.key === "Escape" && editor?.isFocused && !selBox) return run(() => editor.commands.blur());
      if (!active) return;
      // Space: Next (in the queue only; while browsing it would mark the topic read by accident).
      if (mode === "learn" && isDefaultAction(ev)) return void finish("next");
      if (ev.ctrlKey && ev.shiftKey && k === "enter") return run(() => finish("done"));
      if (ev.ctrlKey && k === "enter") return run(() => finish("next"));
      if (ev.ctrlKey && k === "j") return run(askReschedule);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, addQa, askReschedule, cloze, deleteBefore, editor, extract, finish, ignore, mode, occlude, selBox, setReadPoint]);

  return (
    <div className="element-view">
      <ElementHeader
        element={element}
        onOpen={onOpen}
        onChanged={onChanged}
        onReviewBranch={onReviewBranch}
        onRestore={() => finish("restored")}
      />
      <div className="toolbar">
        <button onClick={() => void extract()} title="Alt+X · Shift+Alt+X to choose its priority">Extract</button>
        <button onClick={cloze} title="Alt+Z">Cloze</button>
        <button onClick={addQa} title="Alt+A — selection becomes the answer">Q&amp;A</button>
        <button onClick={ignore} title="Alt+I">Ignore</button>
        <button onClick={() => editor && setReadPoint(editor)} title="Alt+R / Ctrl+F7">Read point</button>
        <button onClick={deleteBefore} title="Alt+\ — delete everything before the cursor">Delete before</button>
        <button onClick={splitByHeadings} title="One child topic per section (SuperMemo's Dismember)">Split</button>
        <button onClick={occlude} title="Alt+O — click an image first; one item per covered region">Occlude</button>
        <span className="toc-wrap">
          <button onClick={() => setTocOpen((o) => !o)} title="Table of contents">Contents ▾</button>
          {tocOpen && (
            <div className="toc-menu" onMouseLeave={() => setTocOpen(false)}>
              {headings().length === 0 && <div className="muted small pad">No headings</div>}
              {headings().map((h) => (
                <a key={h.pos} style={{ paddingLeft: 8 + (h.level - 1) * 12 }} onClick={() => jumpTo(h.pos)}>
                  {h.text || "(untitled)"}
                </a>
              ))}
            </div>
          )}
        </span>
        <span className="spacer" />
        <span className="muted small">
          {progress && !isVideo && `${progress.pct}% · ~${progress.minutes} min left · `}interval {fmtDays(topic.interval_days)}
        </span>
        <AFactor id={id} afactor={topic.afactor} interval={topic.interval_days} notify={notify} onChanged={onChanged} />
      </div>
      {isVideo && <VideoPanel ref={video} element={element} notify={notify} onClip={makeClip} />}
      <FormatBar editor={editor} />
      <div className="read-progress">
        <div style={{ width: `${progress?.pct ?? 0}%` }} />
      </div>
      <div
        className="reader"
        ref={readerRef}
        onScroll={() => {
          if (selBox && editor) placeToolbar(editor);
          setPeek(null);
          requestAnimationFrame(updateProgress);
        }}
        onMouseOver={onReaderOver}
        onClickCapture={(ev) => {
          // Runs before the opener plugin's window listener, which skips prevented clicks.
          const link = (ev.target as HTMLElement).closest("a[href^='#t=']");
          const at = timeFromHref(link?.getAttribute("href"));
          if (at == null) return;
          ev.preventDefault();
          video.current?.seek(at);
        }}
        onMouseLeave={() => ((peekTarget.current = null), setPeek(null))}
      >
        {peek && (
          <div className="peek small" style={{ top: peek.top, left: peek.left }}>
            {peek.text}
          </div>
        )}
        {selBox && (
          <div className="sel-toolbar" style={{ top: selBox.top, left: selBox.left }} onMouseDown={(e) => e.preventDefault()}>
            <button onClick={() => void extract()}>Extract <kbd>Alt+X</kbd></button>
            <button onClick={cloze}>Cloze <kbd>Alt+Z</kbd></button>
            <button onClick={addQa}>Q&amp;A <kbd>Alt+A</kbd></button>
            <button onClick={ignore}>Ignore</button>
            {selectedImage() && <button onClick={occlude}>Occlude <kbd>Alt+O</kbd></button>}
            <button onClick={() => editor && setReadPoint(editor)} title="Read point here">◆</button>
          </div>
        )}
        <EditorContent editor={editor} />
      </div>
      {isVideo && editor?.isEmpty && (
        <p className="muted small pad">No transcript. Watch, mark a start and an end to make clips, or paste a transcript here.</p>
      )}
      {occluding && (
        <OcclusionDialog
          src={occluding}
          parentId={id}
          title={element.title}
          notify={notify}
          onClose={() => setOccluding(null)}
          onCreated={() => {
            setOccluding(null);
            onChanged?.();
          }}
        />
      )}
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
        {active && (
          <button disabled={busy} onClick={() => finish("rescheduled", 100)} title="Come back in 100 days">
            Don't get it · +100d
          </button>
        )}
        <span className="spacer" />
        {onDelete && <button disabled={busy} className="danger" onClick={onDelete}>Delete</button>}
        {active && (
          <>
            <button disabled={busy} onClick={() => finish("dismiss")} title="Stop reading; keep text and children">Dismiss</button>
            <button disabled={busy} onClick={() => finish("done")} title="Ctrl+Shift+Enter — remove the text, keep extracts and clozes">
              Done!
            </button>
          </>
        )}
      </footer>
    </div>
  );
}
