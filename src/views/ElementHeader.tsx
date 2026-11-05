import { useEffect, useState } from "react";
import { api, fmtDays, type ElementFull } from "../api";
import { useToday } from "../notify";

/** "Why is this here?": timing, queue position, and what last moved it. */
function whyChips(el: ElementFull, today: number | null, rank: number, size: number): string[] {
  const due = el.topic?.due_day ?? el.item?.due_day;
  const out: string[] = [];
  if (today != null && due != null && el.status === "active") {
    const d = today - due;
    out.push(d > 0 ? `${d} day${d === 1 ? "" : "s"} overdue` : d === 0 ? "due today" : `early: due in ${fmtDays(-d)}`);
  }
  if (el.status === "active" && size > 0) out.push(`#${rank} of ${size} by priority`);
  if (el.item && el.item.reps === 0) out.push("new item");
  else if (el.topic && el.topic.last_day == null && el.status === "active") out.push("first read");
  if (el.last_event === "postpone") out.push("was postponed");
  if (el.last_event === "reschedule") out.push("rescheduled by you");
  return out;
}

function hostname(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

interface Props {
  element: ElementFull;
  onOpen?: (id: number) => void;
  onChanged?: () => void;
  onRestore?: () => void;
  onReviewBranch?: (id: number) => void;
}

/** Title, priority, status and the propagated reference, shared by topics and items. */
export function ElementHeader({ element, onOpen, onChanged, onRestore, onReviewBranch }: Props) {
  const [title, setTitle] = useState(element.title);
  const [priority, setPriority] = useState(element.priority);
  const [rank, setRank] = useState({ rank: element.queue_rank, size: element.queue_size });
  const today = useToday();
  useEffect(() => {
    setTitle(element.title);
    setPriority(element.priority);
    setRank({ rank: element.queue_rank, size: element.queue_size });
  }, [element.id, element.title, element.priority, element.queue_rank, element.queue_size]);

  /** Priority is a position in one queue: typing a % moves the element there. */
  const commitPriority = async () => {
    if (priority === element.priority) return;
    await api.setPriority(element.id, priority);
    const fresh = await api.getElement(element.id);
    setPriority(fresh.priority);
    setRank({ rank: fresh.queue_rank, size: fresh.queue_size });
    onChanged?.();
  };

  const ref = element.reference;
  const inactive = element.status === "done" || element.status === "dismissed";
  return (
    <header className="element-header">
      {element.status === "inbox" && (
        <div className="status-banner">
          <span>In the inbox — not in the learning queue yet.</span>
          {onRestore && <button onClick={onRestore}>Accept at {Math.round(element.priority)}%</button>}
        </div>
      )}
      {inactive && (
        <div className="status-banner">
          <span>
            {element.status === "done" ? "Done" : "Dismissed"} — not in the learning queue.
            {element.topic?.archived && " Its text was removed by Done!; Restore brings it back."}
          </span>
          {onRestore && <button onClick={onRestore}>Restore</button>}
        </div>
      )}
      <div className="row">
        <span className={`badge ${element.kind}`}>{element.kind === "topic" ? "T" : "Q"}</span>
        <input
          className="title-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          onBlur={() => title !== element.title && api.setTitle(element.id, title).then(onChanged)}
        />
        <label
          className="priority"
          title="Priority is this element's position in the queue of all active elements: 0% is the head, 100% the tail. Type a % to move it there."
        >
          P
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={Math.round(priority * 10) / 10}
            onChange={(e) => setPriority(Number(e.target.value))}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            onBlur={() => void commitPriority()}
          />
          %
          {element.status === "active" && rank.size > 0 && (
            <span className="muted small mono">
              #{rank.rank}/{rank.size}
            </span>
          )}
        </label>
        {onReviewBranch && element.children > 0 && (
          <button className="small-btn" onClick={() => onReviewBranch(element.id)} title="Review this element and everything derived from it">
            Review branch
          </button>
        )}
      </div>
      {element.status === "active" && (
        <div className="row why" title="Why this element is in front of you now">
          {whyChips(element, today, rank.rank, rank.size).map((c) => (
            <span key={c} className="chip">{c}</span>
          ))}
        </div>
      )}
      <div className="row muted small">
        {element.parent_id != null && <a onClick={() => onOpen?.(element.parent_id!)}>↑ {element.parent_title}</a>}
        {ref && ref.source_id !== element.id && <span>· from {ref.title}</span>}
        {ref?.url && (
          <a href={ref.url} target="_blank" rel="noreferrer">
            · {ref.site || hostname(ref.url)}
          </a>
        )}
        {ref?.author && <span>· {ref.author}</span>}
        {element.children > 0 && <span>· {element.children} children</span>}
      </div>
    </header>
  );
}
