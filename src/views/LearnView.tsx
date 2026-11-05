import { useCallback, useEffect, useState } from "react";
import type { Notify } from "../notify";
import { api, bandOf, type ElementFull, type FullStats, type QueueEntry, type SessionSummary, type Settings, type Started } from "../api";
import { TopicView, type TopicOutcome } from "./TopicView";
import { ItemView, type ItemOutcome } from "./ItemView";

/** Rough time per element, for time-boxed sessions. */
const MINUTES = { item: 0.25, topic: 3 } as const;

/**
 * The current learning session: today's queue, or a subset review (a branch,
 * search results). Lives in App so browsing elsewhere doesn't lose the place.
 */
export interface LearnSession {
  queue: QueueEntry[] | null;
  pos: number;
  /** Set for subset reviews; null for today's queue. */
  label: string | null;
  /** Unix seconds when the session started (for the summary). */
  startedAt: number;
  /** Time box end (ms since epoch), or null. */
  deadline: number | null;
  load: () => Promise<string | null>;
  startSubset: (label: string, entries: QueueEntry[]) => void;
  advance: (requeue: boolean) => void;
  /** Peek-drawer edits; indices are positions in `queue`. */
  move: (from: number, to: number) => void;
  removeAt: (i: number) => void;
  deferAt: (i: number) => void;
  /** Keep the most important elements that fit in `minutes`; returns how many. */
  timebox: (minutes: number) => number;
  endNow: () => void;
}

export function useLearnSession(): LearnSession {
  const [queue, setQueue] = useState<QueueEntry[] | null>(null);
  const [pos, setPos] = useState(0);
  const [label, setLabel] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(() => Math.floor(Date.now() / 1000));
  const [deadline, setDeadline] = useState<number | null>(null);

  const begin = (entries: QueueEntry[], l: string | null) => {
    setQueue(entries);
    setPos(0);
    setLabel(l);
    setStartedAt(Math.floor(Date.now() / 1000));
    setDeadline(null);
  };

  /** Load today's queue. Returns a message when auto-postpone ran. */
  const load = useCallback(async () => {
    const res = await api.getQueue();
    begin(res.entries, null);
    const p = res.auto_postponed;
    return p && (p.items || p.topics) ? `Overload: auto-postponed ${p.items} items and ${p.topics} topics` : null;
  }, []);

  const startSubset = useCallback((l: string, entries: QueueEntry[]) => begin(entries, l), []);

  const advance = useCallback(
    (requeue: boolean) => {
      // "Later today" and "Again" go to the end of this session's queue.
      setQueue((q) => (q && requeue && q[pos] ? [...q, q[pos]] : q));
      setPos((p) => p + 1);
    },
    [pos],
  );

  const move = useCallback((from: number, to: number) => {
    setQueue((q) => {
      if (!q || from === to) return q;
      const next = [...q];
      const [e] = next.splice(from, 1);
      next.splice(to, 0, e);
      return next;
    });
  }, []);
  const removeAt = useCallback((i: number) => setQueue((q) => (q ? q.filter((_, j) => j !== i) : q)), []);
  const deferAt = useCallback((i: number) => setQueue((q) => (q ? [...q.filter((_, j) => j !== i), q[i]] : q)), []);

  const timebox = useCallback(
    (minutes: number) => {
      if (!queue) return 0;
      const rest = queue.slice(pos);
      // Most important first until the time is used; keep the queue's order among those chosen.
      const chosen = new Set<QueueEntry>();
      let used = 0;
      for (const e of [...rest].sort((a, b) => a.priority - b.priority)) {
        const cost = MINUTES[e.kind];
        if (used + cost > minutes && chosen.size > 0) continue;
        chosen.add(e);
        used += cost;
      }
      setQueue([...queue.slice(0, pos), ...rest.filter((e) => chosen.has(e))]);
      setDeadline(Date.now() + minutes * 60_000);
      return chosen.size;
    },
    [pos, queue],
  );

  const endNow = useCallback(() => {
    setPos((p) => Math.max(p, queue?.length ?? 0));
    setDeadline(null);
  }, [queue]);

  return { queue, pos, label, startedAt, deadline, load, startSubset, advance, move, removeAt, deferAt, timebox, endNow };
}

interface Props {
  session: LearnSession;
  notify: Notify;
  onOpen: (id: number) => void;
  onChanged: () => void;
  onReviewBranch: (id: number) => void;
  /** Open Tools on the Postpone & Mercy tab. */
  onOverload: () => void;
}

function Countdown({ deadline, onEnd }: { deadline: number; onEnd: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const left = Math.max(0, deadline - now);
  if (left === 0)
    return (
      <span className="timebox over">
        Time's up · <a onClick={onEnd}>finish</a>
      </span>
    );
  const m = Math.floor(left / 60000);
  const s = String(Math.floor((left % 60000) / 1000)).padStart(2, "0");
  return <span className="timebox mono">⏱ {m}:{s}</span>;
}

function Summary({ since }: { since: number }) {
  const [s, setS] = useState<SessionSummary | null>(null);
  useEffect(() => {
    api.sessionSummary(since).then(setS).catch(() => setS(null));
  }, [since]);
  if (!s) return null;
  const parts = [
    [s.topics_read, "topics read"],
    [s.items_graded, `items graded${s.items_again ? ` (${s.items_again} forgotten)` : ""}`],
    [s.extracts, "extracts made"],
    [s.items_created, "items created"],
    [s.postponed, "postponed or rescheduled"],
    [s.done, "finished or dismissed"],
  ].filter(([n]) => n) as [number, string][];
  if (!parts.length) return null;
  return (
    <div className="tiles summary">
      {parts.map(([n, what]) => (
        <div className="tile" key={what}>
          <div className="tile-value">{n}</div>
          <div className="tile-label">{what}</div>
        </div>
      ))}
    </div>
  );
}

/** Started topics, to finish deliberately instead of waiting for their next interval. */
function ContinueReading({ onStart }: { onStart: (label: string, entries: QueueEntry[]) => void }) {
  const [list, setList] = useState<Started[]>([]);
  useEffect(() => {
    api.continueReading().then((l) => setList(l ?? [])).catch(() => setList([]));
  }, []);
  if (!list.length) return null;
  const entry = (s: Started): QueueEntry => ({ id: s.id, kind: "topic", title: s.title, priority: s.priority, due_day: s.due_day });
  return (
    <div className="dashboard">
      <h3>
        Continue reading{" "}
        <button className="small-btn" onClick={() => onStart("Continue reading", list.map(entry))}>Read all</button>
      </h3>
      {list.map((s) => (
        <div key={s.id} className="up-row" onClick={() => onStart(`Continue: ${s.title}`, [entry(s)])} title="Read it now">
          <span className={`badge topic band-${bandOf(s.priority).name}`}>{s.kind === "pdf" ? "P" : s.kind === "video" ? "V" : "T"}</span>
          <span className="tree-title">{s.title}</span>
          {s.progress != null && (
            <span className="mini-progress" title={`${Math.round(s.progress * 100)}% read`}>
              <span style={{ width: `${Math.round(s.progress * 100)}%` }} />
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Weekly-ish check: important topics nobody touched for weeks. Still important? */
function PriorityAudit() {
  const [list, setList] = useState<{ id: number; title: string; priority: number }[]>([]);
  useEffect(() => {
    api.priorityAudit().then((l) => setList(l ?? [])).catch(() => setList([]));
  }, []);
  if (!list.length) return null;
  const drop = (id: number) => setList((l) => l.filter((x) => x.id !== id));
  return (
    <div className="dashboard">
      <h3>Still important?</h3>
      <p className="muted small">High-priority topics you haven't read in over 45 days. Keep them at the top of the queue only if they still deserve it.</p>
      {list.map((a) => (
        <div key={a.id} className="up-row">
          <span className="tree-title" title={a.title}>{a.title}</span>
          <span className="muted small mono">{Math.round(a.priority)}%</span>
          <button className="small-btn" onClick={() => api.markAudited(a.id).then(() => drop(a.id))} title="Keep the priority; don't ask for 90 days">Keep</button>
          <button className="small-btn" onClick={() => api.setPriority(a.id, Math.min(100, a.priority + 30)).then(() => api.markAudited(a.id)).then(() => drop(a.id))} title="Move it 30 points down the queue">Lower</button>
          <button className="small-btn" onClick={() => api.dismiss(a.id).then(() => drop(a.id))} title="Stop reading it">Dismiss</button>
        </div>
      ))}
    </div>
  );
}

/** Today at a glance, shown when the queue is empty: what's coming and what's slipping. */
function Dashboard() {
  const [s, setS] = useState<FullStats | null>(null);
  useEffect(() => {
    api.fullStats().then(setS).catch(() => setS(null));
  }, []);
  if (!s) return null;
  const week = s.forecast_items.slice(1, 8).map((n, i) => n + s.forecast_topics[i + 1]);
  const max = Math.max(1, ...week);
  const slipping = s.protection.slice(0, 2).filter((b) => b.overdue > 0);
  return (
    <div className="dashboard">
      <h3>Next 7 days</h3>
      <div className="week">
        {week.map((n, i) => (
          <div key={i} className="week-day" title={`in ${i + 1}d: ${n}`}>
            <div className="week-bar" style={{ height: `${(n / max) * 100}%` }} />
            <span className="small muted">{n}</span>
          </div>
        ))}
      </div>
      {slipping.length > 0 ? (
        <p className="warn-text small">
          You're behind on top-priority material:{" "}
          {slipping.map((b) => `${b.overdue} of ${b.total} in the ${b.label} band overdue`).join("; ")}.
        </p>
      ) : (
        <p className="muted small">Priority protection: the top bands are on time.</p>
      )}
      {s.true_retention != null && (
        <p className="muted small">
          Retention over 30 days: {(s.true_retention * 100).toFixed(1)}% ({s.mature_reviews} mature reviews).
        </p>
      )}
    </div>
  );
}

/** Peek at what's next: skip, defer to the end, or reorder by dragging. */
function UpNext({ session, onClose }: { session: LearnSession; onClose: () => void }) {
  const { queue, pos, move, removeAt, deferAt } = session;
  const [drag, setDrag] = useState<number | null>(null);
  if (!queue) return null;
  const rows = queue.slice(pos + 1, pos + 11).map((e, k) => ({ e, i: pos + 1 + k }));
  return (
    <aside className="up-next">
      <div className="row">
        <strong>Up next</strong>
        <span className="muted small">{queue.length - pos - 1} after this</span>
        <span className="spacer" />
        <button className="small-btn" onClick={onClose}>×</button>
      </div>
      {rows.length === 0 && <p className="muted small">Nothing after this one.</p>}
      {rows.map(({ e, i }) => (
        <div
          key={`${e.id}-${i}`}
          className={`up-row ${drag === i ? "dragging" : ""}`}
          draggable
          onDragStart={() => setDrag(i)}
          onDragOver={(ev) => ev.preventDefault()}
          onDrop={() => (drag != null && move(drag, i), setDrag(null))}
          onDragEnd={() => setDrag(null)}
        >
          <span className={`badge ${e.kind} band-${bandOf(e.priority).name}`}>{e.kind === "topic" ? "T" : "Q"}</span>
          <span className="tree-title" title={e.title}>{e.title}</span>
          <button className="small-btn" title="Move up" disabled={i === pos + 1} onClick={() => move(i, i - 1)}>↑</button>
          <button className="small-btn" title="Later in this session" onClick={() => deferAt(i)}>⤓</button>
          <button className="small-btn" title="Skip: drop from this session (it stays due)" onClick={() => removeAt(i)}>✕</button>
        </div>
      ))}
    </aside>
  );
}

/** Walk the session queue, one element at a time. */
export function LearnView({ session, notify, onOpen, onChanged, onReviewBranch, onOverload }: Props) {
  const { queue, pos, label, load, advance } = session;
  const [current, setCurrent] = useState<ElementFull | null>(null);
  const [peekOpen, setPeekOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [bannerHidden, setBannerHidden] = useState(false);

  useEffect(() => {
    if (queue == null) void load().then((m) => m && notify(m));
  }, [queue, load, notify]);
  useEffect(() => {
    api.getSettings().then(setSettings).catch(() => setSettings(null));
  }, []);

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

  const askTimebox = () => {
    const v = window.prompt("How many minutes do you have?", "20");
    const m = v == null ? NaN : Number(v);
    if (!(m > 0)) return;
    const n = session.timebox(m);
    notify(`Time box: the ${n} most important elements that fit in ${m} min`);
  };

  if (queue == null) return <p className="muted pad">Loading…</p>;
  if (!entry)
    return (
      <div className="empty">
        <h2>{label ? `Finished: ${label}` : "Nothing left for today"}</h2>
        <p className="muted">
          {queue.length > 0 ? `You went through ${Math.min(pos, queue.length)} elements.` : "Import something to get started (Ctrl+N)."}
        </p>
        <Summary since={session.startedAt} />
        <button onClick={() => load().then((m) => m && notify(m))}>{label ? "Back to today's queue" : "Reload queue"}</button>
        {!label && <ContinueReading onStart={session.startSubset} />}
        {!label && <PriorityAudit />}
        {!label && <Dashboard />}
      </div>
    );

  const remaining = queue.length - pos;
  const budget = settings ? settings.item_budget + settings.topic_budget : Infinity;
  const overloaded = !label && !bannerHidden && remaining > 2 * budget;
  const minutesLeft = Math.round(queue.slice(pos).reduce((m, e) => m + MINUTES[e.kind], 0));

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
          {session.deadline && <Countdown deadline={session.deadline} onEnd={session.endNow} />}
          {!session.deadline && <a onClick={askTimebox} title="Fit the most important material into the time you have">⏱ time box</a>}
          {" · "}
          <a onClick={() => setPeekOpen((o) => !o)} title="See what's next; skip, defer or reorder">up next</a>
          {" · "}
          {pos + 1} / {queue.length} · ~{minutesLeft} min
        </span>
      </div>
      {overloaded && (
        <div className="status-banner overload">
          <span>
            {remaining} elements due, more than twice your daily budget ({budget}). Spread them out or postpone the least important.
          </span>
          <button onClick={onOverload}>Mercy / Postpone…</button>
          <button onClick={askTimebox}>Time box</button>
          <button className="small-btn" onClick={() => setBannerHidden(true)}>×</button>
        </div>
      )}
      <div className="learn-body">
        <div className="learn-main">
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
        {peekOpen && <UpNext session={session} onClose={() => setPeekOpen(false)} />}
      </div>
    </div>
  );
}

