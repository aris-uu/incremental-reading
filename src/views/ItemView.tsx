import { useCallback, useEffect, useRef, useState } from "react";
import type { Notify } from "../notify";
import { api, fmtDays, LEECH_LAPSES, type ElementFull } from "../api";
import { RichField } from "../editor/RichField";
import { ElementHeader } from "./ElementHeader";
import { lintItem } from "../lint";
import { isDefaultAction } from "../keys";
import { loadPrefs } from "../prefs";
import { playSound } from "../editor/audio";
import { parseDoc } from "../editor/extensions";

/** Text of a ProseMirror node (JSON). */
const nodeText = (n: any): string => (n.type === "text" ? n.text ?? "" : n.type?.startsWith("math") ? `$${n.attrs?.latex ?? ""}$` : (n.content ?? []).map(nodeText).join(""));
const hasMark = (n: any, id: number): boolean =>
  (n.marks ?? []).some((m: any) => (m.type === "cloze" || m.type === "extract") && m.attrs?.id === id) || (n.content ?? []).some((c: any) => hasMark(c, id));

/**
 * The passage an item came from: the parent's paragraph that holds this
 * item's cloze mark, with its neighbours; or the start of the parent's text.
 */
function sourceContext(parentDoc: string, itemId: number): { before: string; hit: string; after: string } | null {
  const blocks: any[] = [];
  const walk = (n: any) => (n.content?.some((c: any) => c.type === "text" || c.type?.startsWith("math")) ? blocks.push(n) : (n.content ?? []).forEach(walk));
  walk(parseDoc(parentDoc));
  if (!blocks.length) return null;
  const i = blocks.findIndex((b) => hasMark(b, itemId));
  if (i < 0) return { before: "", hit: blocks.slice(0, 2).map(nodeText).join(" ").slice(0, 700), after: "" };
  return { before: i > 0 ? nodeText(blocks[i - 1]) : "", hit: nodeText(blocks[i]), after: i + 1 < blocks.length ? nodeText(blocks[i + 1]) : "" };
}

/** Collapsed drawer on the answer side: the surrounding text in the source. */
function ContextDrawer({ element }: { element: ElementFull }) {
  const [ctx, setCtx] = useState<ReturnType<typeof sourceContext> | undefined>(undefined);
  const load = () => {
    if (ctx !== undefined || element.parent_id == null) return;
    api
      .getElement(element.parent_id)
      .then((p) => setCtx(p.topic ? sourceContext(p.topic.doc_json, element.id) : null))
      .catch(() => setCtx(null));
  };
  if (element.parent_id == null) return null;
  return (
    <details className="context-drawer small" onToggle={(e) => (e.target as HTMLDetailsElement).open && load()}>
      <summary>Context from “{element.parent_title}”</summary>
      {ctx === undefined ? (
        <p className="muted">Loading…</p>
      ) : ctx === null ? (
        <p className="muted">The source has no text (finished or a PDF).</p>
      ) : (
        <div className="context-text">
          {ctx.before && <p className="muted">{ctx.before}</p>}
          <p>{ctx.hit}</p>
          {ctx.after && <p className="muted">{ctx.after}</p>}
        </div>
      )}
    </details>
  );
}

export type ItemOutcome = "graded" | "again" | "rescheduled" | "done" | "dismiss" | "restored";

interface Props {
  element: ElementFull;
  mode: "learn" | "browse";
  onFinish: (outcome: ItemOutcome) => void;
  onOpen?: (id: number) => void;
  onChanged?: () => void;
  onDelete?: () => void;
  onReviewBranch?: (id: number) => void;
  notify: Notify;
}

const GRADES = [
  { g: 1, label: "Again" },
  { g: 2, label: "Hard" },
  { g: 3, label: "Good" },
  { g: 4, label: "Easy" },
] as const;

/** Keyboard shortcuts must not fire while typing in a field. */
const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/**
 * A question/answer item (clozes are Q&A items whose question contains [...]).
 * Both sides are always editable. In the queue the answer starts hidden.
 */
export function ItemView({ element, mode, onFinish, onOpen, onChanged, onDelete, onReviewBranch, notify }: Props) {
  const item = element.item!;
  const [shown, setShown] = useState(mode === "browse");
  const [preview, setPreview] = useState<[number, number, number, number] | null>(null);
  const [busy, setBusy] = useState(false);
  const q = useRef(item.question);
  const a = useRef(item.answer);
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const [hints, setHints] = useState(() => lintItem(item.question, item.answer));
  const [needsWork, setNeedsWork] = useState(element.needs_work);
  const twoButton = loadPrefs().grading === "2";
  // Mined cards: play the first sound of the answer on reveal (word audio).
  useEffect(() => {
    if (!shown || mode !== "learn" || !loadPrefs().autoplay) return;
    const t = window.setTimeout(() => {
      const s = cardRef.current?.querySelector(".card-a [data-sound]") as HTMLElement | null;
      if (s?.dataset.sound) playSound(s.dataset.sound);
    }, 50);
    return () => window.clearTimeout(t);
  }, [mode, shown]);
  const hasList = /"type":"(bulletList|orderedList)"/.test(item.answer);
  /** Time on card, for the cost statistics. */
  const openedAt = useRef(Date.now());
  const cardRef = useRef<HTMLDivElement>(null);
  /** Put the cursor in the question to fix the item, without leaving the queue. */
  const editQuestion = useCallback(() => {
    const el = cardRef.current?.querySelector(".card-q .tiptap") as HTMLElement | null;
    el?.focus();
  }, []);

  const leech = item.lapses >= LEECH_LAPSES;

  const toggleNeedsWork = useCallback(async () => {
    const v = !needsWork;
    await api.setFlag(element.id, "needs_work", v);
    setNeedsWork(v);
    notify(v ? "Flagged: needs work (schedule unchanged)" : "Needs-work flag cleared");
    onChanged?.();
  }, [element.id, needsWork, notify, onChanged]);

  const active = element.status === "active";
  /** Grading is a repetition: only from the Learn queue, never while browsing. */
  const canGrade = mode === "learn" && active;

  const save = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (!dirty.current) return;
    dirty.current = false;
    await api.saveItem(element.id, q.current, a.current);
    onChanged?.();
  }, [element.id, onChanged]);

  const edited = (side: "q" | "a") => (json: string) => {
    (side === "q" ? q : a).current = json;
    setHints(lintItem(q.current, a.current));
    dirty.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(), 700);
  };

  useEffect(() => () => void save(), [save]);

  /** Alt+P: move the item in the priority queue. */
  const askPriority = useCallback(() => {
    const v = window.prompt("Priority (0 = most important)", String(Math.round(element.priority)));
    const n = v == null ? NaN : Number(v);
    if (!Number.isNaN(n)) void api.setPriority(element.id, Math.max(0, Math.min(100, n))).then(() => (notify(`Priority ${n}%`, { undo: true }), onChanged?.()));
  }, [element.id, element.priority, notify, onChanged]);

  /** A list in the answer is hard to recall: one item per entry, the original retired. */
  const splitList = useCallback(async () => {
    await save();
    let doc: any;
    try {
      doc = JSON.parse(a.current);
    } catch {
      return;
    }
    const entries: any[] = [];
    const walk = (n: any) => (n.type === "listItem" ? entries.push(n) : (n.content ?? []).forEach(walk));
    walk(doc);
    if (entries.length < 2) return notify("No list with several entries in the answer");
    if (!window.confirm(`Make ${entries.length} items, one per list entry, and retire this one?`)) return;
    const qDoc = JSON.parse(q.current);
    for (const [i, li] of entries.entries()) {
      const question = { ...qDoc, content: [...(qDoc.content ?? []), { type: "paragraph", content: [{ type: "text", text: `(entry ${i + 1} of ${entries.length})` }] }] };
      const answer = { type: "doc", content: li.content?.length ? li.content : [{ type: "paragraph" }] };
      await api.createItem(element.parent_id, "qa", JSON.stringify(question), JSON.stringify(answer));
    }
    await api.dismiss(element.id);
    notify(`Split into ${entries.length} items; the original is dismissed`, { undo: true });
    onFinish("dismiss");
  }, [element.id, element.parent_id, notify, onFinish, save]);

  /** A sibling item under the same parent (e.g. when splitting a leech in two). */
  const addSibling = useCallback(async () => {
    await save();
    const empty = JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] });
    const id = await api.createItem(element.parent_id, "qa", q.current, empty);
    notify("New item with the same question: edit both so each asks one thing");
    onChanged?.();
    onOpen?.(id);
  }, [element.parent_id, notify, onChanged, onOpen, save]);

  /** Q&A: also ask the other way round (answer → question), as its own item. */
  const addReverse = useCallback(async () => {
    await save();
    const id = await api.createItem(element.parent_id, "qa", a.current, q.current);
    notify("Reverse item created", { undo: false });
    onChanged?.();
    if (mode === "browse") onOpen?.(id);
  }, [element.parent_id, mode, notify, onChanged, onOpen, save]);

  useEffect(() => {
    api.previewItem(element.id).then(setPreview).catch(() => setPreview(null));
  }, [element.id]);

  const act = useCallback(
    async (fn: () => Promise<unknown>, outcome: ItemOutcome) => {
      if (busy) return;
      setBusy(true);
      try {
        await save();
        await fn();
        onFinish(outcome);
      } catch (e) {
        notify(String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, notify, onFinish, save],
  );

  const grade = useCallback(
    (g: 1 | 2 | 3 | 4) =>
      act(async () => {
        const iv = await api.gradeItem(element.id, g, Date.now() - openedAt.current);
        notify(g === 1 ? "Again — back later today" : `Next review in ${fmtDays(iv)}`);
      }, g === 1 ? "again" : "graded"),
    [act, element.id, notify],
  );

  const askReschedule = useCallback(() => {
    const v = window.prompt("Next review in how many days?", String(Math.max(1, item.interval_days)));
    const n = v == null ? NaN : parseInt(v, 10);
    if (!Number.isNaN(n)) void act(() => api.reschedule(element.id, n).then(() => notify(`Rescheduled to ${fmtDays(n)}`, { undo: true })), "rescheduled");
  }, [act, element.id, item.interval_days]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.ctrlKey && ev.key.toLowerCase() === "j") return ev.preventDefault(), askReschedule();
      if (ev.altKey && ev.key.toLowerCase() === "w") return ev.preventDefault(), void toggleNeedsWork();
      if (ev.ctrlKey && ev.key.toLowerCase() === "e") return ev.preventDefault(), editQuestion();
      if (ev.altKey && ev.key.toLowerCase() === "p") return ev.preventDefault(), askPriority();
      if (ev.key === "Escape" && isTyping(ev.target)) return (ev.target as HTMLElement).blur();
      // Space: show the answer, then grade Good.
      if (isDefaultAction(ev)) {
        if (!shown) setShown(true);
        else if (canGrade) void grade(3);
        return;
      }
      if (isTyping(ev.target) || ev.ctrlKey || ev.altKey || ev.metaKey) return;
      if (!shown && ev.key === "Enter") {
        ev.preventDefault();
        setShown(true);
      } else if (shown && canGrade && ["1", "2", "3", "4"].includes(ev.key)) {
        ev.preventDefault();
        // Pass/fail mode: 1 = Again, any other number = Good.
        void grade(twoButton ? (ev.key === "1" ? 1 : 3) : (Number(ev.key) as 1 | 2 | 3 | 4));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [askPriority, askReschedule, canGrade, editQuestion, grade, shown, toggleNeedsWork, twoButton]);

  return (
    <div className="element-view">
      <ElementHeader
        element={element}
        onOpen={onOpen}
        onChanged={onChanged}
        onReviewBranch={onReviewBranch}
        onRestore={() => act(() => api.restore(element.id), "restored")}
      />
      {(leech || needsWork) && (
        <div className="flag-banner small">
          {leech && (
            <>
              <span className="chip warn">leech: forgotten {item.lapses}×. Rescheduling won't fix it</span>
              <button className="small-btn" onClick={editQuestion} title="Ctrl+E — rewrite it; the hints below follow the minimum-information principle">Reformulate</button>
              <button className="small-btn" onClick={() => void addSibling()} title="Split: a second item with the same question, to divide what it asks">Split</button>
              <button className="small-btn" onClick={() => act(() => api.dismiss(element.id).then(() => notify("Retired (dismissed); its source extract stays", { undo: true })), "dismiss")} title="Stop reviewing it; keep it and its source">Retire</button>
            </>
          )}
          {needsWork && <span className="chip warn">needs work</span>}
        </div>
      )}
      <div className="card" ref={cardRef}>
        <div className="card-label">Question</div>
        <RichField className="card-q" docJson={item.question} onChange={edited("q")} placeholder="Question…" />
        {shown ? (
          <>
            <div className="card-label">Answer</div>
            <RichField className="card-a" docJson={item.answer} onChange={edited("a")} placeholder="Answer…" />
            <ContextDrawer element={element} />
          </>
        ) : (
          <button className="reveal" onClick={() => setShown(true)}>
            Show answer <kbd>Space</kbd>
          </button>
        )}
        {(shown || mode === "browse") && hints.length > 0 && (
          <ul className="lint small" title="Hints from the minimum-information principle">
            {hints.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        )}
        <div className="muted small card-meta">
          {item.reps === 0 ? "new" : `reps ${item.reps} · lapses ${item.lapses}`}
          {item.stability != null && ` · stability ${item.stability.toFixed(1)}d · difficulty ${item.difficulty?.toFixed(1)}`}
          {` · interval ${fmtDays(item.interval_days)}`}
        </div>
      </div>
      <footer className="actions">
        {shown && active &&
          GRADES.filter(({ g }) => !twoButton || g === 1 || g === 3).map(({ g, label }) => (
            <button
              key={g}
              className={`grade g${g}`}
              disabled={busy || !canGrade}
              title={canGrade ? undefined : "Grade from the Learn queue"}
              onClick={() => grade(g)}
            >
              {label}
              {g === 3 && <kbd className="space-hint">Space</kbd>}
              <small>{preview ? fmtDays(preview[g - 1]) : ""}</small>
              <kbd>{g}</kbd>
            </button>
          ))}
        <button disabled={busy} onClick={askReschedule} title="Ctrl+J">Reschedule…</button>
        {hasList && <button onClick={() => void splitList()} title="One item per list entry">Split list</button>}
        {item.fields_json && mode === "browse" && (
          <button
            onClick={async () => {
              if (!window.confirm("Rebuild this card from its Yomitan fields? Your edits to it are replaced (you can undo).")) return;
              await api.requeueMined([element.id]);
              const { renderPendingCards } = await import("../japanese");
              await renderPendingCards();
              notify("Card rebuilt", { undo: true });
              onFinish("restored");
            }}
            title="Lay the card out again from the dictionary fields it was mined with"
          >
            Rebuild
          </button>
        )}
        {item.item_type === "qa" && (
          <button onClick={() => void addReverse()} title="Also ask the other way round, as a separate item">Add reverse</button>
        )}
        <button className={needsWork ? "active" : ""} onClick={() => void toggleNeedsWork()} title="Alt+W — mark to rewrite later; the schedule is unchanged">
          {needsWork ? "✓ Needs work" : "Needs work"}
        </button>
        <span className="spacer" />
        {onDelete && <button disabled={busy} className="danger" onClick={onDelete}>Delete</button>}
        {active && (
          <>
            <button disabled={busy} onClick={() => act(() => api.dismiss(element.id).then(() => notify("Dismissed", { undo: true })), "dismiss")} title="Stop reviewing; keep it">Dismiss</button>
            <button disabled={busy} onClick={() => act(() => api.done(element.id).then(() => notify("Done", { undo: true })), "done")} title="Finished with this item">Done</button>
          </>
        )}
      </footer>
    </div>
  );
}
