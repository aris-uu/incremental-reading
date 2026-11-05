import { useCallback, useEffect, useState } from "react";
import type { Notify } from "../notify";
import { api, type ElementFull, type QueueEntry } from "../api";
import { TopicView, type TopicOutcome } from "./TopicView";
import { ItemView, type ItemOutcome } from "./ItemView";

/**
 * The current learning session: today's queue, or a subset review (a branch,
 * search results). Lives in App so browsing elsewhere doesn't lose the place.
 */
export interface LearnSession {
  queue: QueueEntry[] | null;
  pos: number;
  /** Set for subset reviews; null for today's queue. */
  label: string | null;
  load: () => Promise<string | null>;
  startSubset: (label: string, entries: QueueEntry[]) => void;
  advance: (requeue: boolean) => void;
}

export function useLearnSession(): LearnSession {
  const [queue, setQueue] = useState<QueueEntry[] | null>(null);
  const [pos, setPos] = useState(0);
  const [label, setLabel] = useState<string | null>(null);

  /** Load today's queue. Returns a message when auto-postpone ran. */
  const load = useCallback(async () => {
    const res = await api.getQueue();
    setQueue(res.entries);
    setPos(0);
    setLabel(null);
    const p = res.auto_postponed;
    return p && (p.items || p.topics) ? `Overload: auto-postponed ${p.items} items and ${p.topics} topics` : null;
  }, []);

  const startSubset = useCallback((l: string, entries: QueueEntry[]) => {
    setQueue(entries);
    setPos(0);
    setLabel(l);
  }, []);

  const advance = useCallback(
    (requeue: boolean) => {
      // "Later today" and "Again" go to the end of this session's queue.
      setQueue((q) => (q && requeue && q[pos] ? [...q, q[pos]] : q));
      setPos((p) => p + 1);
    },
    [pos],
  );

  return { queue, pos, label, load, startSubset, advance };
}

interface Props {
  session: LearnSession;
  notify: Notify;
  onOpen: (id: number) => void;
  onChanged: () => void;
  onReviewBranch: (id: number) => void;
}

/** Walk the session queue, one element at a time. */
export function LearnView({ session, notify, onOpen, onChanged, onReviewBranch }: Props) {
  const { queue, pos, label, load, advance } = session;
  const [current, setCurrent] = useState<ElementFull | null>(null);

  useEffect(() => {
    if (queue == null) void load().then((m) => m && notify(m));
  }, [queue, load, notify]);

  const entry = queue?.[pos];
  useEffect(() => {
    if (!entry) return setCurrent(null);
    setCurrent(null);
    api.getElement(entry.id).then(setCurrent);
    // pos is a dependency so a requeued element is reloaded fresh.
  }, [entry, pos]);

  const next = useCallback(
    (requeue: boolean) => {
      advance(requeue);
      onChanged();
    },
    [advance, onChanged],
  );
  const onTopic = useCallback((o: TopicOutcome) => next(o === "later"), [next]);
  const onItem = useCallback((o: ItemOutcome) => next(o === "again"), [next]);

  if (queue == null) return <p className="muted pad">Loading…</p>;
  if (!entry)
    return (
      <div className="empty">
        <h2>{label ? `Finished: ${label}` : "Nothing left for today"}</h2>
        <p className="muted">
          {queue.length > 0 ? `You went through ${queue.length} elements.` : "Import something to get started (Ctrl+N)."}
        </p>
        <button onClick={() => load().then((m) => m && notify(m))}>{label ? "Back to today's queue" : "Reload queue"}</button>
      </div>
    );

  return (
    <div className="learn">
      <div className="progress">
        <div className="bar" style={{ width: `${(pos / queue.length) * 100}%` }} />
        {label && (
          <span className="subset-label small">
            {label} · <a onClick={() => load()}>back to today's queue</a>
          </span>
        )}
        <span className="count-label small muted">
          {pos + 1} / {queue.length}
        </span>
      </div>
      {current?.id === entry.id && current.kind === "topic" && (
        <TopicView
          key={`${current.id}-${pos}`}
          element={current}
          mode="learn"
          notify={notify}
          onOpen={onOpen}
          onFinish={onTopic}
          onChanged={onChanged}
          onReviewBranch={onReviewBranch}
        />
      )}
      {current?.id === entry.id && current.kind === "item" && (
        <ItemView
          key={`${current.id}-${pos}`}
          element={current}
          mode="learn"
          notify={notify}
          onOpen={onOpen}
          onFinish={onItem}
          onChanged={onChanged}
          onReviewBranch={onReviewBranch}
        />
      )}
    </div>
  );
}
