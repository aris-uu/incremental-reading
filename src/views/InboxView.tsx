import { useCallback, useEffect, useState } from "react";
import type { Notify } from "../notify";
import { api, type InboxEntry } from "../api";

interface Props {
  version: number;
  notify: Notify;
  onChanged: () => void;
  onOpen: (id: number) => void;
}

/**
 * Triage: new imports wait here until they get a priority. Only accepted
 * material enters the queue, so the backlog can't silently grow.
 */
export function InboxView({ version, notify, onChanged, onOpen }: Props) {
  const [entries, setEntries] = useState<InboxEntry[] | null>(null);
  const [prio, setPrio] = useState<Record<number, number>>({});
  const [anchors, setAnchors] = useState<{ id: number; title: string; priority: number }[]>([]);
  useEffect(() => {
    api.priorityAnchors().then(setAnchors);
  }, [version]);

  useEffect(() => {
    api.getInbox().then((list) => {
      setEntries(list);
      setPrio((p) => Object.fromEntries(list.map((e) => [e.id, p[e.id] ?? e.priority])));
    });
  }, [version]);

  const accept = useCallback(
    async (e: InboxEntry, at?: number) => {
      await api.accept(e.id, at ?? prio[e.id] ?? e.priority);
      notify(`Accepted “${e.title}” — due today`, { undo: true });
      onChanged();
    },
    [notify, onChanged, prio],
  );

  const discard = useCallback(
    async (e: InboxEntry) => {
      if (!window.confirm(`Discard “${e.title}”? It will be deleted.`)) return;
      await api.deleteElement(e.id);
      notify(`Discarded “${e.title}”`, { undo: true });
      onChanged();
    },
    [notify, onChanged],
  );

  if (!entries) return <p className="muted pad">Loading…</p>;
  return (
    <div className="inbox">
      <h2>Inbox</h2>
      <p className="muted small">
        Give each import a priority (0 = most important) and accept it into the queue, or discard it. Open one to skim it first.
      </p>
      {entries.length === 0 && <p className="muted">The inbox is empty.</p>}
      {entries.map((e) => (
        <div key={e.id} className="inbox-row">
          <div className="inbox-main">
            <a className="inbox-title" onClick={() => onOpen(e.id)}>{e.title}</a>
            <div className="muted small">
              {e.site || (e.url ? safeHost(e.url) : "pasted")} · ~{Math.max(1, Math.round(e.chars / 6 / 230))} min read ·{" "}
              {new Date(e.created_at * 1000).toLocaleDateString()}
            </div>
          </div>
          <label className="priority">
            <input
              type="range"
              min={0}
              max={100}
              value={prio[e.id] ?? e.priority}
              onChange={(ev) => setPrio((p) => ({ ...p, [e.id]: Number(ev.target.value) }))}
            />
            <span className="mono">{Math.round(prio[e.id] ?? e.priority)}%</span>
          </label>
          <button className="primary" onClick={() => accept(e)}>Accept</button>
          <button className="danger" onClick={() => discard(e)}>Discard</button>
          {anchors.length > 1 && (
            <div className="compare small">
              <span className="muted">More important than…</span>
              {anchors.map((a) => (
                <button key={a.id} className="chip-btn" title={`Accept just ahead of “${a.title}” (${Math.round(a.priority)}%)`} onClick={() => accept(e, a.priority)}>
                  {a.title.length > 28 ? `${a.title.slice(0, 27)}…` : a.title}
                </button>
              ))}
              <button className="chip-btn" title="Least important: the end of the queue" onClick={() => accept(e, 100)}>
                none of these
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function safeHost(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
