import { useCallback, useEffect, useRef, useState } from "react";
import type { Notify } from "../notify";
import { api, fmtDays, type ElementFull } from "../api";
import { RichField } from "../editor/RichField";
import { ElementHeader } from "./ElementHeader";
import { lintItem } from "../lint";

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
        const iv = await api.gradeItem(element.id, g);
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
      if (isTyping(ev.target) || ev.ctrlKey || ev.altKey || ev.metaKey) return;
      if (!shown && (ev.key === " " || ev.key === "Enter")) {
        ev.preventDefault();
        setShown(true);
      } else if (shown && canGrade && ["1", "2", "3", "4"].includes(ev.key)) {
        ev.preventDefault();
        void grade(Number(ev.key) as 1 | 2 | 3 | 4);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [askReschedule, canGrade, grade, shown]);

  return (
    <div className="element-view">
      <ElementHeader
        element={element}
        onOpen={onOpen}
        onChanged={onChanged}
        onReviewBranch={onReviewBranch}
        onRestore={() => act(() => api.restore(element.id), "restored")}
      />
      <div className="card">
        <div className="card-label">Question</div>
        <RichField className="card-q" docJson={item.question} onChange={edited("q")} placeholder="Question…" />
        {shown ? (
          <>
            <div className="card-label">Answer</div>
            <RichField className="card-a" docJson={item.answer} onChange={edited("a")} placeholder="Answer…" />
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
          GRADES.map(({ g, label }) => (
            <button
              key={g}
              className={`grade g${g}`}
              disabled={busy || !canGrade}
              title={canGrade ? undefined : "Grade from the Learn queue"}
              onClick={() => grade(g)}
            >
              {label}
              <small>{preview ? fmtDays(preview[g - 1]) : ""}</small>
              <kbd>{g}</kbd>
            </button>
          ))}
        <button disabled={busy} onClick={askReschedule} title="Ctrl+J">Reschedule…</button>
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
